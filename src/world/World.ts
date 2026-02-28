import { Agent } from '../agent/Agent';
import { Genome, ArchetypeName } from '../agent/Genome';
import { Environment } from './Environment';
import { Heightfield } from './Heightfield';
import { PhysicsNode } from '../physics/PhysicsNode';
import { Prop, PROP_TYPES, PROP_TYPE_CONFIGS } from './Prop';
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
  heightfieldAmplitude: 35,
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

const KINSHIP_INTERACT_RADIUS = 120;
const KINSHIP_THRESHOLD = 0.25;
const KINSHIP_TRANSFER_RATE = 0.04;

// ── Inter-agent collision constants ───────────────────────────────────────────

const INTER_AGENT_REPULSION_STIFFNESS = 120;

// ── Archetype seeding constants ───────────────────────────────────────────────

const ARCHETYPE_SEED_FRACTION = 0.625;

// ── Chemical signal constants (Proposal #5) ───────────────────────────────────

/**
 * Maximum XZ radius within which an agent can sense chemical signal from others.
 *
 * Agents outside this radius contribute nothing to the local concentration.
 * Chosen to be roughly one typical foraging radius (~150 units) so signal
 * range matches the spatial scale of food-finding behaviour.
 */
const CHEM_SENSE_RADIUS = 200;

/**
 * Distance falloff scale for the chemical concentration formula.
 *
 * Local concentration from a single emitter at distance d:
 *   contribution = emissionRate / (d + CHEM_FALLOFF_SCALE)
 *
 * At d=0 (on top of the emitter): contribution = rate / CHEM_FALLOFF_SCALE
 * At d=CHEM_FALLOFF_SCALE (50 units away): contribution = rate / 100 (half)
 *
 * This is a fast inverse-distance falloff — no grid, no diffusion pass,
 * derived purely from the existing agent positions each tick.
 * Consensus (Systems Engineer): profile spatial-query approximation first;
 * only add persistent grid if this proves qualitatively insufficient.
 */
const CHEM_FALLOFF_SCALE = 50;

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

  recordMaxGeneration(value: number): boolean {
    this._maxGenHistory.push(value);
    if (this._maxGenHistory.length > MAX_GEN_HISTORY_LEN) {
      this._maxGenHistory.shift();
    }
    if (this._maxGenHistory.length < 2) return true;
    const earliest = this._maxGenHistory[0];
    return value > earliest;
  }

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
    if (b.values.length > 50) b.values.shift();

    const n = b.values.length;
    if (n < 5) return null;

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

// ── Prop manipulation constants ───────────────────────────────────────────────

