## Summary
- Expands the neural network sensor input vector from **7 to 12 inputs** (Phase 1 of the sensing architecture upgrade agreed in #14)
- Adds four new senses: Z-velocity, distance to nearest food, nearest food zone energy level, and wall proximity (X and Z axes separately)
- Defines the complete sensor slot layout as a documented table in `Genome.ts` — the single authoritative source of truth, designed to migrate cleanly to Option 3 evolvable allocation
- All layout constants (`WALL_SENSE_RADIUS`, `FOOD_DISTANCE_SCALE`) are named exports, not magic numbers scattered across files

## Changes
- **`src/agent/Genome.ts`**: `SENSOR_COUNT` bumped from 7 to 12. Added `WALL_SENSE_RADIUS` and `FOOD_DISTANCE_SCALE` named constants. Sensor layout table added as structured JSDoc comment — every slot is explicitly documented; no sense is silently hardcoded elsewhere.
- **`src/agent/Agent.ts`**: `_sense()` signature extended to accept `worldWidth`/`worldDepth` (already available in `update()`). Implements slots 7–11: vel Z, food distance (tanh-normalised via `FOOD_DISTANCE_SCALE`), food zone fill ratio (0–1), and wall proximity for X and Z axes (0 = far, 1 = at wall, saturates within `WALL_SENSE_RADIUS`). `EnergyZone` interface extended to expose `maxEnergy` (already present on the actual zone objects from `Environment.ts`).

## Test plan
- [ ] Run `npm run dev` and verify the simulation starts without errors in the browser console
- [ ] Confirm agents spawn and move — the neural net input size change should be transparent at runtime
- [ ] Inspect `world.agents[0].genome.brain.inputSize` in the browser console — should be `12`
- [ ] Observe that agents near world boundaries exhibit modified behaviour over generations (wall proximity signal active)
- [ ] Verify depleted food zones are treated differently from full ones over time (food fill signal active)
- [ ] Check browser console for runtime errors, especially NaN in neural forward pass

Closes #14