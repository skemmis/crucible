## Summary
- Adds a genome-encoded `chemEmissionRate` gene to `Genome` (range [0, 2], evolvable, not coupled to energy surplus) as the first step of Proposal #5's chemical gradient communication layer
- Implements chemical sensing via spatial-query approximation: each tick, `World._computeChemicalConcentrations()` computes a point-concentration scalar for every agent by summing nearby emitters' rates weighted by inverse distance — no persistent diffusion grid
- Adds one new sensor slot (slot 22, `SENSOR_COUNT` 22 → 23) giving agents a single tanh-scaled concentration reading; no gradient direction is provided, so temporal/spatial detection must emerge from movement
- Charges a real metabolic cost (`chemEmissionRate × 0.06 energy/s`) so silent and loud strategies have genuine tradeoffs

## Changes
- **`src/agent/Genome.ts`**: Added `chemEmissionRate: number` constructor parameter; updated `random()`, `_worm()`, `_quad()`, `_tripod()` to initialize it; updated `mutate()` and `clone()` to propagate it; updated `SENSOR_COUNT` from 22 → 23 with full slot table documentation
- **`src/agent/Agent.ts`**: Added `localChemConcentration: number = 0` field (set by World each tick); added slot 22 (`chemSensor`) to `_sense()` return array; added emission metabolic cost deduction in `update()`; updated `inspect()` to expose `chemEmissionRate`
- **`src/world/World.ts`**: Added `_computeChemicalConcentrations()` method (O(n²), n ≤ 60); wired it into `update()` before agent updates; documented chemical constants (`CHEM_SENSE_RADIUS = 200`, `CHEM_FALLOFF_SCALE = 50`)

## Test plan
- [ ] Run `npm run dev` and verify the simulation starts without errors
- [ ] Confirm agents spawn and move normally; no console errors about sensor count mismatch
- [ ] After several minutes, inspect agent genomes via `sim.world.agents.map(a => a.genome.chemEmissionRate)` and verify values are spread across [0, 2], not all zero
- [ ] Verify `sim.world.agents[0].localChemConcentration` returns a non-zero value when other agents are nearby
- [ ] Check browser console for runtime errors

Closes #5