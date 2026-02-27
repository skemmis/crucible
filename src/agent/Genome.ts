import { NeuralNet } from './NeuralNet';

export interface NodeGene {
  /** Relative offsets from the body's anchor point (bottom-centre of body). */
  dx: number;
  dy: number; // positive = above ground (height offset)
  dz: number; // depth offset
  mass: number;
  radius: number;
}

export interface SpringGene {
  a: number; // index into nodes array
  b: number;
  stiffness: number;
  damping: number;
  /** Multiplier on the natural (spawn-time) distance between nodes. */
  restLengthFactor: number;
  isActuated: boolean;
  contractionRatio: number;
}

/**
 * Sensor input layout — 14 inputs.
 *
 * This layout is the single source of truth for what agents can perceive.
 * Every slot is listed here; no sense is silently "always on" or scattered
 * across multiple files.
 *
 * Slots 0–11 are world-state inputs (food, velocity, walls, oscillator).
 * Slots 12–13 are proprioceptive inputs (Proposal #43, Lever D) — they give
 * the brain feedback about the body's own physical state, enabling gait
 * coordination beyond the global oscillator signal.
 *
 * Slot | Signal                        | Range   | Notes
 * -----|-------------------------------|---------|------------------------------
 *  0   | Own energy (normalised)       | [0, 1]  | energy / 250, clamped
 *  1   | Food direction X (tanh)       | [-1, 1] | toward nearest zone
 *  2   | Food direction Y (tanh)       | [-1, 1] | toward nearest zone
 *  3   | Food direction Z (tanh)       | [-1, 1] | toward nearest zone
 *  4   | Own velocity X (tanh)         | [-1, 1] | mean across nodes
 *  5   | Oscillator sin(phase)         | [-1, 1] | internal rhythm
 *  6   | Oscillator cos(phase)         | [-1, 1] | internal rhythm
 *  7   | Own velocity Z (tanh)         | [-1, 1] | mean across nodes
 *  8   | Distance to nearest food      | [0, 1]  | tanh-normalised (scale 300)
 *  9   | Nearest food zone energy      | [0, 1]  | zone.energy / zone.maxEnergy
 * 10   | Wall proximity X              | [0, 1]  | 1 = touching wall, 0 = centre
 * 11   | Wall proximity Z              | [0, 1]  | 1 = touching wall, 0 = centre
 * 12   | Stretch sensor (tanh)         | [0, 1]  | mean |springLen - restLen| / restLen,
 *      |                               |         | tanh-scaled by 3×; actuated springs only.
 *      |                               |         | Tells the brain how "activated" the body
 *      |                               |         | currently is.
 * 13   | Ground contact fraction       | [0, 1]  | groundContactNodes / totalNodes.
 *      |                               |         | Tells the brain how many feet are planted.
 */
export const SENSOR_COUNT = 14;

/** Distance at which wall-proximity sensor saturates (world units). */
export const WALL_SENSE_RADIUS = 200;

/** Distance scale for food-distance tanh normalisation (world units). */
export const FOOD_DISTANCE_SCALE = 300;

export const HIDDEN_SIZE = 10;

/**
 * Number of "kinship marker" nodes sampled from the start of the node list.
 * Using only the first few nodes keeps the kinship computation cheap and
 * stable (early nodes in the genome are unlikely to be absent due to
 * minimum node count guarantees).
 */
const KINSHIP_MARKER_NODES = 3;

/** Typical L2 kinship-vector distance between parent and child (empirically ~30–40). */
const KINSHIP_SCALE = 35;

/**
 * Archetype names — used to draw from a known-locomoting seed pool at
 * generation 0.  Archetypes are procedurally generated here so they require
 * no external data files and remain in sync with NodeGene / SpringGene types.
 */
export type ArchetypeName = 'worm' | 'quad' | 'tripod';

/**
 * Sigma for node position mutations (dx, dy, dz).
 *
 * Reduced from 12 → 5 (Proposal #43, Lever A).
 *
 * Rationale: at sigma=12 a 5-node body with a 50-unit arm span drifts
 * completely unrecognisable within 5–10 generations, making directional
 * selection on morphology nearly impossible.  sigma=5 dramatically extends
 * lineage lifetime, giving the brain time to adapt to a stable body plan
 * and allowing selection to act on locomotion strategy rather than just
 * resetting it each generation.
 *
 * Spring parameter sigmas are unchanged — they are proportional and already
 * smaller in effect.
 */
const NODE_POSITION_SIGMA = 5;

export class Genome {
  constructor(
    public nodes: NodeGene[],
    public springs: SpringGene[],
    public brain: NeuralNet,
  ) {}

  // ─── Factory ────────────────────────────────────────────────────────────────

