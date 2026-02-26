<full new content of the file>
import { Agent } from '../agent/Agent';
import { Genome } from '../agent/Genome';
import { Environment } from './Environment';
import { Heightfield } from './Heightfield';

export interface WorldConfig {
  worldWidth: number;
  worldDepth: number;
  initialAgents: number;
  maxAgents: number;
  zoneCount: number;
  /** Heightfield resolution (grid points per axis). Default 64. */
  heightfieldResolution?: number;
  /** Maximum terrain height in world units. Default 28. */
  heightfieldAmplitude?: number;
}

export const DEFAULT_CONFIG: WorldConfig = {
  worldWidth: 1200,
  worldDepth: 1200,
  initialAgents: 16,
  maxAgents: 60,
  zoneCount: 24,   // increased from 12 → 24 to distribute agents and reduce bottlenecking
  heightfieldResolution: 64,
  heightfieldAmplitude: 28,
};

// ── Telemetry types ────────────────────────────────────────────────────────────

export interface TelemetrySnapshot {
  timestamp: number;        // wall-clock ms
  simTime: number;          // simulation seconds
  stepCount: number;

  // Metric 1: genome diversity — mean L2 distance from rolling centroid (O(nk))
  genomeDiversity: number;

  // Metric 2: birth/death ratio trend over last 500 frames
  birthRate: number;        // births per 100 frames in window
  deathRate: number;        // deaths per 100 frames in window
  birthDeathRatio: number;

  // Metric 3: diversity rate of change (first derivative vs. last snapshot)
  diversityDelta: number;

  // Metric 4: spatial entropy of agent positions in a 16×16 grid
  spatialEntropy: number;

  // Metric 5: variance in per-agent energy-acquisition rate (crowding diagnostic)
  // High variance = niche differentiation forming; low variance = scramble competition
  energyAcquisitionVariance: number;

  // Metric 6: morphological variance broken down by generation bucket
  // Tracks whether crowding causes convergence (collapse) or divergence (niche carving)
  morphologicalVarianceByGeneration: GenerationVarianceBucket[];

  // Population basics
  agentCount: number;
  meanEnergy: number;
  stddevEnergy: number;

  // Anomaly flags — fires when a metric deviates beyond threshold from baseline
  anomalies: AnomalyFlag[];

  // Optional low-res canvas snapshot — only populated when anomaly fires
  canvasSnapshot?: string;
}

export interface GenerationVarianceBucket {
  /** Generation range label, e.g. "0–9", "10–19", "20+" */
  label: string;
  agentCount: number;
  /** Mean L2 morphological distance from the bucket's own centroid */
  morphVariance: number;
}

export interface AnomalyFlag {
  metric: string;
  description: string;
  value: number;
  baseline: number;
  sigmas: number;
}

// Rolling window size for birth/death tracking
const BIRTH_DEATH_WINDOW = 500;
// Number of past diversity values to keep for baseline / rate-of-change
const DIVERSITY_HISTORY_LEN = 20;
// Anomaly threshold in standard deviations
const ANOMALY_SIGMA = 2.0;
// Spatial grid resolution
const GRID_SIZE = 16;

// ── Telemetry tracker (lives inside World, updated each step) ─────────────────

class TelemetryTracker {
  // Birth/death ring buffers (1 = event in that frame, 0 = none)
  private _birthCounts: number[] = new Array(BIRTH_DEATH_WINDOW).fill(0);
  private _deathCounts: number[] = new Array(BIRTH_DEATH_WINDOW).fill(0);
  private _windowIdx = 0;

  private _birthTotal = 0;
  private _deathTotal = 0;

  // Rolling diversity history
  private _diversityHistory: number[] = [];

  // Rolling baseline for anomaly detection per metric
  private _baseline: Map<string, { values: number[]; mean: number; stddev: number }> = new Map();

  // Last snapshot's diversity value for rate-of-change
  private _lastSnapshotDiversity: number | null = null;

