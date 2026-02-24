import { Agent } from '../agent/Agent';
import { Genome } from '../agent/Genome';
import { Environment } from './Environment';

export interface WorldConfig {
  worldWidth: number;
  groundY: number;
  initialAgents: number;
  maxAgents: number;
  zoneCount: number;
}

export const DEFAULT_CONFIG: WorldConfig = {
  worldWidth: 2400,
  groundY: 0,        // set at runtime from canvas height
  initialAgents: 16,
  maxAgents: 60,
  zoneCount: 6,      // sparse food → locomotion has real fitness value
};

export class World {
  agents: Agent[] = [];
  env: Environment;
  time: number = 0;
  stepCount: number = 0;

  readonly worldWidth: number;
  readonly groundY: number;
  readonly maxAgents: number;

  // Phylogeny log: [childId, parentId, generation, birthTime]
  lineageLog: Array<[number, number | null, number, number]> = [];

  constructor(cfg: WorldConfig) {
    this.worldWidth = cfg.worldWidth;
    this.groundY = cfg.groundY;
    this.maxAgents = cfg.maxAgents;
    this.env = new Environment(cfg.worldWidth, cfg.groundY, cfg.zoneCount);

    for (let i = 0; i < cfg.initialAgents; i++) {
      this._spawn(Genome.random());
    }
  }

  private _spawn(genome: Genome, parentAgent?: Agent): Agent {
    const x = 50 + Math.random() * (this.worldWidth - 100);
    // Spawn above ground so body can settle
    const y = this.groundY - 10;
    const a = new Agent(
      genome,
      x,
      y,
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
    this.env.update(dt);

    const offspring: Agent[] = [];

    // Count currently-living agents so the cap check is accurate even when
    // some agents die mid-loop (they stay in the array until pruned below).
    let liveCount = this.agents.reduce((n, a) => n + (a.dead ? 0 : 1), 0);

    for (const agent of this.agents) {
      if (agent.dead) continue;

      // Max lifespan: forces generational turnover so elite Gen-0 agents
      // don't block slots indefinitely.
      if (agent.age > 180) { agent.dead = true; liveCount--; continue; }

      agent.update(dt, this.env.zones, this.groundY, this.worldWidth);
      if (agent.dead) { liveCount--; continue; }

      // Energy harvesting: each node that overlaps a zone absorbs energy.
      for (const node of agent.nodes) {
        const gained = this.env.harvest(node.pos.x, node.pos.y, node.radius);
        if (gained > 0) agent.absorbEnergy(gained * 18);
      }

      // Reproduction — checked against LIVE count so dying agents free their
      // slots in the same frame, unlocking reproduction at cap.
      if (agent.canReproduce() && liveCount + offspring.length < this.maxAgents) {
        const child = agent.reproduce();
        offspring.push(child);
        this.lineageLog.push([child.id, child.parentId, child.generation, child.birthTime]);
      }
    }

    // Prune dead, add offspring
    this.agents = this.agents.filter(a => !a.dead);
    this.agents.push(...offspring);

    // Reseed if population crashes
    if (this.agents.length < 4) {
      const toAdd = Math.min(6, this.maxAgents - this.agents.length);
      for (let i = 0; i < toAdd; i++) {
        this._spawn(Genome.random());
      }
    }
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