  static random(): Genome {
    const nodeCount = 3 + Math.floor(Math.random() * 5); // 3–7 nodes
    const nodes: NodeGene[] = Array.from({ length: nodeCount }, () => ({
      dx: (Math.random() - 0.5) * 70,
      dy: Math.random() * 70,   // positive = above ground
      dz: (Math.random() - 0.5) * 70,
      mass: 0.6 + Math.random() * 1.2,
      radius: 4 + Math.random() * 5,
    }));

    // Spanning tree ensures connectivity, then add a few extra edges
    const springs: SpringGene[] = [];
    for (let i = 1; i < nodeCount; i++) {
      const j = Math.floor(Math.random() * i);
      springs.push(Genome.randomSpring(j, i));
    }
    const extras = Math.floor(Math.random() * 3);
    for (let k = 0; k < extras; k++) {
      const a = Math.floor(Math.random() * nodeCount);
      const b = (a + 1 + Math.floor(Math.random() * (nodeCount - 1))) % nodeCount;
      if (!springs.some(s => (s.a === a && s.b === b) || (s.a === b && s.b === a))) {
        springs.push(Genome.randomSpring(a, b));
      }
    }

    const muscleCount = Math.max(1, springs.filter(s => s.isActuated).length);
    const brain = new NeuralNet(SENSOR_COUNT, HIDDEN_SIZE, muscleCount);
    return new Genome(nodes, springs, brain);
  }

  // ─── Archetypes ─────────────────────────────────────────────────────────────

  /**
   * Return a procedurally generated archetype genome guaranteed to have a
   * functional body plan.  All archetypes are fully actuated and have at least
   * one triangle in their spring graph for structural stability.
   *
   * Three archetypes are available:
   *
   *  'worm'  — 5-node linear chain. Phase-staggered muscle activations produce
   *             a peristaltic wave when the oscillator drives the brain.
   *
   *  'quad'  — 4-node rectangular body. Two diagonals create two triangles;
   *             bilateral structure naturally produces symmetric gaits.
   *
   *  'tripod' — 3-node triangle. Minimal viable structure: one raised body node
   *              and two ground-contact nodes, with all three springs actuated.
   */
  static archetype(name: ArchetypeName): Genome {
    switch (name) {
      case 'worm':   return Genome._worm();
      case 'quad':   return Genome._quad();
      case 'tripod': return Genome._tripod();
    }
  }

  /** Pick a random archetype name uniformly. */
  static randomArchetypeName(): ArchetypeName {
    const names: ArchetypeName[] = ['worm', 'quad', 'tripod'];
    return names[Math.floor(Math.random() * names.length)];
  }

  // ── Worm ────────────────────────────────────────────────────────────────────

  private static _worm(): Genome {
    // 5 nodes in a horizontal chain along X.
    // Low dy keeps them close to ground; slight Z variance adds stability.
    const nodes: NodeGene[] = [
      { dx: -40, dy: 8,  dz:  0, mass: 0.9, radius: 6 },
      { dx: -20, dy: 8,  dz:  2, mass: 0.9, radius: 6 },
      { dx:   0, dy: 9,  dz:  0, mass: 0.9, radius: 6 },
      { dx:  20, dy: 8,  dz: -2, mass: 0.9, radius: 6 },
      { dx:  40, dy: 8,  dz:  0, mass: 0.9, radius: 6 },
    ];

    // Linear chain (4 muscles) + one stabilising diagonal to create a triangle
    const springs: SpringGene[] = [
      { a: 0, b: 1, stiffness: 300, damping: 6, restLengthFactor: 0.85, isActuated: true,  contractionRatio: 0.28 },
      { a: 1, b: 2, stiffness: 300, damping: 6, restLengthFactor: 0.85, isActuated: true,  contractionRatio: 0.28 },
      { a: 2, b: 3, stiffness: 300, damping: 6, restLengthFactor: 0.85, isActuated: true,  contractionRatio: 0.28 },
      { a: 3, b: 4, stiffness: 300, damping: 6, restLengthFactor: 0.85, isActuated: true,  contractionRatio: 0.28 },
      // Triangle brace: nodes 1-2-3 form a rigid triangle
      { a: 1, b: 3, stiffness: 200, damping: 5, restLengthFactor: 1.0,  isActuated: false, contractionRatio: 0.20 },
    ];

    const muscleCount = springs.filter(s => s.isActuated).length; // 4
    const brain = new NeuralNet(SENSOR_COUNT, HIDDEN_SIZE, muscleCount);
    return new Genome(nodes, springs, brain);
  }

  // ── Quad ────────────────────────────────────────────────────────────────────

