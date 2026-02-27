import { Agent } from '../agent/Agent';
import { Genome, ArchetypeName } from '../agent/Genome';
import { Environment } from './Environment';
import { Heightfield } from './Heightfield';
import { SpatialHash, COLLISION_CELL_SIZE } from './SpatialHash';

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

/**
 * Individual sub-scores that feed into ComplexityScore.
 * Always logged even when gates fail, so callers can diagnose which
 * dimension is holding back the aggregate.
 */
export interface ComplexitySubScores {
  /** High diversity sustained over time (genomeDiversity high, |diversityDelta| low). [0,1] */
  diversityScore: number;
  /** birthDeathRatio near 1 — bell curve centred at 1.0. [0,1] */
  stabilityScore: number;
  /** Agents spread across the world (spatialEntropy / log2(16×16)). [0,1] */
  spatialScore: number;
  /** High variance in energy acquisition — different strategies succeeding. [0,1] */
  varianceScore: number;
  /** Lineages persisting — maxGeneration still growing. [0,1] */
  generationScore: number;
  /** True if both hard gates (birthDeathRatio band + maxGeneration growth) passed. */
  gatesPassed: boolean;
  /** Hard gate: birthDeathRatio ∈ [0.85, 1.15]. */
  gateBirthDeath: boolean;
  /** Hard gate: maxGeneration has increased over the last 10 snapshots (~10 min). */
  gateGenerationGrowth: boolean;
}

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

  // ── Complexity score ────────────────────────────────────────────────────────
  // null when either hard gate fails (birthDeathRatio out of band or lineages stalling).
  // Null is reported explicitly — a misleading zero would be worse than no value.
  complexityScore: number | null;
  /** All six sub-scores, always present regardless of gate status. */
  complexitySubScores: ComplexitySubScores;
  /**
   * Variance of the last ≤10 non-null complexityScore values.
   * A near-critical system should *fluctuate*; a flatline at 0.7 is boring.
   */
  complexityScoreVariance: number;
  /**
   * Lag-1 autocorrelation of the last ≤10 non-null complexityScore values.
   * High positive → score is trending; near zero → irregular fluctuation.
   */
  complexityScoreAutocorrelation: number;

  // Population basics
  agentCount: number;
  meanEnergy: number;
  stddevEnergy: number;

  // Anomaly flags — fires when a metric deviates beyond threshold from baseline
  anomalies: AnomalyFlag[];

  // Active config values — ties every snapshot to the parameters that produced it
  config: WorldConfig;

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
// Max log2 of GRID_SIZE × GRID_SIZE — used to normalise spatialEntropy to [0,1]
const MAX_SPATIAL_ENTROPY = Math.log2(GRID_SIZE * GRID_SIZE); // 8.0

// Number of snapshots to retain for maxGeneration gate check (~10 minutes at 60 s/snapshot)
const MAX_GEN_HISTORY_LEN = 10;

// Number of complexity score values to retain for variance / autocorrelation
const SCORE_HISTORY_LEN = 10;

// Hard gates for ComplexityScore
const BIRTH_DEATH_GATE_LO = 0.85;
const BIRTH_DEATH_GATE_HI = 1.15;

// ── Kinship interaction constants ─────────────────────────────────────────────

/**
 * XZ radius within which two agents can sense each other's kinship.
 * Chosen to be roughly 2–3× a typical agent's bounding radius so that
 * adjacent agents in the same feeding patch will interact.
 */
const KINSHIP_INTERACT_RADIUS = 120;

/**
 * Minimum kinship score required for cooperative energy transfer to occur.
 * Below this threshold the two agents are too genetically distant to be
 * considered kin — no transfer happens.
 *
 * At KINSHIP_SCALE = 35 (parent→child distance):
 *   kinship ≈ 0.37 for a first-generation child
 *   kinship ≈ 0.14 for a grandchild
 *   threshold 0.25 ≈ ~1.4 generations of drift
 */
const KINSHIP_THRESHOLD = 0.25;

/**
 * Fraction of the energy difference transferred per tick.
 * Kept small so the effect is a gentle pressure toward equalisation, not
 * an instant levelling of energy across a kin cluster.
 *
 * At 60 Hz and a difference of 100 energy units:
 *   transfer = 100 × 0.04 × kinship ≤ 4 units/tick  (bounded by kinship < 1)
 */
