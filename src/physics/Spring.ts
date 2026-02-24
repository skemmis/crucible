import { PhysicsNode } from './PhysicsNode';

export class Spring {
  restLength: number;
  currentLength: number = 0;
  /** Muscle activation in [-1, 1]: negative contracts, positive extends. */
  activation: number = 0;

  constructor(
    public nodeA: PhysicsNode,
    public nodeB: PhysicsNode,
    public stiffness: number,
    public damping: number,
    restLength?: number,
    public isActuated: boolean = false,
    /** Max fractional change in rest length from muscle activation. */
    public contractionRatio: number = 0.3,
  ) {
    // Default rest length = current distance between nodes at spawn
    const dx = nodeB.pos.x - nodeA.pos.x;
    const dy = nodeB.pos.y - nodeA.pos.y;
    this.restLength = restLength ?? Math.sqrt(dx * dx + dy * dy);
  }

  /**
   * Apply Hooke's law + velocity damping along the spring axis.
   * onEnergyCost: callback so the owning agent can deduct energy.
   */
  applyForces(onEnergyCost: (amount: number) => void): void {
    const dx = this.nodeB.pos.x - this.nodeA.pos.x;
    const dy = this.nodeB.pos.y - this.nodeA.pos.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    this.currentLength = len;
    if (len < 1e-6) return;

    const invLen = 1 / len;
    const nx = dx * invLen;
    const ny = dy * invLen;

    // Effective rest length with muscle actuation
    let effectiveRest = this.restLength;
    if (this.isActuated) {
      effectiveRest = this.restLength * (1 + this.activation * this.contractionRatio);
      // Energy cost proportional to effort
      const effort = Math.abs(this.activation) * (Math.abs(len - effectiveRest) + 0.5);
      onEnergyCost(effort * 0.0004);
    }

    // Spring force (Hooke)
    const springF = (len - effectiveRest) * this.stiffness;

    // Damping: project relative velocity onto spring axis
    const velDx = this.nodeB.vel.x - this.nodeA.vel.x;
    const velDy = this.nodeB.vel.y - this.nodeA.vel.y;
    const relVelAlongSpring = velDx * nx + velDy * ny;
    const dampF = relVelAlongSpring * this.damping;

    const totalF = springF + dampF;
    const fx = nx * totalF;
    const fy = ny * totalF;

    this.nodeA.acc.x += fx / this.nodeA.mass;
    this.nodeA.acc.y += fy / this.nodeA.mass;
    this.nodeB.acc.x -= fx / this.nodeB.mass;
    this.nodeB.acc.y -= fy / this.nodeB.mass;
  }
}