  private static _quad(): Genome {
    // 4 nodes in a rectangle, roughly symmetric about Z=0.
    const nodes: NodeGene[] = [
      { dx: -22, dy: 8, dz: -16, mass: 1.0, radius: 6 },  // 0: front-left
      { dx:  22, dy: 8, dz: -16, mass: 1.0, radius: 6 },  // 1: front-right
      { dx:  22, dy: 8, dz:  16, mass: 1.0, radius: 6 },  // 2: back-right
      { dx: -22, dy: 8, dz:  16, mass: 1.0, radius: 6 },  // 3: back-left
    ];

    // Perimeter (4) + 2 diagonals → 2 triangles, fully triangulated quad
    const springs: SpringGene[] = [
      { a: 0, b: 1, stiffness: 350, damping: 7, restLengthFactor: 0.88, isActuated: true,  contractionRatio: 0.25 },
      { a: 1, b: 2, stiffness: 350, damping: 7, restLengthFactor: 0.88, isActuated: true,  contractionRatio: 0.25 },
      { a: 2, b: 3, stiffness: 350, damping: 7, restLengthFactor: 0.88, isActuated: true,  contractionRatio: 0.25 },
      { a: 3, b: 0, stiffness: 350, damping: 7, restLengthFactor: 0.88, isActuated: true,  contractionRatio: 0.25 },
      { a: 0, b: 2, stiffness: 250, damping: 5, restLengthFactor: 1.0,  isActuated: false, contractionRatio: 0.20 },
      { a: 1, b: 3, stiffness: 250, damping: 5, restLengthFactor: 1.0,  isActuated: false, contractionRatio: 0.20 },
    ];

    const muscleCount = springs.filter(s => s.isActuated).length; // 4
    const brain = new NeuralNet(SENSOR_COUNT, HIDDEN_SIZE, muscleCount);
    return new Genome(nodes, springs, brain);
  }

  // ── Tripod ──────────────────────────────────────────────────────────────────

  private static _tripod(): Genome {
    // 3 nodes: one raised body + two ground-contact feet.
    // The triangle is inherently rigid and all springs are actuated.
    const nodes: NodeGene[] = [
      { dx:   0, dy: 28, dz:  0, mass: 1.2, radius: 7 },  // 0: body (raised)
      { dx: -22, dy:  6, dz: 18, mass: 0.8, radius: 5 },  // 1: left foot
      { dx:  22, dy:  6, dz: 18, mass: 0.8, radius: 5 },  // 2: right foot
    ];

    const springs: SpringGene[] = [
      { a: 0, b: 1, stiffness: 280, damping: 6, restLengthFactor: 0.80, isActuated: true,  contractionRatio: 0.30 },
      { a: 0, b: 2, stiffness: 280, damping: 6, restLengthFactor: 0.80, isActuated: true,  contractionRatio: 0.30 },
      { a: 1, b: 2, stiffness: 200, damping: 5, restLengthFactor: 0.90, isActuated: true,  contractionRatio: 0.22 },
    ];

    const muscleCount = springs.filter(s => s.isActuated).length; // 3
    const brain = new NeuralNet(SENSOR_COUNT, HIDDEN_SIZE, muscleCount);
    return new Genome(nodes, springs, brain);
  }

  // ─── Private spring helper ───────────────────────────────────────────────────

  private static randomSpring(a: number, b: number): SpringGene {
    return {
      a, b,
      stiffness: 150 + Math.random() * 400,
      damping: 3 + Math.random() * 10,
      restLengthFactor: 0.7 + Math.random() * 0.6,
      isActuated: Math.random() < 0.55,
      contractionRatio: 0.15 + Math.random() * 0.25,
    };
  }

  // ─── Kinship ─────────────────────────────────────────────────────────────────

  /**
   * Compute a kinship score in [0, 1] between two genomes.
   *
   * Uses only the first KINSHIP_MARKER_NODES nodes (5 features each) as
   * "kinship markers" — a compact, heritable signal analogous to a genetic
   * fingerprint.  Distance is L2 in this marker space, converted to similarity
   * via an exponential decay.
   *
   *   kinship = 1.0  → identical marker vectors (self or perfect clone)
   *   kinship ≈ 0.37 → L2 distance = KINSHIP_SCALE (~typical parent–child gap)
   *   kinship ≈ 0.0  → unrelated (distance >> KINSHIP_SCALE)
   *
   * O(KINSHIP_MARKER_NODES × 5) — effectively O(1).
   */
  static kinship(a: Genome, b: Genome): number {
    const len = Math.min(KINSHIP_MARKER_NODES, a.nodes.length, b.nodes.length);
    let distSq = 0;
    for (let i = 0; i < len; i++) {
      const na = a.nodes[i];
      const nb = b.nodes[i];
      distSq += (na.dx     - nb.dx)     ** 2;
      distSq += (na.dy     - nb.dy)     ** 2;
      distSq += (na.dz     - nb.dz)     ** 2;
      distSq += (na.mass   - nb.mass)   ** 2;
      distSq += (na.radius - nb.radius) ** 2;
    }
    return Math.exp(-Math.sqrt(distSq) / KINSHIP_SCALE);
  }

