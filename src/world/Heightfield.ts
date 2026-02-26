<full new content of the file>
/**
 * Static procedural heightfield, baked once at world-generation time.
 *
 * Represents the ground surface as a 2-D grid of Y-heights (Y-up convention).
 * Heights are computed using multi-octave sine waves — no external library
 * required.  bilinear interpolation gives smooth per-node ground heights at
 * runtime (O(1) per query).
 *
 * Design constraints (from proposal consensus):
 *  - Baked at world-gen, never mutated at runtime (static topography first)
 *  - Heights kept moderate (0..MAX_HEIGHT) so ground-tier food zones at Y=0
 *    with radius 60–90 remain harvestable from the terrain surface
 *  - Zero new dynamic objects, zero collision-overhead increase
 */
export class Heightfield {
  /** Flat row-major grid of heights, row = Z axis, column = X axis. */
  readonly grid: Float32Array;
  readonly gridW: number;   // number of sample columns
  readonly gridH: number;   // number of sample rows
  readonly cellW: number;   // world units per cell (X)
  readonly cellH: number;   // world units per cell (Z)
  readonly maxHeight: number;

  constructor(
    readonly worldWidth: number,
    readonly worldDepth: number,
    /** Number of sample points along each axis.  64 gives a good balance of
     *  detail vs. memory (64×64 × 4 bytes = 16 kB). */
    resolution: number = 64,
    /** Maximum terrain height in world units.  Kept ≤30 so ground-tier food
     *  zones (radius 60–90) remain within reach from the raised surface. */
    amplitude: number = 28,
  ) {
    this.gridW = resolution;
    this.gridH = resolution;
    this.cellW = worldWidth / (resolution - 1);
    this.cellH = worldDepth / (resolution - 1);
    this.maxHeight = amplitude;
    this.grid = new Float32Array(resolution * resolution);
    this._generate(amplitude);
  }

  // ── Generation ──────────────────────────────────────────────────────────────

  private _generate(amplitude: number): void {
    // Multi-octave sine / cosine waves with fixed offsets → deterministic but
    // visually varied.  Three octaves: large hills, medium rolls, fine bumps.
    const A0 = amplitude;
    const A1 = amplitude * 0.45;
    const A2 = amplitude * 0.18;

    // Total raw amplitude span used to normalise into [0, amplitude]
    const rawMax = A0 + A1 + A2;

    for (let gz = 0; gz < this.gridH; gz++) {
      for (let gx = 0; gx < this.gridW; gx++) {
        // Normalised [0, 1] grid coordinates
        const wx = gx / (this.gridW - 1);
        const wz = gz / (this.gridH - 1);

        // Octave 0 — large hills (~3 cycles across world)
        const h0 = Math.sin(wx * Math.PI * 3.1 + 1.3) *
                   Math.cos(wz * Math.PI * 2.7 + 0.8) * A0;

        // Octave 1 — medium rolls (~5–7 cycles)
        const h1 = Math.sin(wx * Math.PI * 6.7 + 2.1) *
                   Math.cos(wz * Math.PI * 5.3 + 1.5) * A1;

        // Octave 2 — fine bumps (~11–13 cycles)
        const h2 = Math.sin(wx * Math.PI * 13.1 + 3.7) *
                   Math.cos(wz * Math.PI * 11.3 + 2.9) * A2;

        // Map raw value (-rawMax … +rawMax) → (0 … amplitude)
        const raw = h0 + h1 + h2;
        const normalised = (raw + rawMax) / (2 * rawMax) * amplitude;

        this.grid[gz * this.gridW + gx] = Math.max(0, normalised);
      }
    }
  }

  // ── Query ───────────────────────────────────────────────────────────────────

  /**
   * Bilinearly interpolated ground height at world position (x, z).
   * Clamps gracefully at world boundaries.  O(1).
   */
  heightAt(worldX: number, worldZ: number): number {
    // Convert world coords → fractional grid coords
    const gxF = Math.max(0, Math.min(this.gridW - 1, worldX / this.cellW));
    const gzF = Math.max(0, Math.min(this.gridH - 1, worldZ / this.cellH));

    const x0 = Math.floor(gxF);
    const z0 = Math.floor(gzF);
    const x1 = Math.min(x0 + 1, this.gridW - 1);
    const z1 = Math.min(z0 + 1, this.gridH - 1);

    const fx = gxF - x0;
    const fz = gzF - z0;

    const h00 = this.grid[z0 * this.gridW + x0];
    const h10 = this.grid[z0 * this.gridW + x1];
    const h01 = this.grid[z1 * this.gridW + x0];
    const h11 = this.grid[z1 * this.gridW + x1];

    // Bilinear interpolation
    return h00 * (1 - fx) * (1 - fz)
         + h10 * fx       * (1 - fz)
         + h01 * (1 - fx) * fz
         + h11 * fx       * fz;
  }
}
