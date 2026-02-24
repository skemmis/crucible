export class Vec3 {
  constructor(public x: number = 0, public y: number = 0, public z: number = 0) {}

  clone(): Vec3 { return new Vec3(this.x, this.y, this.z); }

  add(o: Vec3): Vec3 { return new Vec3(this.x + o.x, this.y + o.y, this.z + o.z); }
  sub(o: Vec3): Vec3 { return new Vec3(this.x - o.x, this.y - o.y, this.z - o.z); }
  scale(s: number): Vec3 { return new Vec3(this.x * s, this.y * s, this.z * s); }

  /** Mutating variants — avoid allocation in tight physics loops */
  addMut(o: Vec3): this { this.x += o.x; this.y += o.y; this.z += o.z; return this; }
  scaleMut(s: number): this { this.x *= s; this.y *= s; this.z *= s; return this; }

  dot(o: Vec3): number { return this.x * o.x + this.y * o.y + this.z * o.z; }

  lengthSq(): number { return this.x * this.x + this.y * this.y + this.z * this.z; }
  length(): number { return Math.sqrt(this.lengthSq()); }

  normalise(): Vec3 {
    const l = this.length();
    return l > 1e-9 ? this.scale(1 / l) : new Vec3();
  }

  set(x: number, y: number, z: number): this { this.x = x; this.y = y; this.z = z; return this; }
  copyFrom(o: Vec3): this { this.x = o.x; this.y = o.y; this.z = o.z; return this; }
}