  // ─── Mutation ───────────────────────────────────────────────────────────────

  mutate(): Genome {
    const p = (x: number, sigma: number) => x + (Math.random() - 0.5) * sigma;

    // Node positions mutate with NODE_POSITION_SIGMA (reduced from 12 → 5).
    // Mass and radius sigmas are unchanged — they are proportional and already
    // small enough to allow stable refinement within a lineage.
    const newNodes = this.nodes.map(n => ({
      dx: p(n.dx, NODE_POSITION_SIGMA),
      dy: Math.max(0, p(n.dy, NODE_POSITION_SIGMA)),  // dy ≥ 0: never below ground
      dz: p(n.dz, NODE_POSITION_SIGMA),
      mass: Math.max(0.2, p(n.mass, 0.25)),
      radius: Math.max(2, p(n.radius, 1.2)),
    }));

    let newSprings = this.springs.map(s => ({
      ...s,
      stiffness: Math.max(20, p(s.stiffness, 40)),
      damping: Math.max(0.5, p(s.damping, 1.5)),
      restLengthFactor: Math.max(0.1, p(s.restLengthFactor, 0.12)),
      contractionRatio: Math.max(0.05, Math.min(0.6, p(s.contractionRatio, 0.05))),
      isActuated: Math.random() < 0.06 ? !s.isActuated : s.isActuated,
    }));

    // Occasionally add a spring — prefer triangle completion (~70% of additions)
    if (Math.random() < 0.12 && newNodes.length >= 2) {
      const candidate = Genome._pickNewSpring(newNodes.length, newSprings);
      if (candidate !== null) {
        newSprings.push(Genome.randomSpring(candidate.a, candidate.b));
      }
    }
    // Occasionally remove a spring (keep at least nodeCount-1 for connectivity)
    if (Math.random() < 0.08 && newSprings.length > newNodes.length - 1) {
      newSprings.splice(Math.floor(Math.random() * newSprings.length), 1);
    }

    const newMuscleCount = Math.max(1, newSprings.filter(s => s.isActuated).length);
    const newBrain = this.brain.mutate(0.14, newMuscleCount);
    return new Genome(newNodes, newSprings, newBrain);
  }

  /**
   * Pick an (a, b) pair for a new spring, biased toward triangle completion.
   *
   * Triangle-completion bias: scan for any pair (a, b) that share at least
   * one common neighbour in the spring graph but are not yet directly
   * connected.  If any such open triangle exists, complete one with 70%
   * probability; otherwise fall back to a random edge.
   *
   * This is a *soft* bias — it never prevents random edges from being added,
   * and it has no effect if the graph already has no open triangles.
   */
  private static _pickNewSpring(
    nodeCount: number,
    existing: SpringGene[],
  ): { a: number; b: number } | null {
    // Build adjacency list
    const adj: Set<number>[] = Array.from({ length: nodeCount }, () => new Set<number>());
    for (const s of existing) {
      adj[s.a].add(s.b);
      adj[s.b].add(s.a);
    }

    // Collect open triangles: pairs (a, b) not yet connected sharing a neighbour
    const openTriangles: Array<{ a: number; b: number }> = [];
    for (let a = 0; a < nodeCount; a++) {
      for (const mid of adj[a]) {
        for (const b of adj[mid]) {
          if (b !== a && !adj[a].has(b) && a < b) {
            openTriangles.push({ a, b });
          }
        }
      }
    }

    // 70% chance to complete a triangle if one is available
    if (openTriangles.length > 0 && Math.random() < 0.70) {
      return openTriangles[Math.floor(Math.random() * openTriangles.length)];
    }

    // Fallback: random edge not already in the graph
    const maxAttempts = 12;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const a = Math.floor(Math.random() * nodeCount);
      const b = (a + 1 + Math.floor(Math.random() * (nodeCount - 1))) % nodeCount;
      if (!adj[a].has(b)) return { a, b };
    }

    return null; // extremely dense graph — skip addition
  }

  clone(): Genome {
    return new Genome(
      this.nodes.map(n => ({ ...n })),
      this.springs.map(s => ({ ...s })),
      new NeuralNet(this.brain.inputSize, this.brain.hiddenSize, this.brain.outputSize, this.brain.serialize()),
    );
  }
}
