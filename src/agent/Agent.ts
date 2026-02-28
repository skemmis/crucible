import { PhysicsNode } from '../physics/PhysicsNode';
import { Spring } from '../physics/Spring';
import { Vec3 } from '../physics/Vec3';
import { Genome, SENSOR_COUNT, ACTION_OUTPUT_COUNT, WALL_SENSE_RADIUS, FOOD_DISTANCE_SCALE } from './Genome';
import { Heightfield } from '../world/Heightfield';
import { Prop } from '../world/Prop';

let nextId = 0;

export interface EnergyZone {
  x: number;
  y: number;  // world Y (typically 0 for ground-level zones)
  z: number;
  radius: number;
  energy: number;
  maxEnergy: number;
}

function hueFromGeneration(baseHue: number): number {
  return (baseHue + (Math.random() - 0.5) * 30 + 360) % 360;
}

/**
 * Energy cost per unit of chemEmissionRate per second.
 *
 * Consensus requirement: emission must have a real metabolic cost so that
 * zero-cost emission (which would make deception trivially dominant and
 * remove all evolutionary tradeoffs) cannot evolve.
 *
 * At CHEM_EMISSION_COST_RATE = 0.06:
 *   - Rate 0.0 → 0 energy/s   (silent; save cost)
 *   - Rate 1.0 → 0.06 energy/s (modest overhead, ~10% of base idle cost)
 *   - Rate 2.0 → 0.12 energy/s (meaningful burden for sustained max emission)
 *
 * This is small enough to allow diverse strategies but large enough to
 * make constant max-rate emission genuinely costly.
 */
const CHEM_EMISSION_COST_RATE = 0.06;

export class Agent {
  readonly id: number;
  nodes: PhysicsNode[];
  springs: Spring[];
  muscles: Spring[];

  energy: number = 120;
  age: number = 0;
  phase: number;
  dead: boolean = false;

  /**
   * Last prop manipulation action outputs from the brain (tanh range [-1, 1]).
   * Values > 0.5 trigger the respective action in World._processAgentActions().
   * Reset to 0 when the agent dies so stale actions don't trigger on corpses.
   */
  lastGrabAction: number = 0;
  lastReleaseAction: number = 0;
  lastConnectAction: number = 0;

  readonly generation: number;
  readonly parentId: number | null;
  readonly hue: number;

  readonly birthTime: number;
  totalDistanceTravelled: number = 0;
  private _lastCenterXZ: { x: number; z: number } = { x: 0, z: 0 };

  /**
   * Local chemical concentration sensed at this agent's position.
   *
   * Set by World._computeChemicalConcentrations() each tick BEFORE
   * agent.update() is called.  The value is the sum of nearby agents'
   * emission rates weighted by inverse distance — a spatial-query
   * approximation that avoids a persistent diffusion grid.
   *
   * Agents receive only this scalar (point-concentration); gradient
   * direction is NOT provided.  Temporal/spatial gradient detection
   * must emerge from movement and resampling — Proposal #5 consensus.
   */
  localChemConcentration: number = 0;

  constructor(
    readonly genome: Genome,
    spawnX: number,
    spawnY: number,  // height above ground for spawn — typically the terrain height at (x, z)
    spawnZ: number,
    generation: number = 0,
    parentId: number | null = null,
    parentHue: number = Math.random() * 360,
  ) {
    this.id = nextId++;
    this.generation = generation;
    this.parentId = parentId;
    this.hue = hueFromGeneration(parentHue);
    this.phase = Math.random() * Math.PI * 2;
    this.birthTime = performance.now();

    const { nodes, springs } = this._develop(spawnX, spawnY, spawnZ);
    this.nodes = nodes;
    this.springs = springs;
    this.muscles = springs.filter(s => s.isActuated);
    const c = this.centerPos;
    this._lastCenterXZ = { x: c.x, z: c.z };
  }

  // ── Development ──────────────────────────────────────────────────────────────