  recordBirth(): void {
    this._birthTotal -= this._birthCounts[this._windowIdx];
    this._birthCounts[this._windowIdx] = (this._birthCounts[this._windowIdx] ?? 0) + 1;
    this._birthTotal += 1;
  }

  recordDeath(): void {
    this._deathTotal -= this._deathCounts[this._windowIdx];
    this._deathCounts[this._windowIdx] = (this._deathCounts[this._windowIdx] ?? 0) + 1;
    this._deathTotal += 1;
  }

  advanceFrame(): void {
    this._windowIdx = (this._windowIdx + 1) % BIRTH_DEATH_WINDOW;
    // Clear the slot we're about to overwrite
    this._birthTotal -= this._birthCounts[this._windowIdx];
    this._birthCounts[this._windowIdx] = 0;
    this._deathTotal -= this._deathCounts[this._windowIdx];
    this._deathCounts[this._windowIdx] = 0;
  }

  get birthRate(): number {
    return (this._birthTotal / BIRTH_DEATH_WINDOW) * 100;
  }

  get deathRate(): number {
    return (this._deathTotal / BIRTH_DEATH_WINDOW) * 100;
  }

  recordDiversity(value: number): void {
    this._diversityHistory.push(value);
    if (this._diversityHistory.length > DIVERSITY_HISTORY_LEN) {
      this._diversityHistory.shift();
    }
  }

  get diversityDeltaSinceLastSnapshot(): number {
    const current = this._diversityHistory[this._diversityHistory.length - 1] ?? 0;
    if (this._lastSnapshotDiversity === null) return 0;
    const delta = current - this._lastSnapshotDiversity;
    this._lastSnapshotDiversity = current;
    return delta;
  }

  markSnapshotDiversity(value: number): void {
    this._lastSnapshotDiversity = value;
  }

  checkAnomaly(metric: string, value: number): AnomalyFlag | null {
    if (!this._baseline.has(metric)) {
      this._baseline.set(metric, { values: [], mean: value, stddev: 0 });
    }
    const b = this._baseline.get(metric)!;
    b.values.push(value);
    if (b.values.length > 50) b.values.shift(); // rolling 50-sample baseline

    const n = b.values.length;
    if (n < 5) return null; // not enough data yet

    const mean = b.values.reduce((s, v) => s + v, 0) / n;
    const variance = b.values.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
    const stddev = Math.sqrt(variance);
    b.mean = mean;
    b.stddev = stddev;

    if (stddev < 1e-9) return null;
    const sigmas = Math.abs(value - mean) / stddev;
    if (sigmas >= ANOMALY_SIGMA) {
      return { metric, description: `${metric} deviated ${sigmas.toFixed(1)}σ from baseline`, value, baseline: mean, sigmas };
    }
    return null;
  }
}

// ── World ─────────────────────────────────────────────────────────────────────

export class World {
  agents: Agent[] = [];
  env: Environment;
  /** Static heightfield baked at construction — never mutated at runtime. */
  readonly heightfield: Heightfield;
  time: number = 0;
  stepCount: number = 0;

  readonly worldWidth: number;
  readonly worldDepth: number;
  readonly maxAgents: number;

  // Phylogeny log: [childId, parentId, generation, birthTime]
  lineageLog: Array<[number, number | null, number, number]> = [];

  readonly telemetry: TelemetryTracker = new TelemetryTracker();

  // Per-agent energy gained in the current frame (keyed by agent id)
  // Used to compute energy-acquisition variance for the crowding diagnostic
  private _frameEnergyGained: Map<number, number> = new Map();

  constructor(cfg: WorldConfig) {
    this.worldWidth = cfg.worldWidth;
    this.worldDepth = cfg.worldDepth;
    this.maxAgents = cfg.maxAgents;
    this.env = new Environment(cfg.worldWidth, cfg.worldDepth, cfg.zoneCount);

    // Bake heightfield once — static for the entire simulation run
    this.heightfield = new Heightfield(
      cfg.worldWidth,
      cfg.worldDepth,
      cfg.heightfieldResolution ?? 64,
      cfg.heightfieldAmplitude ?? 28,
    );

    for (let i = 0; i < cfg.initialAgents; i++) {
      this._spawn(Genome.random());
    }
  }

