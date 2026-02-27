import { PhysicsNode } from '../physics/PhysicsNode';
import { Spring } from '../physics/Spring';
import { Vec3 } from '../physics/Vec3';
import { Genome, SENSOR_COUNT, WALL_SENSE_RADIUS, FOOD_DISTANCE_SCALE } from './Genome';
import { Heightfield } from '../world/Heightfield';

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

export class Agent {
  readonly id: number;
  nodes: PhysicsNode[];
  springs: Spring[];
  muscles: Spring[];

  energy: number = 120;
  age: number = 0;
  phase: number;
  dead: boolean = false;

  readonly generation: number;
  readonly parentId: number | null;
  readonly hue: number;

  readonly birthTime: number;
  totalDistanceTravelled: number = 0;
  private _lastCenterXZ: { x: number; z: number } = { x: 0, z: 0 };

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
   * Build the 14-element sensor input vector.
   * Slot layout is defined in Genome.ts — this method is the single place where
   * world-state queries are assembled into that layout.
   *
   * Slots 0–11: world-state inputs (unchanged from prior layout).
   * Slots 12–13: proprioceptive inputs (Proposal #43, Lever D).
   */
  private _sense(
    zones: EnergyZone[],
    worldWidth: number,
    worldDepth: number,
    heightfield: Heightfield,
    allAgents: Agent[],
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
    // Mean absolute deviation of actuated spring lengths from their rest lengths,
    // expressed as a fraction of rest length, then tanh-scaled.
    //
    // Tells the brain how "activated" the body currently is — high values mean
    // muscles are strongly contracted or extended relative to their natural state.
    // Without this, all rhythm information comes from the global oscillator only.
    //
    // Normalization: tanh(meanFractionalDeviation × 3).
    //   At 3× scale, a 30% mean deviation → tanh(0.9) ≈ 0.72 — well within range.
    //   A 10% deviation → tanh(0.3) ≈ 0.29 — still clearly non-zero.
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
    // Fraction of this agent's nodes that are currently in contact with terrain.
    //
    // A node is considered "grounded" when its Y position is within half a
    // radius of the terrain surface below it (the constraint in PhysicsNode
    // ensures pos.y >= groundY + radius, so a touching node sits right at that
    // boundary with only numerical slack above it).
    //
    // Normalization: groundContactNodes / totalNodes — already in [0, 1].
    let groundContactCount = 0;
    for (const n of this.nodes) {
      const groundY = heightfield.heightAt(n.pos.x, n.pos.z);
      // Tolerance of half a radius handles the one-frame Verlet overshoot
      if (n.pos.y <= groundY + n.radius + n.radius * 0.5) {
        groundContactCount++;
      }
    }
    const groundContactFraction = this.nodes.length > 0
      ? groundContactCount / this.nodes.length
      : 0;

    // ── Terrain sensing ───────────────────────────────────────────────────────
    // Slope ahead: compare terrain height at (pos + velocity*25) vs current pos.
    // Positive = heading uphill, negative = heading downhill.
    // Velocity direction is normalised by speed to give a consistent lookahead.
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

    // Current terrain elevation: how high the ground is at the agent's position,
    // normalised by the maximum possible terrain height.
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

    // ── Assemble input vector (must match SENSOR_COUNT = 19) ─────────────────
    // Slot indices are the authoritative layout — see Genome.ts for the table.
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
  ): void {
    this.age += dt;
    this.phase += dt * (2.5 + Math.sin(this.phase * 0.3) * 0.5);

    // Brain → muscle activations
    const inputs = this._sense(zones, worldWidth, worldDepth, heightfield, allAgents);
    const outputs = this.genome.brain.forward(inputs);
    for (let i = 0; i < this.muscles.length; i++) {
      this.muscles[i].activation = outputs[i % outputs.length];
    }

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

    // Fall death: if any node struck terrain with enough downward speed, the
    // agent dies from the impact.  Threshold calibration (at 60 fps):
    //   acc_per_frame = G × dt² = 600 / 3600 ≈ 0.167 vel-units added/frame
    //   impact speed after falling H units ≈ 0.578 × √H
    //   H = 40  → ~3.7 units/frame  (lethal at threshold 3.5)
    //   H = 25  → ~2.9 units/frame  (safe at threshold 3.5)
    //   H = 60  → ~4.5 units/frame  (lethal)
    // With terrain amplitude 60, this means falls from significant terrain
    // features are lethal while small hops during locomotion are safe.
    const FALL_DEATH_VEL = 3.5;
    for (const n of this.nodes) {
      if (n.landingVel > FALL_DEATH_VEL) {
        this.dead = true;
        break;
      }
    }

    // Energy accounting
    this.energy -= energyCost;
    this.energy -= (0.6 + this.nodes.length * 0.15) * dt;

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
    // Threshold lowered 160 → 130 so mobile agents that reach a food patch
    // can reproduce without needing to sit and hoard.  Reproduction costs 80
    // energy, leaving the parent with ~50 — below starvation threshold but
    // survivable if they quickly find more food.
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
    };
  }
}

// Sanity-check: _sense() return length must equal SENSOR_COUNT
const _check: number = SENSOR_COUNT;
void _check;