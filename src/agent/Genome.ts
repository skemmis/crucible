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
 * Sensor input layout — 12 inputs.
 *
 * This layout is the single source of truth for what agents can perceive.
 * Every slot is listed here; no sense is silently "always on" or scattered
 * across multiple files.  When Option 3 (evolvable sense allocation) is built,
 * this table becomes the sense registry that genomes index into.
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
 */
export const SENSOR_COUNT = 12;

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

    const newNodes = this.nodes.map(n => ({
      dx: p(n.dx, 12),
      dy: Math.max(0, p(n.dy, 12)),  // dy ≥ 0: never below ground
      dz: p(n.dz, 12),
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

    // Occasionally add a spring
    if (Math.random() < 0.12 && newNodes.length >= 2) {
      const a = Math.floor(Math.random() * newNodes.length);
      const b = (a + 1 + Math.floor(Math.random() * (newNodes.length - 1))) % newNodes.length;
      if (!newSprings.some(s => (s.a === a && s.b === b) || (s.a === b && s.b === a))) {
        newSprings.push(Genome.randomSpring(a, b));
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

  clone(): Genome {
    return new Genome(
      this.nodes.map(n => ({ ...n })),
      this.springs.map(s => ({ ...s })),
      new NeuralNet(this.brain.inputSize, this.brain.hiddenSize, this.brain.outputSize, this.brain.serialize()),
    );
  }
}