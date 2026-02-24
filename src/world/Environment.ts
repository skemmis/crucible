export interface EnergyZone {
  x: number;
  y: number;   // always 0 (ground-level)
  z: number;
  radius: number;
  energy: number;
  maxEnergy: number;
  replenishRate: number;
}

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
    for (let i = 0; i < count; i++) {
      const maxE = 80 + Math.random() * 60;
      this.zones.push({
        // Scatter unevenly across the XZ plane so agents must explore in 2D
        x: (i % Math.ceil(Math.sqrt(count)) + 0.2 + Math.random() * 0.6)
           * (this.worldWidth / Math.ceil(Math.sqrt(count))),
        y: 0,
        z: (Math.floor(i / Math.ceil(Math.sqrt(count))) + 0.2 + Math.random() * 0.6)
           * (this.worldDepth / Math.ceil(Math.sqrt(count))),
        radius: 55 + Math.random() * 40,
        energy: maxE,
        maxEnergy: maxE,
        replenishRate: 1.5 + Math.random() * 2.5,
      });
    }
  }

  update(dt: number): void {
    for (const z of this.zones) {
      z.energy = Math.min(z.maxEnergy, z.energy + z.replenishRate * dt);
    }
  }

  /**
   * Attempt to harvest energy from any zone overlapping the given sphere.
   * Distance is measured in 3-D (XYZ) but zones sit at Y=0 so it's
   * effectively XZ-dominant when nodes are close to the ground.
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