  private _spawn(genome: Genome, parentAgent?: Agent): Agent {
    const x = 50 + Math.random() * (this.worldWidth - 100);
    const z = 50 + Math.random() * (this.worldDepth - 100);
    // Spawn on top of the terrain surface at this (x, z) location
    const groundY = this.heightfield.heightAt(x, z);
    const a = new Agent(
      genome,
      x,
      groundY,   // _develop() lifts body above this height
      z,
      parentAgent?.generation ?? 0,
      parentAgent?.id ?? null,
      parentAgent?.hue ?? Math.random() * 360,
    );
    this.agents.push(a);
    this.lineageLog.push([a.id, a.parentId, a.generation, a.birthTime]);
    return a;
  }

  update(dt: number): void {
    this.time += dt;
    this.stepCount++;
    this.telemetry.advanceFrame();
    this.env.update(dt);

    // Reset per-frame energy tracking
    this._frameEnergyGained.clear();

    const offspring: Agent[] = [];

    let liveCount = this.agents.reduce((n, a) => n + (a.dead ? 0 : 1), 0);

    for (const agent of this.agents) {
      if (agent.dead) continue;

      // Max lifespan: forces generational turnover
      if (agent.age > 180) {
        agent.dead = true;
        liveCount--;
        this.telemetry.recordDeath();
        continue;
      }

      agent.update(dt, this.env.zones, this.worldWidth, this.worldDepth, this.heightfield);
      if (agent.dead) {
        liveCount--;
        this.telemetry.recordDeath();
        continue;
      }

      // Energy harvesting: each node that overlaps a zone absorbs energy
      let frameGained = 0;
      for (const node of agent.nodes) {
        const gained = this.env.harvest(node.pos.x, node.pos.y, node.pos.z, node.radius);
        if (gained > 0) {
          const absorbed = gained * 18;
          agent.absorbEnergy(absorbed);
          frameGained += absorbed;
        }
      }
      this._frameEnergyGained.set(agent.id, frameGained);

      // Reproduction
      if (agent.canReproduce() && liveCount + offspring.length < this.maxAgents) {
        const child = agent.reproduce();
        offspring.push(child);
        this.lineageLog.push([child.id, child.parentId, child.generation, child.birthTime]);
        this.telemetry.recordBirth();
      }
    }

    this.agents = this.agents.filter(a => !a.dead);
    this.agents.push(...offspring);

    // Reseed if population crashes
    if (this.agents.length < 4) {
      const toAdd = Math.min(6, this.maxAgents - this.agents.length);
      for (let i = 0; i < toAdd; i++) {
        this._spawn(Genome.random());
      }
    }

    // Update rolling diversity history every frame (cheap: O(nk))
    const diversity = this._computeGenomeDiversity();
    this.telemetry.recordDiversity(diversity);
  }

  // ── Telemetry snapshot ────────────────────────────────────────────────────────