const KINSHIP_TRANSFER_RATE = 0.04;

// ── Inter-agent collision constants ───────────────────────────────────────────

/**
 * Stiffness of the repulsion force applied when nodes from different agents
 * overlap.  Kept lower than intra-agent spring stiffness (150–550) to avoid
 * violent impulses when agents collide at speed.
 *
 * Value chosen so a head-on overlap of one full node radius (≈ 6 units)
 * produces a force comparable to a mid-stiffness muscle spring.
 */
const INTER_AGENT_REPULSION_STIFFNESS = 120;

// ── Archetype seeding constants ───────────────────────────────────────────────

/**
 * Fraction of generation-0 agents that are seeded from archetypes.
 * The rest are random as before so morphospace exploration isn't fully
 * constrained to archetype basins from the start.
 *
 * With DEFAULT_CONFIG.initialAgents = 16:
 *   floor(16 × 0.625) = 10 archetype agents
 *   6 random agents
 *
 * The archetypes are drawn round-robin across the three types so each
 * type is represented roughly equally.
 */
const ARCHETYPE_SEED_FRACTION = 0.625;

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

  // Rolling history of maxGeneration at each snapshot — for the gate check
  private _maxGenHistory: number[] = [];

  // Rolling history of non-null complexity scores — for variance / autocorrelation
  private _scoreHistory: number[] = [];

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

  /**
   * Record maxGeneration at snapshot time.
   * Returns true if maxGeneration has strictly increased over the retention window
   * (i.e. at least one value in the history is lower than the current value).
   */
  recordMaxGeneration(value: number): boolean {
    this._maxGenHistory.push(value);
    if (this._maxGenHistory.length > MAX_GEN_HISTORY_LEN) {
      this._maxGenHistory.shift();
    }
    if (this._maxGenHistory.length < 2) return true; // not enough data — give benefit of doubt
    const earliest = this._maxGenHistory[0];
    return value > earliest;
  }

  /**
   * Record a non-null complexity score.
   * Returns { variance, autocorrelation } over the rolling window.
   */
  recordComplexityScore(score: number): { variance: number; autocorrelation: number } {
    this._scoreHistory.push(score);
    if (this._scoreHistory.length > SCORE_HISTORY_LEN) {
      this._scoreHistory.shift();
    }
    return {
      variance: this._computeScoreVariance(),
      autocorrelation: this._computeScoreAutocorrelation(),
    };
  }

  /**
   * Returns the latest variance / autocorrelation values (for null-score snapshots
   * where we still want to report the rolling stats from prior snapshots).
   */
  getScoreStats(): { variance: number; autocorrelation: number } {
    return {
      variance: this._computeScoreVariance(),
      autocorrelation: this._computeScoreAutocorrelation(),
    };
  }

  private _computeScoreVariance(): number {
    const h = this._scoreHistory;
    const n = h.length;
    if (n < 2) return 0;
    const mean = h.reduce((s, v) => s + v, 0) / n;
    return h.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
  }

  private _computeScoreAutocorrelation(): number {
    // Lag-1 Pearson correlation between h[0..n-2] and h[1..n-1]
    const h = this._scoreHistory;
    const n = h.length;
    if (n < 3) return 0;

    const x = h.slice(0, n - 1);
    const y = h.slice(1, n);
    const m = x.length;

    const meanX = x.reduce((s, v) => s + v, 0) / m;
    const meanY = y.reduce((s, v) => s + v, 0) / m;

    let num = 0, varX = 0, varY = 0;
    for (let i = 0; i < m; i++) {
      const dx = x[i] - meanX;
      const dy = y[i] - meanY;
      num += dx * dy;
      varX += dx * dx;
      varY += dy * dy;
    }
    const denom = Math.sqrt(varX * varY);
    return denom < 1e-9 ? 0 : num / denom;
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

  /** Active configuration — stored so it can be included in every snapshot. */
  readonly config: WorldConfig;

  // Phylogeny log: [childId, parentId, generation, birthTime]
  lineageLog: Array<[number, number | null, number, number]> = [];

  readonly telemetry: TelemetryTracker = new TelemetryTracker();

  // Per-agent energy gained in the current frame (keyed by agent id)
  // Used to compute energy-acquisition variance for the crowding diagnostic
  private _frameEnergyGained: Map<number, number> = new Map();

  /**
   * Reusable spatial hash for inter-agent collision broad phase.
   * Rebuilt each frame — clear() + insert is O(total_nodes).
   * Cell size: see SpatialHash.ts for tuning notes.
   */
  private _collisionHash: SpatialHash = new SpatialHash(COLLISION_CELL_SIZE);

  constructor(cfg: WorldConfig) {
    this.config = cfg;
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

    this._seedInitialPopulation(cfg.initialAgents);
  }

  /**
   * Seed the generation-0 population with a mix of archetype genomes and
   * random genomes.  Archetypes are guaranteed to have functional body plans
   * that can locomote; random genomes fill the remainder to preserve
   * morphospace exploration.
   *
   * Archetype fraction: ARCHETYPE_SEED_FRACTION of initialAgents, rounded down.
   * The archetypes cycle round-robin across worm / quad / tripod so each type
   * is seeded at roughly equal frequency.
   */
  private _seedInitialPopulation(count: number): void {
    const archetypeCount = Math.floor(count * ARCHETYPE_SEED_FRACTION);
    const archetypeNames: ArchetypeName[] = ['worm', 'quad', 'tripod'];

    for (let i = 0; i < archetypeCount; i++) {
      const name = archetypeNames[i % archetypeNames.length];
      this._spawn(Genome.archetype(name));
    }

    for (let i = archetypeCount; i < count; i++) {
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

  /**
   * Deposit a corpse energy depot for a dying agent if it has meaningful energy.
   * The corpse is placed at ground level directly below the agent's centre
   * so that ground-level scavengers can reach it without needing height.
   */
  private _depositCorpse(agent: Agent): void {
    const c = agent.centerPos;
    const groundY = this.heightfield.heightAt(c.x, c.z);
    this.env.addCorpse(c.x, groundY, c.z, agent.energy);
  }

  /**
   * Pick a spawn position for an offspring: a random direction from the
   * parent's centre at 80–120 world units, clamped to world bounds.
   * Returns [spawnX, spawnY, spawnZ] where spawnY is the terrain height.
   *
   * This deliberately scatters children well outside the parent's body
   * (body radius ~25–50 units) to prevent blob pile-ups where offspring
   * are born on top of each other and never disperse.
   */
  private _offspringSpawn(parent: Agent): [number, number, number] {
    const c = parent.centerPos;
    const angle = Math.random() * Math.PI * 2;
    const dist  = 80 + Math.random() * 40;          // 80–120 units
    const margin = 40;
    const sx = Math.max(margin, Math.min(this.worldWidth  - margin, c.x + Math.cos(angle) * dist));
    const sz = Math.max(margin, Math.min(this.worldDepth - margin, c.z + Math.sin(angle) * dist));
    const sy = this.heightfield.heightAt(sx, sz);
    return [sx, sy, sz];
  }

  /**
   * Return the live agent with the lowest energy, excluding the given id.
   * Used for competitive displacement: when a fit agent reproduces into a
   * full world, the weakest incumbent is evicted to make room.
   */
  private _weakestLiveAgent(excludeId: number): Agent | null {
    let weakest: Agent | null = null;
    let minEnergy = Infinity;
    for (const a of this.agents) {
      if (a.dead || a.id === excludeId) continue;
      if (a.energy < minEnergy) {
        minEnergy = a.energy;
        weakest = a;
      }
    }
    return weakest;
  }

  /**
   * Apply local kin-selection cooperative energy transfer.
   *
   * For each live pair of agents within KINSHIP_INTERACT_RADIUS (XZ plane),
   * compute their genome kinship score.  If it exceeds KINSHIP_THRESHOLD, the
   * richer agent transfers a small fraction of the energy difference to the
   * poorer kin — cooperative resource-sharing driven by genetic relatedness.
   *
   * Complexity: O(n²) in agent count, but n ≤ maxAgents (60) so the worst case
   * is ~1 800 pairwise checks per tick — negligible vs. physics.
   */
  private _applyKinshipInteractions(): void {
    const n = this.agents.length;
    if (n < 2) return;

    const radiusSq = KINSHIP_INTERACT_RADIUS * KINSHIP_INTERACT_RADIUS;

    for (let i = 0; i < n; i++) {
      const a = this.agents[i];
      const ca = a.centerPos;

      for (let j = i + 1; j < n; j++) {
        const b = this.agents[j];
        const cb = b.centerPos;

        const dx = ca.x - cb.x;
        const dz = ca.z - cb.z;
        if (dx * dx + dz * dz > radiusSq) continue;

        const k = Genome.kinship(a.genome, b.genome);
        if (k < KINSHIP_THRESHOLD) continue;

        const diff = a.energy - b.energy;
        if (Math.abs(diff) < 1) continue;

        const transfer = diff * k * KINSHIP_TRANSFER_RATE;
        a.energy -= transfer;
        b.energy += transfer;

        if (a.energy < 0) { b.energy += a.energy; a.energy = 0; }
        if (b.energy < 0) { a.energy += b.energy; b.energy = 0; }
        a.energy = Math.min(300, a.energy);
        b.energy = Math.min(300, b.energy);
      }
    }
  }

  /**
   * Apply sphere-sphere repulsion between nodes belonging to *different* agents.
   *
   * Uses a spatial hash for the broad phase so the effective cost is O(n × k)
   * where k is the average number of nodes per hash cell (typically 1–3 at
   * target densities) rather than O(n²) over all node pairs.
   *
   * Physics: when two nodes from different agents overlap (distance < r_a + r_b),
   * a linear repulsion force is applied along the separation axis — identical
   * in form to a zero-rest-length spring.  This pushes agents out of each other
   * without any attraction, creating clean physical exclusion.
   *
   * Energy is not deducted for inter-agent repulsion (it is a contact normal
   * force, not a metabolic cost).
   */
  private _applyInterAgentCollision(): void {
    if (this.agents.length < 2) return;

    // ── Build spatial hash ────────────────────────────────────────────────────
    this._collisionHash.clear();
    for (const agent of this.agents) {
      for (const node of agent.nodes) {
        this._collisionHash.insert(node, agent.id);
      }
    }

    // ── Narrow phase: repulsion ───────────────────────────────────────────────
    for (const agent of this.agents) {
      for (const nodeA of agent.nodes) {
        // Query radius = max possible sum of two node radii.
        // Node radii range ~4–9 so 18 is a safe upper bound for the query.
        const queryR = 18;
        const candidates = this._collisionHash.query(nodeA.pos.x, nodeA.pos.z, queryR);

        for (const { node: nodeB, agentId: bId } of candidates) {
          // Only collide nodes from different agents
          if (bId === agent.id) continue;
          // Avoid double-counting: only process pair once (lower agent id acts)
          // We can't easily enforce this with the hash, so we apply half-force
          // to each side (Newton's third law is satisfied by symmetry).

          const dx = nodeB.pos.x - nodeA.pos.x;
          const dy = nodeB.pos.y - nodeA.pos.y;
          const dz = nodeB.pos.z - nodeA.pos.z;
          const distSq = dx * dx + dy * dy + dz * dz;
          const minDist = nodeA.radius + nodeB.radius;

          if (distSq >= minDist * minDist || distSq < 1e-9) continue;

          const dist = Math.sqrt(distSq);
          const overlap = minDist - dist;
          const invDist = 1 / dist;

          // Repulsion magnitude proportional to overlap (linear spring, zero rest length)
          const forceMag = overlap * INTER_AGENT_REPULSION_STIFFNESS;

          // Normalised separation axis (A → B direction = push B away from A)
          const nx = dx * invDist;
          const ny = dy * invDist;
          const nz = dz * invDist;

          // Apply equal and opposite forces.
          // Half to each side so we don't double-apply when we encounter the
          // symmetric pair (nodeB's agent will also process this pair).
          const halfF = forceMag * 0.5;

          nodeA.acc.x -= (halfF * nx) / nodeA.mass;
          nodeA.acc.y -= (halfF * ny) / nodeA.mass;
          nodeA.acc.z -= (halfF * nz) / nodeA.mass;

          nodeB.acc.x += (halfF * nx) / nodeB.mass;
          nodeB.acc.y += (halfF * ny) / nodeB.mass;
          nodeB.acc.z += (halfF * nz) / nodeB.mass;
        }
      }
    }
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

      // Max lifespan: forces generational turnover.
      // 60s (down from 180s) tightens the selection cycle ~3×.
      if (agent.age > 60) {
        this._depositCorpse(agent);
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

      // Energy harvesting: each node that overlaps a zone or corpse absorbs energy
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

      // Energy decay: surplus above 200 bleeds off at 3 % per second.
      // Prevents passive hoarding — a sitter capped at 300 loses 3 energy/s
      // of surplus, so staying well-fed requires ongoing harvesting rather
      // than a one-time fill.
      if (agent.energy > 200) {
        agent.energy -= (agent.energy - 200) * 0.03 * dt;
      }

      // Reproduction — competitive displacement when at capacity.
      // If there is a free slot, birth normally.  If the world is full,
      // kill the weakest live agent to make room — energy directly translates
      // to survival rather than the arbitrary lifespan timer being the only
      // selection pressure.
      if (agent.canReproduce()) {
        if (liveCount + offspring.length < this.maxAgents) {
          const [sx, sy, sz] = this._offspringSpawn(agent);
          const child = agent.reproduce(sx, sy, sz);
          offspring.push(child);
          this.lineageLog.push([child.id, child.parentId, child.generation, child.birthTime]);
          this.telemetry.recordBirth();
          // liveCount unchanged: no existing agent died
        } else {
          const victim = this._weakestLiveAgent(agent.id);
          if (victim) {
            // No corpse for displaced agents — their energy dissipates.
            // Conservation of energy: only natural deaths (lifespan / starvation)
            // leave harvestable corpses.  Depositing energy here would let clusters
            // sustain themselves by eating each other's corpses, bypassing food zones.
            victim.dead = true;
            liveCount--;
            this.telemetry.recordDeath();
            const [sx, sy, sz] = this._offspringSpawn(agent);
            const child = agent.reproduce(sx, sy, sz);
            offspring.push(child);
            this.lineageLog.push([child.id, child.parentId, child.generation, child.birthTime]);
            this.telemetry.recordBirth();
            // liveCount net change: -1 death +1 birth = 0
          }
        }
      }
    }

    this.agents = this.agents.filter(a => !a.dead);
    this.agents.push(...offspring);

    // Reseed if population crashes — use random genomes only (not archetypes)
    // so post-crash recovery can explore novel morphologies.
    if (this.agents.length < 4) {
      const toAdd = Math.min(6, this.maxAgents - this.agents.length);
      for (let i = 0; i < toAdd; i++) {
        this._spawn(Genome.random());
      }
    }

    // Kinship interactions: kin-selection cooperative energy transfer.
    // Runs after all births/deaths are resolved so the live agent list is stable.
    this._applyKinshipInteractions();

    // Inter-agent collision: sphere-sphere repulsion between nodes on different
    // agents.  Runs after agent.update() (which accumulates spring forces and
    // gravity) so collision repulsion is added on top of intra-agent forces,
    // then integration happens inside each agent's own update call.
    //
    // NOTE: agent.update() integrates its own nodes, so inter-agent forces
    // added here are applied *next* frame via accumulated acc.  This one-frame
    // lag is acceptable at 60 Hz and avoids restructuring the update loop.
    this._applyInterAgentCollision();

    // Update rolling diversity history every frame (cheap: O(nk))
    const diversity = this._computeGenomeDiversity();
    this.telemetry.recordDiversity(diversity);
  }

  // ── Telemetry snapshot ────────────────────────────────────────────────────────

  captureSnapshot(canvasDataUrl?: string): TelemetrySnapshot {
    const n = this.agents.length;

    const genomeDiversity = this._computeGenomeDiversity();

    const birthRate = this.telemetry.birthRate;
    const deathRate = this.telemetry.deathRate;
    const birthDeathRatio = deathRate < 1e-6 ? birthRate : birthRate / deathRate;

    const diversityDelta = this.telemetry.diversityDeltaSinceLastSnapshot;
    this.telemetry.markSnapshotDiversity(genomeDiversity);

    const spatialEntropy = this._computeSpatialEntropy();
    const energyAcquisitionVariance = this._computeEnergyAcquisitionVariance();
    const morphologicalVarianceByGeneration = this._computeMorphologicalVarianceByGeneration();

    let meanEnergy = 0;
    for (const a of this.agents) meanEnergy += a.energy;
    if (n > 0) meanEnergy /= n;

    let variance = 0;
    for (const a of this.agents) variance += (a.energy - meanEnergy) ** 2;
    const stddevEnergy = n > 1 ? Math.sqrt(variance / n) : 0;

    const gens = this.agents.map(a => a.generation);
    const maxGeneration = gens.length ? Math.max(...gens) : 0;

    const maxGenGrowing = this.telemetry.recordMaxGeneration(maxGeneration);
    const birthDeathInBand =
      birthDeathRatio >= BIRTH_DEATH_GATE_LO &&
      birthDeathRatio <= BIRTH_DEATH_GATE_HI;

    const subScores = this._computeComplexitySubScores(
      genomeDiversity,
      diversityDelta,
      birthDeathRatio,
      spatialEntropy,
      energyAcquisitionVariance,
      maxGeneration,
      birthDeathInBand,
      maxGenGrowing,
    );

    let complexityScore: number | null = null;
    let complexityScoreVariance = 0;
    let complexityScoreAutocorrelation = 0;

    if (subScores.gatesPassed) {
      const { diversityScore, stabilityScore, spatialScore, varianceScore, generationScore } = subScores;
      const FLOOR = 0.001;
      const product =
        Math.max(FLOOR, diversityScore) *
        Math.max(FLOOR, stabilityScore) *
        Math.max(FLOOR, spatialScore) *
        Math.max(FLOOR, varianceScore) *
        Math.max(FLOOR, generationScore);
      complexityScore = Math.pow(product, 1 / 5);

      const stats = this.telemetry.recordComplexityScore(complexityScore);
      complexityScoreVariance = stats.variance;
      complexityScoreAutocorrelation = stats.autocorrelation;
    } else {
      const stats = this.telemetry.getScoreStats();
      complexityScoreVariance = stats.variance;
      complexityScoreAutocorrelation = stats.autocorrelation;
    }

    const anomalies: AnomalyFlag[] = [];
    const checks: Array<[string, number]> = [
      ['genomeDiversity', genomeDiversity],
      ['birthDeathRatio', birthDeathRatio],
      ['spatialEntropy', spatialEntropy],
      ['meanEnergy', meanEnergy],
      ['diversityDelta', Math.abs(diversityDelta)],
      ['energyAcquisitionVariance', energyAcquisitionVariance],
    ];
    if (complexityScore !== null) {
      checks.push(['complexityScore', complexityScore]);
    }
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
      complexityScore,
      complexitySubScores: subScores,
      complexityScoreVariance,
      complexityScoreAutocorrelation,
      agentCount: n,
      meanEnergy,
      stddevEnergy,
      anomalies,
      config: { ...this.config },
      canvasSnapshot: canvasDataUrl,
    };
  }

  // ── Complexity sub-scores ─────────────────────────────────────────────────────

  private _computeComplexitySubScores(
    genomeDiversity: number,
    diversityDelta: number,
    birthDeathRatio: number,
    spatialEntropy: number,
    energyAcquisitionVariance: number,
    maxGeneration: number,
    birthDeathInBand: boolean,
    maxGenGrowing: boolean,
  ): ComplexitySubScores {
    const gatesPassed = birthDeathInBand && maxGenGrowing;

    const diversityMagnitude = 1 - Math.exp(-genomeDiversity / 50);
    const deltaStability = Math.exp(-Math.abs(diversityDelta) / 8);
    const diversityScore = diversityMagnitude * deltaStability;

    const _t = (birthDeathRatio - 1.0) / 0.2;
    const stabilityScore = Math.exp(-(_t * _t));

    const spatialScore = Math.min(1, spatialEntropy / MAX_SPATIAL_ENTROPY);

    const varianceScore = Math.tanh(energyAcquisitionVariance / 100);

    const generationScore = Math.tanh(maxGeneration / 15);

    return {
      diversityScore,
      stabilityScore,
      spatialScore,
      varianceScore,
      generationScore,
      gatesPassed,
      gateBirthDeath: birthDeathInBand,
      gateGenerationGrowth: maxGenGrowing,
    };
  }

  // ── Private metrics ───────────────────────────────────────────────────────────

  private _computeGenomeDiversity(): number {
    const n = this.agents.length;
    if (n < 2) return 0;

    const FEATURES_PER_NODE = 5;
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