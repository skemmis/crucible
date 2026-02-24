import { PhysicsNode } from './PhysicsNode';

export class Spring {
  restLength: number;
  currentLength: number = 0;
  /** Muscle activation in [-1, 1]: positive extends, negative contracts. */
  activation: number = 0;

  constructor(
    public nodeA: PhysicsNode,
    public nodeB: PhysicsNode,
    public stiffness: number,
    public damping: number,
    restLength?: number,
    public isActuated: boolean = false,
    /** Max fractional change in rest length from activation. */
    public contractionRatio: number = 0.3,
  ) {
    const d = nodeB.pos.sub(nodeA.pos);
    this.restLength = restLength ?? d.length();
  }

  /**
   * Apply Hooke's law + velocity damping along the spring axis.
   * onEnergyCost: callback so the owning agent can deduct energy.
   */
  applyForces(onEnergyCost: (amount: number) => void): void {
    const dx = this.nodeB.pos.x - this.nodeA.pos.x;
    const dy = this.nodeB.pos.y - this.nodeA.pos.y;
    const dz = this.nodeB.pos.z - this.nodeA.pos.z;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    this.currentLength = len;
    if (len < 1e-6) return;

    const invLen = 1 / len;
    const nx = dx * invLen;
    const ny = dy * invLen;
    const nz = dz * invLen;

    // Effective rest length with muscle actuation
    let effectiveRest = this.restLength;
    if (this.isActuated) {
      effectiveRest = this.restLength * (1 + this.activation * this.contractionRatio);
      const effort = Math.abs(this.activation) * (Math.abs(len - effectiveRest) + 0.5);
      onEnergyCost(effort * 0.0004);
    }

    // Spring force (Hooke)
    const springF = (len - effectiveRest) * this.stiffness;

    // Damping: project relative velocity onto spring axis
    const velAx = this.nodeA.vel.x, velAy = this.nodeA.vel.y, velAz = this.nodeA.vel.z;
    const velBx = this.nodeB.vel.x, velBy = this.nodeB.vel.y, velBz = this.nodeB.vel.z;
    const relVel = (velBx - velAx) * nx + (velBy - velAy) * ny + (velBz - velAz) * nz;
    const dampF = relVel * this.damping;

    const totalF = springF + dampF;
    const fx = nx * totalF;
    const fy = ny * totalF;
    const fz = nz * totalF;

    this.nodeA.acc.x += fx / this.nodeA.mass;
    this.nodeA.acc.y += fy / this.nodeA.mass;
    this.nodeA.acc.z += fz / this.nodeA.mass;
    this.nodeB.acc.x -= fx / this.nodeB.mass;
    this.nodeB.acc.y -= fy / this.nodeB.mass;
    this.nodeB.acc.z -= fz / this.nodeB.mass;
  }
}
