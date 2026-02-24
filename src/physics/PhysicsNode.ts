import { Vec2 } from './Vec2';

export class PhysicsNode {
  pos: Vec2;
  prevPos: Vec2;
  acc: Vec2;
  mass: number;
  radius: number;

  constructor(x: number, y: number, mass: number = 1, radius: number = 5) {
    this.pos = new Vec2(x, y);
    this.prevPos = new Vec2(x, y);
    this.acc = new Vec2(0, 0);
    this.mass = mass;
    this.radius = radius;
  }

  /** Velocity implied by Verlet (pos - prevPos, one-frame displacement). */
  get vel(): Vec2 {
    return this.pos.sub(this.prevPos);
  }

  applyForce(f: Vec2): void {
    // acc accumulates F/m; applied once per integrate()
    this.acc.x += f.x / this.mass;
    this.acc.y += f.y / this.mass;
  }

  /**
   * Verlet integration step.
   * newPos = pos + vel + acc * dt²
   */
  integrate(dt: number): void {
    const vel = this.vel;
    const nx = this.pos.x + vel.x + this.acc.x * dt * dt;
    const ny = this.pos.y + vel.y + this.acc.y * dt * dt;
    this.prevPos.x = this.pos.x;
    this.prevPos.y = this.pos.y;
    this.pos.x = nx;
    this.pos.y = ny;
    this.acc.x = 0;
    this.acc.y = 0;
  }

  /**
   * Push node above the ground plane and apply friction/restitution.
   * friction ∈ [0, 1]: 0 = frictionless, 1 = full stop.
   */
  constrainToGround(groundY: number, friction: number, restitution: number = 0.2): void {
    if (this.pos.y + this.radius > groundY) {
      const vel = this.vel;
      // Resolve penetration
      this.pos.y = groundY - this.radius;
      // Bounce: invert vertical velocity with energy loss
      this.prevPos.y = this.pos.y + vel.y * restitution;
      // Friction: dampen horizontal velocity
      this.prevPos.x = this.pos.x - vel.x * (1 - friction);
    }
  }

  /** Clamp to horizontal world bounds. */
  constrainToWidth(minX: number, maxX: number): void {
    if (this.pos.x - this.radius < minX) {
      const vel = this.vel;
      this.pos.x = minX + this.radius;
      this.prevPos.x = this.pos.x + vel.x * 0.5; // soft bounce
    }
    if (this.pos.x + this.radius > maxX) {
      const vel = this.vel;
      this.pos.x = maxX - this.radius;
      this.prevPos.x = this.pos.x + vel.x * 0.5;
    }
  }
}