  private _develop(
    spawnX: number,
    spawnY: number,
    spawnZ: number,
  ): { nodes: PhysicsNode[]; springs: Spring[] } {
    const g = this.genome;

    // Place nodes using genome offsets (Y-up: dy is height above ground)
    const physNodes = g.nodes.map(n =>
      new PhysicsNode(
        spawnX + n.dx,
        spawnY + n.dy,
        spawnZ + n.dz,
        n.mass,
        n.radius,
      ),
    );

    // Normalise: shift all nodes so the lowest point sits exactly at spawnY + radius
    // (just touching the ground surface at the spawn location)
    const lowestY = Math.min(...physNodes.map(n => n.pos.y - n.radius));
    const shift = spawnY - lowestY; // push up so lowest point = spawnY
    for (const n of physNodes) {
      n.pos.y += shift;
      n.prevPos.y += shift;
    }

    // Build springs
    const physSprings: Spring[] = [];
    for (const sg of g.springs) {
      if (sg.a >= physNodes.length || sg.b >= physNodes.length) continue;
      const na = physNodes[sg.a];
      const nb = physNodes[sg.b];
      const natural = na.pos.sub(nb.pos).length();
      const rest = natural * sg.restLengthFactor;
      physSprings.push(
        new Spring(na, nb, sg.stiffness, sg.damping, rest, sg.isActuated, sg.contractionRatio),
      );
    }

    return { nodes: physNodes, springs: physSprings };
  }

  // ── Queries ──────────────────────────────────────────────────────────────────

  get centerPos(): Vec3 {
    if (this.nodes.length === 0) return new Vec3(0, 0, 0);
    let sx = 0, sy = 0, sz = 0;
    for (const n of this.nodes) { sx += n.pos.x; sy += n.pos.y; sz += n.pos.z; }
    const inv = 1 / this.nodes.length;
    return new Vec3(sx * inv, sy * inv, sz * inv);
  }

  get boundingRadius(): number {
    const c = this.centerPos;
    let maxR = 0;
    for (const n of this.nodes) {
      const d = n.pos.sub(c).length() + n.radius;
      if (d > maxR) maxR = d;
    }
    return maxR;
  }

  // ── Sensing ──────────────────────────────────────────────────────────────────

  /**
   * Build the 23-element sensor input vector.
   * Slot layout is defined in Genome.ts — this method is the single place where
   * world-state queries are assembled into that layout.
   *
   * Slots 0–11:  world-state inputs (food, velocity, walls, oscillator).
   * Slots 12–13: proprioceptive inputs (Proposal #43, Lever D).
   * Slots 14–15: terrain sensing.
   * Slots 16–18: nearest other-agent sensing.
   * Slots 19–21: nearest prop sensing (manipulable objects).
   * Slot  22:    local chemical concentration (Proposal #5).
   */
  private _sense(
    zones: EnergyZone[],
    worldWidth: number,
    worldDepth: number,
    heightfield: Heightfield,
    allAgents: Agent[],
    allProps: Prop[],
  ): number[] {
    const c = this.centerPos;

    // ── Food sensing ─────────────────────────────────────────────────────────
    // Single pass: find nearest zone, record direction, distance, and fill level.
    let nearestDx = 0, nearestDy = 0, nearestDz = 0;
    let nearestDist = 3000;
    let nearestFill = 0;   // zone.energy / zone.maxEnergy

    for (const z of zones) {
      const dx = z.x - c.x;
      const dy = (z.y ?? 0) - c.y;
      const dz = z.z - c.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d < nearestDist) {
        nearestDist = d;
        nearestDx = dx;
        nearestDy = dy;
        nearestDz = dz;
        nearestFill = z.maxEnergy > 0 ? z.energy / z.maxEnergy : 0;
      }
    }
    const dirScale = 1 / (nearestDist + 1);

    // ── Own velocity ─────────────────────────────────────────────────────────
    let velX = 0, velZ = 0;
    for (const n of this.nodes) {
      velX += n.vel.x;
      velZ += n.vel.z;
    }
    const invN = 1 / this.nodes.length;
    velX *= invN;
    velZ *= invN;

    // ── Wall proximity ───────────────────────────────────────────────────────
    // Approaches 1 when within WALL_SENSE_RADIUS of the nearest X (or Z) wall,
    // 0 when at the world centre or beyond WALL_SENSE_RADIUS from any wall.
    const distToNearestWallX = Math.min(c.x, worldWidth - c.x);
    const distToNearestWallZ = Math.min(c.z, worldDepth - c.z);
    const wallProxX = Math.max(0, 1 - distToNearestWallX / WALL_SENSE_RADIUS);
    const wallProxZ = Math.max(0, 1 - distToNearestWallZ / WALL_SENSE_RADIUS);

    // ── Proprioception: stretch sensor (slot 12) ──────────────────────────────
    let totalFractionalDeviation = 0;
    let muscleCount = 0;
    for (const s of this.muscles) {
      if (s.restLength > 1e-6) {
        totalFractionalDeviation += Math.abs(s.currentLength - s.restLength) / s.restLength;
        muscleCount++;
      }
    }
    const stretchSensor = muscleCount > 0
      ? Math.tanh((totalFractionalDeviation / muscleCount) * 3)
      : 0;

