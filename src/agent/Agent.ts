import { PhysicsNode } from '../physics/PhysicsNode';
import { Spring } from '../physics/Spring';
import { Vec3 } from '../physics/Vec3';
import { Genome, SENSOR_COUNT } from './Genome';

let nextId = 0;

export interface EnergyZone {
  x: number;
  y: number;  // world Y (typically 0 for ground-level zones)
  z: number;
  radius: number;
  energy: number;
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
    spawnY: number,  // height above ground for spawn (usually 0)
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

    // Normalise: shift all nodes so the lowest point sits exactly at radius
    // (just touching the ground plane at Y=0)
    const lowestY = Math.min(...physNodes.map(n => n.pos.y - n.radius));
    const shift = -lowestY; // push up so lowest point = 0
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

  private _sense(zones: EnergyZone[]): number[] {
    const c = this.centerPos;

    // Nearest energy zone direction (XZ plane distance matters most)
    let nearestDx = 0, nearestDy = 0, nearestDz = 0, nearestDist = 3000;
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
      }
    }
    const dirScale = 1 / (nearestDist + 1);

    // Own average X-velocity
    let velX = 0;
    for (const n of this.nodes) velX += n.vel.x;
    velX /= this.nodes.length;

    return [
      Math.min(1, this.energy / 250),               // 0: energy [0,1]
      Math.tanh(nearestDx * dirScale * 5),           // 1: food X
      Math.tanh(nearestDy * dirScale * 5),           // 2: food Y
      Math.tanh(nearestDz * dirScale * 5),           // 3: food Z
      Math.tanh(velX * 10),                          // 4: own vel X
      Math.sin(this.phase),                          // 5: oscillator sin
      Math.cos(this.phase),                          // 6: oscillator cos
    ];
  }

  // ── Update ───────────────────────────────────────────────────────────────────

  update(
    dt: number,
    zones: EnergyZone[],
    worldWidth: number,
    worldDepth: number,
  ): void {
    this.age += dt;
    this.phase += dt * (2.5 + Math.sin(this.phase * 0.3) * 0.5);

    // Brain → muscle activations
    const inputs = this._sense(zones);
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
      n.constrainToGround(0.35, 0.15);
      n.constrainToWorldBounds(0, worldWidth, 0, worldDepth);
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
    return this.energy > 160 && this.age > 3;
  }

  reproduce(): Agent {
    this.energy -= 80;
    const c = this.centerPos;
    return new Agent(
      this.genome.mutate(),
      c.x + (Math.random() - 0.5) * 30,
      c.y,
      c.z + (Math.random() - 0.5) * 30,
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

// Sanity-check sensor count constant
const _check: number = SENSOR_COUNT;
void _check;
