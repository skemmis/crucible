import { PhysicsNode } from '../physics/PhysicsNode';
import { Spring } from '../physics/Spring';
import { Genome, SENSOR_COUNT } from './Genome';
import { Vec2 } from '../physics/Vec2';

let nextId = 0;

export interface EnergyZone {
  x: number;
  y: number;
  radius: number;
  energy: number;
}

// Palette of hues — child agents inherit parent hue with slight drift
function hueFromGeneration(baseHue: number): number {
  return (baseHue + (Math.random() - 0.5) * 30 + 360) % 360;
}

export class Agent {
  readonly id: number;
  nodes: PhysicsNode[];
  springs: Spring[];
  muscles: Spring[];

  energy: number = 120;
  age: number = 0;        // seconds
  phase: number;
  dead: boolean = false;

  readonly generation: number;
  readonly parentId: number | null;
  readonly hue: number;

  // Tracking for phylogeny / stats
  readonly birthTime: number;
  totalDistanceTravelled: number = 0;
  private _lastCenterX: number = 0;

  constructor(
    readonly genome: Genome,
    spawnX: number,
    spawnY: number,
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

    // ── Develop body from genome ─────────────────────────────────────────────
    const { nodes, springs } = this._develop(spawnX, spawnY);
    this.nodes = nodes;
    this.springs = springs;
    this.muscles = springs.filter(s => s.isActuated);
    this._lastCenterX = this.centerPos.x;
  }

  // ── Development ─────────────────────────────────────────────────────────────

  private _develop(spawnX: number, spawnY: number): { nodes: PhysicsNode[], springs: Spring[] } {
    const g = this.genome;

    // Create nodes with relative offsets
    const physNodes = g.nodes.map(n =>
      new PhysicsNode(spawnX + n.dx, spawnY + n.dy, n.mass, n.radius),
    );

    // Normalise: shift all nodes so lowest point sits exactly at spawnY
    const lowestY = Math.max(...physNodes.map(n => n.pos.y + n.radius));
    const shift = spawnY - lowestY;
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
      physSprings.push(new Spring(na, nb, sg.stiffness, sg.damping, rest, sg.isActuated, sg.contractionRatio));
    }

    return { nodes: physNodes, springs: physSprings };
  }

  // ── Queries ─────────────────────────────────────────────────────────────────

  get centerPos(): Vec2 {
    if (this.nodes.length === 0) return new Vec2(0, 0);
    let sx = 0, sy = 0;
    for (const n of this.nodes) { sx += n.pos.x; sy += n.pos.y; }
    return new Vec2(sx / this.nodes.length, sy / this.nodes.length);
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

  // ── Sensing ─────────────────────────────────────────────────────────────────

  private _sense(zones: EnergyZone[]): number[] {
    const c = this.centerPos;

    // Nearest energy zone direction
    let nearestDx = 0, nearestDy = 0, nearestDist = 2000;
    for (const z of zones) {
      const dx = z.x - c.x;
      const dy = z.y - c.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < nearestDist) {
        nearestDist = d;
        nearestDx = dx;
        nearestDy = dy;
      }
    }
    const dirScale = 1 / (nearestDist + 1);

    // Own horizontal velocity (normalised)
    let velX = 0;
    for (const n of this.nodes) velX += n.vel.x;
    velX /= this.nodes.length;

    return [
      Math.min(1, this.energy / 250),            // 0: hunger [0,1]
      Math.tanh(nearestDx * dirScale * 5),         // 1: food left/right
      Math.tanh(nearestDy * dirScale * 5),         // 2: food up/down
      Math.tanh(velX * 10),                        // 3: own velocity
      Math.sin(this.phase),                        // 4: oscillator sin
      Math.cos(this.phase),                        // 5: oscillator cos
    ];
  }

  // ── Update ──────────────────────────────────────────────────────────────────

  update(dt: number, zones: EnergyZone[], groundY: number, worldWidth: number): void {
    this.age += dt;
    this.phase += dt * (2.5 + Math.sin(this.phase * 0.3) * 0.5); // slightly irregular oscillator

    // Brain → muscle activations
    const inputs = this._sense(zones);
    const outputs = this.genome.brain.forward(inputs);
    for (let i = 0; i < this.muscles.length; i++) {
      this.muscles[i].activation = outputs[i % outputs.length];
    }

    // Spring forces (including muscle energy cost)
    let energyCost = 0;
    for (const s of this.springs) {
      s.applyForces(cost => { energyCost += cost; });
    }

    // Gravity
    const G = 600; // pixels/s²
    for (const n of this.nodes) {
      n.acc.y += G; // Verlet: acc will be multiplied by dt² in integrate
    }

    // Integrate + constrain
    for (const n of this.nodes) {
      n.integrate(dt);
      n.constrainToGround(groundY, 0.35, 0.15);
      n.constrainToWidth(0, worldWidth);
    }

    // Energy accounting
    this.energy -= energyCost;
    // Existence cost scales with body size: bigger bodies burn more
    this.energy -= (0.6 + this.nodes.length * 0.15) * dt;

    // Track movement
    const cx = this.centerPos.x;
    this.totalDistanceTravelled += Math.abs(cx - this._lastCenterX);
    this._lastCenterX = cx;

    if (this.energy <= 0) this.dead = true;
  }

  absorbEnergy(amount: number): void {
    this.energy = Math.min(300, this.energy + amount);
  }

  canReproduce(): boolean {
    // Lowered threshold so zones don't need to be monopolised to reproduce
    return this.energy > 160 && this.age > 3;
  }

  reproduce(): Agent {
    this.energy -= 80; // cost leaves parent with 80+ energy (still viable)
    const c = this.centerPos;
    const child = new Agent(
      this.genome.mutate(),
      c.x + (Math.random() - 0.5) * 30,
      c.y,
      this.generation + 1,
      this.id,
      this.hue,
    );
    return child;
  }

  /** Summarise for the inspector panel. */
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