const PROP_COUNT = 40;
const GRAB_RANGE = 25;
const GRAB_STIFFNESS = 180;
const MAX_GRABS_PER_AGENT = 2;
const CONNECT_RANGE = 80;
const CONNECT_STIFFNESS = 120;

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

  /** Manipulable environmental objects agents can grab, connect, and release. */
  props: Prop[] = [];

  private _grabSprings: Array<{
    prop: Prop;
    agentNode: PhysicsNode;
    agentId: number;
  }> = [];

  private _propConnections: Array<{
    propA: Prop;
    propB: Prop;
    restLength: number;
  }> = [];

  /** Active configuration — stored so it can be included in every snapshot. */
  readonly config: WorldConfig;

  // Phylogeny log: [childId, parentId, generation, birthTime]
  lineageLog: Array<[number, number | null, number, number]> = [];

  readonly telemetry: TelemetryTracker = new TelemetryTracker();

  // Per-agent energy gained in the current frame (keyed by agent id)
  private _frameEnergyGained: Map<number, number> = new Map();

  private _collisionHash: SpatialHash = new SpatialHash(COLLISION_CELL_SIZE);

  constructor(cfg: WorldConfig) {
    this.config = cfg;
    this.worldWidth = cfg.worldWidth;
    this.worldDepth = cfg.worldDepth;
    this.maxAgents = cfg.maxAgents;
    this.heightfield = new Heightfield(
      cfg.worldWidth,
      cfg.worldDepth,
      cfg.heightfieldResolution ?? 64,
      cfg.heightfieldAmplitude ?? 60,
    );

    this.env = new Environment(
      cfg.worldWidth,
      cfg.worldDepth,
      cfg.zoneCount,
      (x, z) => this.heightfield.heightAt(x, z),
    );

    this._initProps();
    this._seedInitialPopulation(cfg.initialAgents);
  }

  private _seedInitialPopulation(count: number): void {
    const archetypeCount = Math.floor(count * ARCHETYPE_SEED_FRACTION);
    const archetypeNames: ArchetypeName[] = ['worm', 'quad', 'tripod'];

    for (let i = 0; i < archetypeCount; i++) {
      const name = archetypeNames[i % archetypeNames.length];
      this._spawn(Genome.archetype(name), undefined, Math.random() * 45);
    }

    for (let i = archetypeCount; i < count; i++) {
      this._spawn(Genome.random(), undefined, Math.random() * 45);
    }
  }

  private _spawn(genome: Genome, parentAgent?: Agent, preAge = 0): Agent {
    const x = 50 + Math.random() * (this.worldWidth - 100);
    const z = 50 + Math.random() * (this.worldDepth - 100);
    const groundY = this.heightfield.heightAt(x, z);
    const a = new Agent(
      genome,
      x,
      groundY,
      z,
      parentAgent?.generation ?? 0,
      parentAgent?.id ?? null,
      parentAgent?.hue ?? Math.random() * 360,
    );
    a.age = preAge;
    this.agents.push(a);
    this.lineageLog.push([a.id, a.parentId, a.generation, a.birthTime]);
    return a;
  }

  private _depositCorpse(agent: Agent): void {
    const c = agent.centerPos;
    const groundY = this.heightfield.heightAt(c.x, c.z);
    this.env.addCorpse(c.x, groundY, c.z, agent.energy);
  }

  private _offspringSpawn(parent: Agent): [number, number, number] {
    const c = parent.centerPos;
    const angle = Math.random() * Math.PI * 2;
    const dist  = 80 + Math.random() * 40;
    const margin = 40;
    const sx = Math.max(margin, Math.min(this.worldWidth  - margin, c.x + Math.cos(angle) * dist));
    const sz = Math.max(margin, Math.min(this.worldDepth - margin, c.z + Math.sin(angle) * dist));
    const sy = this.heightfield.heightAt(sx, sz);
    return [sx, sy, sz];
  }

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

  // ── Chemical signal layer (Proposal #5) ──────────────────────────────────────

  /**
   * Compute local chemical concentration for every live agent using the
   * spatial-query approximation.
   *
   * For each agent A, sums contributions from all other live agents B within
   * CHEM_SENSE_RADIUS, weighted by inverse XZ distance with a falloff scale:
   *
   *   concentration_A += B.genome.chemEmissionRate / (dist_AB + CHEM_FALLOFF_SCALE)
   *
   * Architecture rationale (Proposal #5 consensus, Systems Engineer):
   *   - No persistent diffusion grid is maintained.
   *   - The "field" is a derived quantity computed on demand each tick.
   *   - Signal does not persist after its emitter moves — this trades spatial
   *     history for zero grid overhead.
   *   - If territory-marking behavior requires persistence, a grid can be
   *     added later; for aggregation and gradient-following emergence this
   *     approximation is architecturally simpler.
   *
   * Complexity: O(n²) in agent count.  With n ≤ 60, worst case is 3 540
   * pairwise checks per tick — negligible vs. spring physics.
   *
   * Signal is shared across ALL agents regardless of lineage (single shared
   * field, not species-private channels).  Cross-lineage exploitation (e.g.
   * predators following prey signals) is an emergent property to observe,
   * not to design around.
   */
  private _computeChemicalConcentrations(): void {
    const n = this.agents.length;
    if (n < 2) {
      // Single agent — nothing to sense
      for (const a of this.agents) a.localChemConcentration = 0;
      return;
    }

    const radiusSq = CHEM_SENSE_RADIUS * CHEM_SENSE_RADIUS;

    for (let i = 0; i < n; i++) {
      const agentA = this.agents[i];
      if (agentA.dead) {
        agentA.localChemConcentration = 0;
        continue;
      }
      const ca = agentA.centerPos;
      let concentration = 0;

      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        const agentB = this.agents[j];
        if (agentB.dead) continue;

        // Skip emitters with zero (or near-zero) rate — contributes nothing
        if (agentB.genome.chemEmissionRate < 1e-6) continue;

        const cb = agentB.centerPos;
        const dx = ca.x - cb.x;
        const dz = ca.z - cb.z;
        const distSq = dx * dx + dz * dz;

        if (distSq > radiusSq) continue;

        const dist = Math.sqrt(distSq);
        concentration += agentB.genome.chemEmissionRate / (dist + CHEM_FALLOFF_SCALE);
      }

      agentA.localChemConcentration = concentration;
    }
  }

  // ── Prop lifecycle ────────────────────────────────────────────────────────────

  private _initProps(): void {
    for (let i = 0; i < PROP_COUNT; i++) {
      const type = PROP_TYPES[i % PROP_TYPES.length];
      const x = 50 + Math.random() * (this.worldWidth - 100);
      const z = 50 + Math.random() * (this.worldDepth - 100);
      const cfg = PROP_TYPE_CONFIGS[type];
      const groundY = this.heightfield.heightAt(x, z);
      this.props.push(new Prop(type, x, groundY + cfg.radius, z));
    }
  }

  private _applyGrabSprings(): void {
    for (const gs of this._grabSprings) {
      const an = gs.agentNode;
      const pn = gs.prop.node;

      const dx = pn.pos.x - an.pos.x;
      const dy = pn.pos.y - an.pos.y;
      const dz = pn.pos.z - an.pos.z;
      const distSq = dx * dx + dy * dy + dz * dz;
      if (distSq < 1e-9) continue;
      const dist = Math.sqrt(distSq);

      const restLen = an.radius + pn.radius;
      const stretch = dist - restLen;
      if (stretch <= 0) continue;

      const forceMag = stretch * GRAB_STIFFNESS;
      const nx = dx / dist;
      const ny = dy / dist;
      const nz = dz / dist;

      pn.acc.x -= (forceMag * nx) / pn.mass;
      pn.acc.y -= (forceMag * ny) / pn.mass;
      pn.acc.z -= (forceMag * nz) / pn.mass;

      an.acc.x += (forceMag * nx) / an.mass;
      an.acc.y += (forceMag * ny) / an.mass;
      an.acc.z += (forceMag * nz) / an.mass;
    }
  }

  private _applyPropConnections(): void {
    for (const conn of this._propConnections) {
      const pA = conn.propA.node;
      const pB = conn.propB.node;

      const dx = pB.pos.x - pA.pos.x;
      const dy = pB.pos.y - pA.pos.y;
      const dz = pB.pos.z - pA.pos.z;
      const distSq = dx * dx + dy * dy + dz * dz;
      if (distSq < 1e-9) continue;
      const dist = Math.sqrt(distSq);

      const stretch = dist - conn.restLength;
      const forceMag = stretch * CONNECT_STIFFNESS;
      const nx = dx / dist;
      const ny = dy / dist;
      const nz = dz / dist;

      pA.acc.x += (forceMag * nx) / pA.mass;
      pA.acc.y += (forceMag * ny) / pA.mass;
      pA.acc.z += (forceMag * nz) / pA.mass;
      pB.acc.x -= (forceMag * nx) / pB.mass;
      pB.acc.y -= (forceMag * ny) / pB.mass;
      pB.acc.z -= (forceMag * nz) / pB.mass;
    }
  }

  private _updateProps(dt: number): void {
    const G = 600;
    for (const prop of this.props) {
      prop.node.acc.y -= G;
      prop.node.integrate(dt);
      const groundY = this.heightfield.heightAt(prop.node.pos.x, prop.node.pos.z);
      prop.node.constrainToGround(groundY, 0.5, 0.2);
      prop.node.constrainToWorldBounds(0, this.worldWidth, 0, this.worldDepth);
    }
  }

  private _processAgentActions(): void {
    for (const agent of this.agents) {
      if (agent.dead) continue;

      if (agent.lastReleaseAction > 0.5) {
        this._grabSprings = this._grabSprings.filter(gs => {
          if (gs.agentId === agent.id) {
            gs.prop.carriedBy = null;
            return false;
          }
          return true;
        });
      }

      if (agent.lastGrabAction > 0.5) {
        const agentGrabCount = this._grabSprings.filter(gs => gs.agentId === agent.id).length;
        if (agentGrabCount < MAX_GRABS_PER_AGENT) {
          let nearestProp: Prop | null = null;
          let nearestDist = Infinity;
          let nearestNode: PhysicsNode | null = null;

          for (const prop of this.props) {
            if (prop.carriedBy !== null) continue;

            for (const an of agent.nodes) {
              const dx = prop.node.pos.x - an.pos.x;
              const dy = prop.node.pos.y - an.pos.y;
              const dz = prop.node.pos.z - an.pos.z;
              const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
              const threshold = an.radius + prop.node.radius + GRAB_RANGE;
              if (dist < threshold && dist < nearestDist) {
                nearestDist = dist;
                nearestProp = prop;
                nearestNode = an;
              }
            }
          }

          if (nearestProp !== null && nearestNode !== null) {
            nearestProp.carriedBy = agent.id;
            this._grabSprings.push({
              prop: nearestProp,
              agentNode: nearestNode,
              agentId: agent.id,
            });
          }
        }
      }

      if (agent.lastConnectAction > 0.5) {
        const carriedGrabs = this._grabSprings.filter(gs => gs.agentId === agent.id);
        for (let i = 0; i < carriedGrabs.length; i++) {
          for (let j = i + 1; j < carriedGrabs.length; j++) {
            const pA = carriedGrabs[i].prop;
            const pB = carriedGrabs[j].prop;

            const alreadyLinked = this._propConnections.some(
              c => (c.propA === pA && c.propB === pB) || (c.propA === pB && c.propB === pA),
            );
            if (alreadyLinked) continue;

            const dx = pA.node.pos.x - pB.node.pos.x;
            const dy = pA.node.pos.y - pB.node.pos.y;
            const dz = pA.node.pos.z - pB.node.pos.z;
            const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
            if (dist <= CONNECT_RANGE) {
              this._propConnections.push({ propA: pA, propB: pB, restLength: dist });
            }
          }
        }
      }
    }
  }

  private _cleanupDeadAgentGrabs(): void {
    const liveIds = new Set(this.agents.map(a => a.id));
    this._grabSprings = this._grabSprings.filter(gs => {
      if (!liveIds.has(gs.agentId)) {
        gs.prop.carriedBy = null;
        return false;
      }
      return true;
    });
  }

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

  private _applyInterAgentCollision(): void {
    if (this.agents.length < 2) return;

    for (const agent of this.agents) {
      for (const node of agent.nodes) {
        node.interAgentImpulse = 0;
      }
    }

    this._collisionHash.clear();
    for (const agent of this.agents) {
      for (const node of agent.nodes) {
        this._collisionHash.insert(node, agent.id);
      }
    }

    for (const agent of this.agents) {
      for (const nodeA of agent.nodes) {
        const queryR = 18;
        const candidates = this._collisionHash.query(nodeA.pos.x, nodeA.pos.z, queryR);

        for (const { node: nodeB, agentId: bId } of candidates) {
          if (bId === agent.id) continue;

          const dx = nodeB.pos.x - nodeA.pos.x;
          const dy = nodeB.pos.y - nodeA.pos.y;
          const dz = nodeB.pos.z - nodeA.pos.z;
          const distSq = dx * dx + dy * dy + dz * dz;
          const minDist = nodeA.radius + nodeB.radius;

          if (distSq >= minDist * minDist || distSq < 1e-9) continue;

          const dist = Math.sqrt(distSq);
          const overlap = minDist - dist;
          const invDist = 1 / dist;

          const forceMag = overlap * INTER_AGENT_REPULSION_STIFFNESS;

          const nx = dx * invDist;
          const ny = dy * invDist;
          const nz = dz * invDist;

          const halfF = forceMag * 0.5;

          nodeA.acc.x -= (halfF * nx) / nodeA.mass;
          nodeA.acc.y -= (halfF * ny) / nodeA.mass;
          nodeA.acc.z -= (halfF * nz) / nodeA.mass;

          nodeB.acc.x += (halfF * nx) / nodeB.mass;
          nodeB.acc.y += (halfF * ny) / nodeB.mass;
          nodeB.acc.z += (halfF * nz) / nodeB.mass;

          nodeA.interAgentImpulse += halfF;
          nodeB.interAgentImpulse += halfF;
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

    // ── Chemical concentrations ────────────────────────────────────────────────
    // Compute before agent.update() so the sensor is current when the brain runs.
    // Uses the existing agent positions — no separate grid, no diffusion pass.
    this._computeChemicalConcentrations();

    // Apply grab spring + prop-connection forces BEFORE agents integrate
    this._applyGrabSprings();
    this._applyPropConnections();

    const offspring: Agent[] = [];

    let liveCount = this.agents.reduce((n, a) => n + (a.dead ? 0 : 1), 0);

    for (const agent of this.agents) {
      if (agent.dead) continue;

      if (agent.age > 60) {
        this._depositCorpse(agent);
        agent.dead = true;
        liveCount--;
        this.telemetry.recordDeath();
        continue;
      }

      agent.update(dt, this.env.zones, this.worldWidth, this.worldDepth, this.heightfield, this.agents, this.props);

      if (agent.dead) {
        this._depositCorpse(agent);
        liveCount--;
        this.telemetry.recordDeath();
        continue;
      }

      // Energy harvesting
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

      // Energy decay: surplus above 200 bleeds off at 3% per second
      if (agent.energy > 200) {
        agent.energy -= (agent.energy - 200) * 0.03 * dt;
      }

      if (agent.canReproduce() && liveCount + offspring.length < this.maxAgents) {
        const [sx, sy, sz] = this._offspringSpawn(agent);
        const child = agent.reproduce(sx, sy, sz);
        offspring.push(child);
        this.lineageLog.push([child.id, child.parentId, child.generation, child.birthTime]);
        this.telemetry.recordBirth();
      }
    }

    this._processAgentActions();
    this._updateProps(dt);

    this.agents = this.agents.filter(a => !a.dead);
    this.agents.push(...offspring);

    this._cleanupDeadAgentGrabs();

    if (this.agents.length < 4) {
      const toAdd = Math.min(6, this.maxAgents - this.agents.length);
      for (let i = 0; i < toAdd; i++) {
        this._spawn(Genome.random());
      }
    }

    this._applyKinshipInteractions();
    this._applyInterAgentCollision();

    const CONTACT_DEATH_THRESHOLD = 800;
    for (const agent of this.agents) {
      if (agent.dead) continue;
      let totalImpulse = 0;
      for (const node of agent.nodes) totalImpulse += node.interAgentImpulse;
      if (totalImpulse >= CONTACT_DEATH_THRESHOLD) {
        this._depositCorpse(agent);
        agent.dead = true;
        this.telemetry.recordDeath();
      }
    }

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

  // ── Prop accessors for renderer ───────────────────────────────────────────────

  get grabSprings(): ReadonlyArray<{ prop: Prop; agentNode: { pos: { x: number; y: number; z: number } }; agentId: number }> {
    return this._grabSprings;
  }

  get propConnections(): ReadonlyArray<{ propA: Prop; propB: Prop; restLength: number }> {
    return this._propConnections;
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