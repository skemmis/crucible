export class Vec2 {
  constructor(public x: number = 0, public y: number = 0) {}

  add(v: Vec2): Vec2 { return new Vec2(this.x + v.x, this.y + v.y); }
  sub(v: Vec2): Vec2 { return new Vec2(this.x - v.x, this.y - v.y); }
  scale(s: number): Vec2 { return new Vec2(this.x * s, this.y * s); }
  dot(v: Vec2): number { return this.x * v.x + this.y * v.y; }
  lengthSq(): number { return this.x * this.x + this.y * this.y; }
  length(): number { return Math.sqrt(this.lengthSq()); }
  clone(): Vec2 { return new Vec2(this.x, this.y); }

  normalize(): Vec2 {
    const len = this.length();
    return len > 1e-8 ? this.scale(1 / len) : new Vec2(0, 0);
  }

  // Mutating helpers (avoid allocation in tight loops)
  addMut(v: Vec2): this { this.x += v.x; this.y += v.y; return this; }
  scaleMut(s: number): this { this.x *= s; this.y *= s; return this; }
}
