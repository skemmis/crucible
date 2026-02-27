import { PhysicsNode } from '../physics/PhysicsNode';

/**
 * Flat 2-D spatial hash for fast broad-phase neighbour queries in the XZ plane.
 *
 * Cell-size tuning note
 * ─────────────────────
 * CELL_SIZE is a module-level constant intentionally exposed for future tuning.
 * The correct cell size is roughly 2 × max_node_radius so that any two
 * overlapping nodes are guaranteed to be in the same or adjacent cells.
 * Node radii currently range from ~4–9 world units (see Genome.ts), so 30 is
 * a safe upper bound.  If node radii are ever increased, raise CELL_SIZE
 * accordingly.
 *
 * Owner for tuning: World.ts (whoever calls _applyInterAgentCollision).
 * Tracking issue: revisit if agent density regularly exceeds 200+ agents or
 * max node radius grows beyond 15 world units.
 */
export const COLLISION_CELL_SIZE = 30;

/** Payload stored per node so collision code can identify which agent owns it. */
export interface NodeEntry {
  node: PhysicsNode;
  agentId: number;
}

export class SpatialHash {
  private readonly _cells = new Map<number, NodeEntry[]>();
  private readonly _cellSize: number;

  constructor(cellSize: number = COLLISION_CELL_SIZE) {
    this._cellSize = cellSize;
  }

  /** Remove all entries — call once per frame before re-inserting. */
  clear(): void {
    this._cells.clear();
  }

  /** Insert a node tagged with the owning agent's id. */
  insert(node: PhysicsNode, agentId: number): void {
    const key = this._cellKey(
      Math.floor(node.pos.x / this._cellSize),
      Math.floor(node.pos.z / this._cellSize),
    );
    let bucket = this._cells.get(key);
    if (bucket === undefined) {
      bucket = [];
      this._cells.set(key, bucket);
    }
    bucket.push({ node, agentId });
  }

  /**
   * Return all entries in cells overlapping a circle of `radius` centred at
   * (worldX, worldZ).  Results may include the queried node itself — callers
   * must filter by agentId and identity as needed.
   */
  query(worldX: number, worldZ: number, radius: number): NodeEntry[] {
    const minCx = Math.floor((worldX - radius) / this._cellSize);
    const maxCx = Math.floor((worldX + radius) / this._cellSize);
    const minCz = Math.floor((worldZ - radius) / this._cellSize);
    const maxCz = Math.floor((worldZ + radius) / this._cellSize);

    const result: NodeEntry[] = [];
    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cz = minCz; cz <= maxCz; cz++) {
        const bucket = this._cells.get(this._cellKey(cx, cz));
        if (bucket !== undefined) {
          for (const entry of bucket) result.push(entry);
        }
      }
    }
    return result;
  }

  /**
   * Stable integer key for cell (cx, cz).
   * Uses a large prime to reduce hash collisions in dense grids.
   * Safe for the coordinate range needed here (world ≤ 2000 units → cx ≤ ~67).
   */
  private _cellKey(cx: number, cz: number): number {
    // Shift cz to avoid negative-key confusion; world coords are always ≥ 0
    return cx * 100_003 + cz;
  }
}