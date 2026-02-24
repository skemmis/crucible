import { NeuralNet } from './NeuralNet';

export interface NodeGene {
  /** Relative offset from the body's anchor point (lowest-center). */
  dx: number;
  dy: number; // negative = above anchor
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

/** Sensor count must stay constant so networks stay compatible across lineages. */
export const SENSOR_COUNT = 6; // [energy_norm, food_dx, food_dy, vel_x, sin_phase, cos_phase]
export const HIDDEN_SIZE = 10;

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
      dy: -(Math.random() * 70),   // keep above anchor (negative y = up)
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
      let b = (a + 1 + Math.floor(Math.random() * (nodeCount - 1))) % nodeCount;
      // avoid duplicate
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

  // ─── Mutation ───────────────────────────────────────────────────────────────

  mutate(): Genome {
    const p = (x: number, sigma: number) => x + (Math.random() - 0.5) * sigma;

    // Mutate node positions / sizes
    const newNodes = this.nodes.map(n => ({
      dx: p(n.dx, 12),
      dy: Math.min(0, p(n.dy, 12)),  // dy ≤ 0: never below anchor
      mass: Math.max(0.2, p(n.mass, 0.25)),
      radius: Math.max(2, p(n.radius, 1.2)),
    }));

    // Mutate spring params
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
