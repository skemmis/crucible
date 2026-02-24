export interface EnergyZone {
  x: number;
  y: number;
  radius: number;
  energy: number;
  maxEnergy: number;
  replenishRate: number; // energy / second
}

export class Environment {
  zones: EnergyZone[] = [];

  constructor(
    readonly worldWidth: number,
    readonly groundY: number,
    zoneCount: number = 6,
  ) {
    this._seed(zoneCount);
  }

  private _seed(count: number): void {
    for (let i = 0; i < count; i++) {
      const maxE = 80 + Math.random() * 60;
      this.zones.push({
        // Clusters are deliberately uneven — some gaps are large, forcing agents to travel
        x: (i + 0.2 + Math.random() * 0.6) * (this.worldWidth / count),
        y: this.groundY,
        radius: 45 + Math.random() * 30,   // smaller zones → scarcer resource
        energy: maxE,
        maxEnergy: maxE,
        replenishRate: 1.5 + Math.random() * 2.5,  // slower replenish
      });
    }
  }

  update(dt: number): void {
    for (const z of this.zones) {
      z.energy = Math.min(z.maxEnergy, z.energy + z.replenishRate * dt);
    }
  }

  /**
   * Attempt to harvest energy from any zone overlapping the given circle.
   * Returns total energy extracted this call.
   */
  harvest(x: number, y: number, radius: number): number {
    let total = 0;
    for (const z of this.zones) {
      const dx = z.x - x;
      const dy = z.y - y;
      if (dx * dx + dy * dy < (z.radius + radius) * (z.radius + radius)) {
        const take = Math.min(z.energy, 0.08); // small cap keeps zones alive under competition
        z.energy -= take;
        total += take;
      }
    }
    return total;
  }
}
