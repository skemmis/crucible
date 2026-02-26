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

  constructor(
    readonly worldWidth: number,
    readonly worldDepth: number,
    zoneCount: number = 12,
  ) {
    this._seed(zoneCount);
  }

  private _seed(count: number): void {
    const perTier = Math.floor(count / 3);
    const tiers: Array<{
      y: number;
      tier: 0 | 1 | 2;
      radiusMin: number;
      radiusMax: number;
      energyMin: number;
      energyMax: number;
      replenishMin: number;
      replenishMax: number;
    }> = [
      // Ground — plentiful, easy
      {
        y: 0, tier: 0,
        radiusMin: 60, radiusMax: 90,
        energyMin: 80, energyMax: 120,
        replenishMin: 2.0, replenishMax: 4.0,
      },
      // Mid — richer, requires height
      {
        y: 60, tier: 1,
        radiusMin: 40, radiusMax: 60,
        energyMin: 120, energyMax: 180,
        replenishMin: 1.5, replenishMax: 3.0,
      },
      // High — richest, truly out of reach until evolved
      {
        y: 140, tier: 2,
        radiusMin: 22, radiusMax: 35,
        energyMin: 180, energyMax: 260,
        replenishMin: 1.0, replenishMax: 2.5,
      },
    ];

    for (const td of tiers) {
      for (let i = 0; i < perTier; i++) {
        const maxE = td.energyMin + Math.random() * (td.energyMax - td.energyMin);
        this.zones.push({
          // Scatter independently across XZ for each tier
          x: 60 + Math.random() * (this.worldWidth - 120),
          y: td.y,
          z: 60 + Math.random() * (this.worldDepth - 120),
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
    for (const z of this.zones) {
      z.energy = Math.min(z.maxEnergy, z.energy + z.replenishRate * dt);
    }
  }

  /**
   * Attempt to harvest energy from any zone overlapping the given sphere.
   * Uses full 3D distance — nodes must be physically near the zone centre
   * (including matching height for elevated zones).
   */
  harvest(x: number, y: number, z: number, radius: number): number {
    let total = 0;
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
    return total;
  }
}