  /**
   * Capture a telemetry snapshot using only O(n) and O(nk) metrics.
   * Safe to call off the render hot-path (e.g. from a setInterval).
   * Pass a canvasDataUrl only when an anomaly has already been detected.
   */
  captureSnapshot(canvasDataUrl?: string): TelemetrySnapshot {
    const n = this.agents.length;

    // ── Metric 1: genome diversity (rolling centroid distance, O(nk)) ──────────
    const genomeDiversity = this._computeGenomeDiversity();

    // ── Metric 2: birth/death ratio trend ─────────────────────────────────────
    const birthRate = this.telemetry.birthRate;
    const deathRate = this.telemetry.deathRate;
    const birthDeathRatio = deathRate < 1e-6 ? birthRate : birthRate / deathRate;

    // ── Metric 3: diversity rate of change ────────────────────────────────────
    const diversityDelta = this.telemetry.diversityDeltaSinceLastSnapshot;
    this.telemetry.markSnapshotDiversity(genomeDiversity);

    // ── Metric 4: spatial entropy (16×16 grid, O(n)) ──────────────────────────
    const spatialEntropy = this._computeSpatialEntropy();

    // ── Metric 5: energy-acquisition variance ─────────────────────────────────
    const energyAcquisitionVariance = this._computeEnergyAcquisitionVariance();

    // ── Metric 6: morphological variance by generation bucket ─────────────────
    const morphologicalVarianceByGeneration = this._computeMorphologicalVarianceByGeneration();

    // ── Population basics (O(n)) ──────────────────────────────────────────────
    let meanEnergy = 0;
    for (const a of this.agents) meanEnergy += a.energy;
    if (n > 0) meanEnergy /= n;

    let variance = 0;
    for (const a of this.agents) variance += (a.energy - meanEnergy) ** 2;
    const stddevEnergy = n > 1 ? Math.sqrt(variance / n) : 0;

    // ── Anomaly detection ─────────────────────────────────────────────────────
    const anomalies: AnomalyFlag[] = [];
    const checks: Array<[string, number]> = [
      ['genomeDiversity', genomeDiversity],
      ['birthDeathRatio', birthDeathRatio],
      ['spatialEntropy', spatialEntropy],
      ['meanEnergy', meanEnergy],
      ['diversityDelta', Math.abs(diversityDelta)],
      ['energyAcquisitionVariance', energyAcquisitionVariance],
    ];
    for (const [metric, value] of checks) {
      const flag = this.telemetry.checkAnomaly(metric, value);
      if (flag) anomalies.push(flag);
    }

    return {
      timestamp: Date.now(),
      simTime: this.time,
      stepCount: this.stepCount,
      genomeDiversity,
      birthRate,
      deathRate,
      birthDeathRatio,
      diversityDelta,
      spatialEntropy,
      energyAcquisitionVariance,
      morphologicalVarianceByGeneration,
      agentCount: n,
      meanEnergy,
      stddevEnergy,
      anomalies,
      canvasSnapshot: canvasDataUrl,
    };
  }

  private _computeGenomeDiversity(): number {
    const n = this.agents.length;
    if (n < 2) return 0;

    const FEATURES_PER_NODE = 5; // dx, dy, dz, mass, radius
    const MAX_NODES = 7;
    const K = MAX_NODES * FEATURES_PER_NODE;

    const centroid = new Float64Array(K);
    for (const agent of this.agents) {
      const nodes = agent.genome.nodes.slice(0, MAX_NODES);
      for (let i = 0; i < nodes.length; i++) {
        const base = i * FEATURES_PER_NODE;
        centroid[base + 0] += nodes[i].dx;
        centroid[base + 1] += nodes[i].dy;
        centroid[base + 2] += nodes[i].dz;
        centroid[base + 3] += nodes[i].mass;
        centroid[base + 4] += nodes[i].radius;
      }
    }
    for (let j = 0; j < K; j++) centroid[j] /= n;

    let totalDist = 0;
    for (const agent of this.agents) {
      const nodes = agent.genome.nodes.slice(0, MAX_NODES);
      let distSq = 0;
      for (let i = 0; i < nodes.length; i++) {
        const base = i * FEATURES_PER_NODE;
        distSq += (nodes[i].dx    - centroid[base + 0]) ** 2;
        distSq += (nodes[i].dy    - centroid[base + 1]) ** 2;
        distSq += (nodes[i].dz    - centroid[base + 2]) ** 2;
        distSq += (nodes[i].mass  - centroid[base + 3]) ** 2;
        distSq += (nodes[i].radius - centroid[base + 4]) ** 2;
      }
      totalDist += Math.sqrt(distSq);
    }
    return totalDist / n;
  }

