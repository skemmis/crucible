export interface EnergyZone {
  x: number;
  y: number;   // height above ground — 0=ground, 60=mid, 140=high
  z: number;
  radius: number;
  energy: number;
  maxEnergy: number;
  replenishRate: number;
  tier: 0 | 1 | 2;  // 0=ground, 1=mid, 2=high
}

/**
 * A temporary energy depot left when an agent dies.
 * Decays to zero with no replenishment — corpses rot.
 */
export interface CorpseDepot {
  x: number;
  y: number;
  z: number;
  radius: number;
  energy: number;
  /** Initial energy, used for rendering fill level. */
  maxEnergy: number;
  /** Energy lost per second. Corpse lasts ~CORPSE_LIFETIME_S seconds. */
  decayRate: number;
}

/** How many seconds a corpse at full energy takes to fully decay. */
const CORPSE_LIFETIME_S = 20;

/** Radius of a corpse depot in world units. */
const CORPSE_RADIUS = 18;

/** Fraction of the dying agent's energy deposited into the corpse. */
const CORPSE_ENERGY_FRACTION = 0.40;

/** Minimum energy to bother creating a corpse (below this it's not worth tracking). */
const CORPSE_MIN_ENERGY = 4;

/** Harvest rate from a corpse per frame when a node overlaps (matches food zone rate). */
const CORPSE_HARVEST_RATE = 0.08;

/**
 * Three-tier food landscape:
 *
 *  Tier 0 — ground (Y=0):  large zones, moderate energy, easy to reach
 *  Tier 1 — mid   (Y=60):  medium zones, rich energy, requires some height
 *  Tier 2 — high  (Y=140): small zones, richest energy, truly out of reach
 *                           for Gen-0 bodies (radius ~28 → need node at Y≥112)
 *
 * Selection pressure: evolve taller bodies to unlock higher tiers.
 */
export class Environment {
  zones: EnergyZone[] = [];

  /** Decaying energy depots left by dead agents. */
  corpseDepots: CorpseDepot[] = [];

  constructor(
    readonly worldWidth: number,
    readonly worldDepth: number,
    zoneCount: number = 12,
    /**
     * Optional terrain-height query used to place ground-tier (tier 0) food
     * zones ON the terrain surface rather than at absolute Y=0.  When terrain
     * amplitude is large (≥40) zones at Y=0 would be buried underground on
     * hills; floating them on the terrain keeps them reachable from ground level.
     */
    groundHeightAt?: (x: number, z: number) => number,
  ) {
    this._seed(zoneCount, groundHeightAt);
  }

  private _seed(count: number, groundHeightAt?: (x: number, z: number) => number): void {
    const perTier = Math.floor(count / 3);
    const tiers: Array<{
      tier: 0 | 1 | 2;
      fixedY: number | null; // null = use terrain height (ground tier)
      radiusMin: number;
      radiusMax: number;
      energyMin: number;
      energyMax: number;
      replenishMin: number;
      replenishMax: number;
    }> = [
      // Ground — plentiful, easy; radius shrunk so patches support 1–2 agents,
      // not entire clusters.  Y is placed on the terrain surface (not fixed Y=0)
      // so that zones remain reachable when terrain amplitude is large.
      {
        tier: 0, fixedY: null,
        radiusMin: 20, radiusMax: 28,
        energyMin: 60, energyMax: 90,
        replenishMin: 1.5, replenishMax: 3.0,
      },
      // Mid — richer, requires height
      {
        tier: 1, fixedY: 60,
        radiusMin: 14, radiusMax: 20,
        energyMin: 90, energyMax: 140,
        replenishMin: 1.0, replenishMax: 2.0,
      },
      // High — richest, truly out of reach until evolved
      {
        tier: 2, fixedY: 140,
        radiusMin: 8, radiusMax: 14,
        energyMin: 130, energyMax: 200,
        replenishMin: 0.7, replenishMax: 1.5,
      },
    ];

    for (const td of tiers) {
      for (let i = 0; i < perTier; i++) {
        const x = 60 + Math.random() * (this.worldWidth - 120);
        const z = 60 + Math.random() * (this.worldDepth - 120);
        // Ground-tier zones float on the terrain surface; upper tiers are fixed.
        const y = td.fixedY !== null
          ? td.fixedY
          : (groundHeightAt ? groundHeightAt(x, z) : 0);
        const maxE = td.energyMin + Math.random() * (td.energyMax - td.energyMin);
        this.zones.push({
          x,
          y,
          z,
          radius: td.radiusMin + Math.random() * (td.radiusMax - td.radiusMin),
          energy: maxE,
          maxEnergy: maxE,
          replenishRate: td.replenishMin + Math.random() * (td.replenishMax - td.replenishMin),
          tier: td.tier,
        });
      }
    }
  }

  update(dt: number): void {
    // Replenish food zones
    for (const z of this.zones) {
      z.energy = Math.min(z.maxEnergy, z.energy + z.replenishRate * dt);
    }

    // Decay corpse depots and remove exhausted ones
    for (let i = this.corpseDepots.length - 1; i >= 0; i--) {
      const c = this.corpseDepots[i];
      c.energy -= c.decayRate * dt;
      if (c.energy <= 0) {
        this.corpseDepots.splice(i, 1);
      }
    }
  }

  /**
   * Deposit a corpse energy depot at the given world position.
   * Called by World when an agent dies with meaningful energy remaining.
   *
   * @param x  World X position of the corpse centre.
   * @param y  World Y position (terrain height at that XZ).
   * @param z  World Z position of the corpse centre.
   * @param agentEnergy  The agent's energy at the moment of death.
   */
  addCorpse(x: number, y: number, z: number, agentEnergy: number): void {
    const energy = agentEnergy * CORPSE_ENERGY_FRACTION;
    if (energy < CORPSE_MIN_ENERGY) return;

    this.corpseDepots.push({
      x,
      y,
      z,
      radius: CORPSE_RADIUS,
      energy,
      maxEnergy: energy,
      decayRate: energy / CORPSE_LIFETIME_S,
    });
  }

  /**
   * Attempt to harvest energy from any food zone overlapping the given sphere.
   * Uses full 3D distance — nodes must be physically near the zone centre
   * (including matching height for elevated zones).
   */
  harvest(x: number, y: number, z: number, radius: number): number {
    let total = 0;

    // Harvest from food zones
    for (const zone of this.zones) {
      const dx = zone.x - x;
      const dy = zone.y - y;
      const dz = zone.z - z;
      const distSq = dx * dx + dy * dy + dz * dz;
      const combined = zone.radius + radius;
      if (distSq < combined * combined) {
        const take = Math.min(zone.energy, 0.08);
        zone.energy -= take;
        total += take;
      }
    }

    // Harvest from corpse depots
    for (const depot of this.corpseDepots) {
      const dx = depot.x - x;
      const dy = depot.y - y;
      const dz = depot.z - z;
      const distSq = dx * dx + dy * dy + dz * dz;
      const combined = depot.radius + radius;
      if (distSq < combined * combined) {
        const take = Math.min(depot.energy, CORPSE_HARVEST_RATE);
        depot.energy -= take;
        total += take;
      }
    }

    return total;
  }
}