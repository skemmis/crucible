import { Vec3 } from './Vec3';

/**
 * A point mass in 3-D space.
 *
 * Convention (Three.js Y-up):
 *   +Y  = up   (ground surface is at Y = 0)
 *   +X  = right
 *   +Z  = toward viewer in default camera orientation
 *
 * Verlet integration:
 *   vel    = pos - prevPos       (implicit)
 *   newPos = pos + vel + acc*dt²
 *   acc is reset to zero after each integrate() call.
 */
export class PhysicsNode {
  pos: Vec3;
  prevPos: Vec3;
  acc: Vec3;

  constructor(
    x: number,
    y: number,
    z: number,
    public mass: number = 1,
    public radius: number = 5,
  ) {
    this.pos = new Vec3(x, y, z);
    this.prevPos = new Vec3(x, y, z);
    this.acc = new Vec3();
  }

  /** Velocity implied by Verlet (pos − prevPos, one-frame displacement). */
  get vel(): Vec3 {
    return this.pos.sub(this.prevPos);
  }

  /** Verlet integration step. */
  integrate(dt: number): void {
    const vel = this.vel;
    const nx = this.pos.x + vel.x + this.acc.x * dt * dt;
    const ny = this.pos.y + vel.y + this.acc.y * dt * dt;
    const nz = this.pos.z + vel.z + this.acc.z * dt * dt;
    this.prevPos.set(this.pos.x, this.pos.y, this.pos.z);
    this.pos.set(nx, ny, nz);
    this.acc.set(0, 0, 0);
  }

  /**
   * Keep node above the ground plane (Y = 0).
   * friction   ∈ [0, 1]: XZ velocity damping on contact.
   * restitution ∈ [0, 1]: vertical bounce factor.
   */
  constrainToGround(friction: number = 0.35, restitution: number = 0.15): void {
    const minY = this.radius;
    if (this.pos.y < minY) {
      const velX = this.pos.x - this.prevPos.x;
      const velY = this.pos.y - this.prevPos.y;
      const velZ = this.pos.z - this.prevPos.z;

      this.pos.y = minY;
      this.prevPos.y = this.pos.y + velY * restitution;   // bounce
      this.prevPos.x = this.pos.x - velX * (1 - friction); // XZ friction
      this.prevPos.z = this.pos.z - velZ * (1 - friction);
    }
  }

  /** Soft world-boundary reflection on X and Z axes. */
  constrainToWorldBounds(
    minX: number, maxX: number,
    minZ: number, maxZ: number,
  ): void {
    if (this.pos.x < minX + this.radius) {
      const vx = this.pos.x - this.prevPos.x;
      this.pos.x = minX + this.radius;
      this.prevPos.x = this.pos.x + Math.abs(vx) * 0.5;
    }
    if (this.pos.x > maxX - this.radius) {
      const vx = this.pos.x - this.prevPos.x;
      this.pos.x = maxX - this.radius;
      this.prevPos.x = this.pos.x - Math.abs(vx) * 0.5;
    }
    if (this.pos.z < minZ + this.radius) {
      const vz = this.pos.z - this.prevPos.z;
      this.pos.z = minZ + this.radius;
      this.prevPos.z = this.pos.z + Math.abs(vz) * 0.5;
    }
    if (this.pos.z > maxZ - this.radius) {
      const vz = this.pos.z - this.prevPos.z;
      this.pos.z = maxZ - this.radius;
      this.prevPos.z = this.pos.z - Math.abs(vz) * 0.5;
    }
  }
}