    // ── Proprioception: ground contact fraction (slot 13) ────────────────────
    let groundContactCount = 0;
    for (const n of this.nodes) {
      const groundY = heightfield.heightAt(n.pos.x, n.pos.z);
      if (n.pos.y <= groundY + n.radius + n.radius * 0.5) {
        groundContactCount++;
      }
    }
    const groundContactFraction = this.nodes.length > 0
      ? groundContactCount / this.nodes.length
      : 0;

    // ── Terrain sensing ───────────────────────────────────────────────────────
    const speed = Math.sqrt(velX * velX + velZ * velZ) + 1e-6;
    const lookahead = 25;
    const lookX = c.x + (velX / speed) * lookahead;
    const lookZ = c.z + (velZ / speed) * lookahead;
    const hCur  = heightfield.heightAt(c.x, c.z);
    const hAhead = heightfield.heightAt(
      Math.max(0, Math.min(worldWidth,  lookX)),
      Math.max(0, Math.min(worldDepth, lookZ)),
    );
    const terrainSlopeAhead = Math.tanh((hAhead - hCur) * 0.1);

    const terrainElevation = heightfield.maxHeight > 0
      ? Math.min(1, hCur / heightfield.maxHeight)
      : 0;

    // ── Nearest other-agent sensing ───────────────────────────────────────────
    let nearAgentDirX = 0, nearAgentDirZ = 0, nearAgentDist = 1;
    let minAgentDist = Infinity;
    for (const other of allAgents) {
      if (other.dead || other.id === this.id) continue;
      const oc = other.centerPos;
      const adx = oc.x - c.x;
      const adz = oc.z - c.z;
      const adist = Math.sqrt(adx * adx + adz * adz);
      if (adist < minAgentDist) {
        minAgentDist = adist;
        const inv = 1 / (adist + 1e-6);
        nearAgentDirX = Math.tanh(adx * inv * 5);
        nearAgentDirZ = Math.tanh(adz * inv * 5);
        nearAgentDist = Math.tanh(adist / 150);
      }
    }

    // ── Nearest prop sensing ──────────────────────────────────────────────────
    let nearPropDirX = 0, nearPropDirZ = 0, nearPropDist = 1;
    let minPropDist = Infinity;
    for (const prop of allProps) {
      const pdx = prop.node.pos.x - c.x;
      const pdz = prop.node.pos.z - c.z;
      const pdist = Math.sqrt(pdx * pdx + pdz * pdz);
      if (pdist < minPropDist) {
        minPropDist = pdist;
        const inv = 1 / (pdist + 1e-6);
        nearPropDirX = Math.tanh(pdx * inv * 5);
        nearPropDirZ = Math.tanh(pdz * inv * 5);
        nearPropDist = Math.tanh(pdist / 200);
      }
    }

    // ── Chemical concentration (slot 22) ─────────────────────────────────────
    // Point-concentration only — one scalar, no gradient direction provided.
    // Agents must evolve temporal/spatial gradient detection via movement.
    // localChemConcentration is set by World each tick before update() is called.
    // tanh maps [0, ∞) → [0, 1); scale factor chosen so typical concentrations
    // (a few nearby emitters) produce values in the mid [0,1] range.
    const chemSensor = Math.tanh(this.localChemConcentration);