  private _computeSpatialEntropy(): number {
    const n = this.agents.length;
    if (n === 0) return 0;

    const cells = new Float64Array(GRID_SIZE * GRID_SIZE);
    const scaleX = GRID_SIZE / this.worldWidth;
    const scaleZ = GRID_SIZE / this.worldDepth;

    for (const agent of this.agents) {
      const c = agent.centerPos;
      const gx = Math.min(GRID_SIZE - 1, Math.floor(c.x * scaleX));
      const gz = Math.min(GRID_SIZE - 1, Math.floor(c.z * scaleZ));
      cells[gz * GRID_SIZE + gx]++;
    }

    let entropy = 0;
    for (let i = 0; i < cells.length; i++) {
      if (cells[i] > 0) {
        const p = cells[i] / n;
        entropy -= p * Math.log2(p);
      }
    }
    return entropy;
  }

  private _computeEnergyAcquisitionVariance(): number {
    const n = this.agents.length;
    if (n < 2) return 0;

    let sum = 0;
    for (const agent of this.agents) {
      sum += this._frameEnergyGained.get(agent.id) ?? 0;
    }
    const mean = sum / n;

    let varSum = 0;
    for (const agent of this.agents) {
      const gained = this._frameEnergyGained.get(agent.id) ?? 0;
      varSum += (gained - mean) ** 2;
    }
    return varSum / n;
  }

  private _computeMorphologicalVarianceByGeneration(): GenerationVarianceBucket[] {
    const FEATURES_PER_NODE = 5;
    const MAX_NODES = 7;
    const K = MAX_NODES * FEATURES_PER_NODE;

    const bucketDefs: Array<[string, number, number]> = [
      ['0–9',   0,  10],
      ['10–19', 10, 20],
      ['20–49', 20, 50],
      ['50+',   50, Infinity],
    ];

    const results: GenerationVarianceBucket[] = [];

    for (const [label, minGen, maxGen] of bucketDefs) {
      const bucket = this.agents.filter(
        a => a.generation >= minGen && a.generation < maxGen,
      );
      if (bucket.length < 2) {
        results.push({ label, agentCount: bucket.length, morphVariance: 0 });
        continue;
      }

      const centroid = new Float64Array(K);
      for (const agent of bucket) {
        const nodes = agent.genome.nodes.slice(0, MAX_NODES);
        for (let i = 0; i < nodes.length; i++) {
          const base = i * FEATURES_PER_NODE;
          centroid[base + 0] += nodes[i].dx;
          centroid[base + 1] += nodes[i].dy;
          centroid[base + 2] += nodes[i].dz;
          centroid[base + 3] += nodes[i].mass;
          centroid[base + 4] += nodes[i].radius;
        }
      }
      for (let j = 0; j < K; j++) centroid[j] /= bucket.length;

      let totalDist = 0;
      for (const agent of bucket) {
        const nodes = agent.genome.nodes.slice(0, MAX_NODES);
        let distSq = 0;
        for (let i = 0; i < nodes.length; i++) {
          const base = i * FEATURES_PER_NODE;
          distSq += (nodes[i].dx    - centroid[base + 0]) ** 2;
          distSq += (nodes[i].dy    - centroid[base + 1]) ** 2;
          distSq += (nodes[i].dz    - centroid[base + 2]) ** 2;
          distSq += (nodes[i].mass  - centroid[base + 3]) ** 2;
          distSq += (nodes[i].radius - centroid[base + 4]) ** 2;
        }
        totalDist += Math.sqrt(distSq);
      }

      results.push({
        label,
        agentCount: bucket.length,
        morphVariance: totalDist / bucket.length,
      });
    }

    return results;
  }

  get stats() {
    const gens = this.agents.map(a => a.generation);
    return {
      agentCount: this.agents.length,
      time: this.time,
      maxGeneration: gens.length ? Math.max(...gens) : 0,
      avgEnergy: this.agents.length
        ? this.agents.reduce((s, a) => s + a.energy, 0) / this.agents.length
        : 0,
    };
  }
}