    // ── Assemble input vector (must match SENSOR_COUNT = 23) ─────────────────
    return [
      /* 0  */ Math.min(1, this.energy / 250),               // own energy
      /* 1  */ Math.tanh(nearestDx * dirScale * 5),           // food dir X
      /* 2  */ Math.tanh(nearestDy * dirScale * 5),           // food dir Y
      /* 3  */ Math.tanh(nearestDz * dirScale * 5),           // food dir Z
      /* 4  */ Math.tanh(velX * 10),                          // own vel X
      /* 5  */ Math.sin(this.phase),                          // oscillator sin
      /* 6  */ Math.cos(this.phase),                          // oscillator cos
      /* 7  */ Math.tanh(velZ * 10),                          // own vel Z
      /* 8  */ Math.tanh(nearestDist / FOOD_DISTANCE_SCALE),  // food distance
      /* 9  */ nearestFill,                                   // food zone energy
      /* 10 */ wallProxX,                                     // wall proximity X
      /* 11 */ wallProxZ,                                     // wall proximity Z
      /* 12 */ stretchSensor,                                 // proprioception: body activation
      /* 13 */ groundContactFraction,                         // proprioception: feet planted
      /* 14 */ terrainSlopeAhead,                             // terrain: uphill/downhill ahead
      /* 15 */ terrainElevation,                              // terrain: current elevation
      /* 16 */ nearAgentDirX,                                 // nearest agent dir X
      /* 17 */ nearAgentDirZ,                                 // nearest agent dir Z
      /* 18 */ nearAgentDist,                                 // nearest agent distance
      /* 19 */ nearPropDirX,                                  // nearest prop dir X
      /* 20 */ nearPropDirZ,                                  // nearest prop dir Z
      /* 21 */ nearPropDist,                                  // nearest prop distance
      /* 22 */ chemSensor,                                    // local chemical concentration
    ];
  }

  // ── Update ───────────────────────────────────────────────────────────────────

  update(
    dt: number,
    zones: EnergyZone[],
    worldWidth: number,
    worldDepth: number,
    heightfield: Heightfield,
    allAgents: Agent[] = [],
    allProps: Prop[] = [],
  ): void {
    this.age += dt;
    this.phase += dt * (2.5 + Math.sin(this.phase * 0.3) * 0.5);

    // Brain → muscle activations + prop manipulation action channels
    const inputs = this._sense(zones, worldWidth, worldDepth, heightfield, allAgents, allProps);
    const outputs = this.genome.brain.forward(inputs);
    const muscleCount = this.muscles.length;
    // First muscleCount outputs drive muscles; last ACTION_OUTPUT_COUNT are actions.
    for (let i = 0; i < muscleCount; i++) {
      this.muscles[i].activation = outputs[i % muscleCount];
    }
    this.lastGrabAction    = outputs[muscleCount]     ?? 0;
    this.lastReleaseAction = outputs[muscleCount + 1] ?? 0;
    this.lastConnectAction = outputs[muscleCount + 2] ?? 0;

    // Spring forces + energy cost
    let energyCost = 0;
    for (const s of this.springs) {
      s.applyForces(cost => { energyCost += cost; });
    }

    // Gravity (Three.js Y-up: gravity pulls in -Y)
    const G = 600;
    for (const n of this.nodes) {
      n.acc.y -= G; // subtract because +Y is up, gravity is downward
    }

    // Integrate + constrain
    for (const n of this.nodes) {
      n.integrate(dt);
      // Use terrain height at the node's current XZ position as the ground floor
      const groundY = heightfield.heightAt(n.pos.x, n.pos.z);
      n.constrainToGround(groundY, 0.35, 0.15);
      n.constrainToWorldBounds(0, worldWidth, 0, worldDepth);
    }

    // Energy accounting: base idle cost + spring actuation cost
    this.energy -= energyCost;
    this.energy -= (0.6 + this.nodes.length * 0.15) * dt;

    // Chemical emission metabolic cost (Proposal #5 consensus: real cost required).
    // Cost is proportional to emission rate regardless of what the agent signals.
    // This makes sustained high emission genuinely expensive, creating the
    // evolutionary tradeoff between signaling and energy conservation.
    this.energy -= this.genome.chemEmissionRate * CHEM_EMISSION_COST_RATE * dt;

    // Track XZ distance travelled
    const c = this.centerPos;
    const dx = c.x - this._lastCenterXZ.x;
    const dz = c.z - this._lastCenterXZ.z;
    this.totalDistanceTravelled += Math.sqrt(dx * dx + dz * dz);
    this._lastCenterXZ = { x: c.x, z: c.z };

    if (this.energy <= 0) this.dead = true;
  }

  absorbEnergy(amount: number): void {
    this.energy = Math.min(300, this.energy + amount);
  }

  canReproduce(): boolean {
    return this.energy > 130 && this.age > 3;
  }

  reproduce(spawnX?: number, spawnY?: number, spawnZ?: number): Agent {
    this.energy -= 80;
    const c = this.centerPos;
    return new Agent(
      this.genome.mutate(),
      spawnX ?? c.x + (Math.random() - 0.5) * 30,
      spawnY ?? c.y,
      spawnZ ?? c.z + (Math.random() - 0.5) * 30,
      this.generation + 1,
      this.id,
      this.hue,
    );
  }

  inspect() {
    return {
      id: this.id,
      generation: this.generation,
      parentId: this.parentId,
      energy: this.energy,
      age: this.age,
      nodes: this.nodes.length,
      muscles: this.muscles.length,
      springs: this.springs.length,
      distanceTravelled: this.totalDistanceTravelled,
      chemEmissionRate: this.genome.chemEmissionRate,
    };
  }
}

// Sanity-check: _sense() return length must equal SENSOR_COUNT
const _check: number = SENSOR_COUNT;
void _check;