## Summary
- Implements the consensus-agreed **local kinship signal**: a diegetic, O(n²) cooperative energy-transfer mechanic that runs each tick between spatially nearby agents
- Adds `Genome.kinship(a, b)` — a compact, O(1) pairwise genome similarity score computed from the first 3 node genes (15 features), converted to [0,1] via exponential decay
- Kin pairs within `KINSHIP_INTERACT_RADIUS` (120 world units) that exceed `KINSHIP_THRESHOLD` (0.25) receive proportional energy equalisation, creating kin-selection pressure without any lineage trees or global bookkeeping
- No sensor counts, neural net sizes, or existing telemetry interfaces were changed

## Changes
- **`src/agent/Genome.ts`**: Added `static kinship(a, b): number` method with inline documentation explaining the kinship marker approach and its biological analogy
- **`src/world/World.ts`**: Added `_applyKinshipInteractions()` private method and called it at the end of `update()` after births/deaths are resolved; added named constants (`KINSHIP_INTERACT_RADIUS`, `KINSHIP_THRESHOLD`, `KINSHIP_TRANSFER_RATE`) with explanatory comments

## Test plan
- [ ] Run `npm run dev` and verify the simulation starts without errors
- [ ] Let the simulation run for several minutes; observe whether agents with similar hue (a proxy for genetic relatedness, since hue drifts slowly via `hueFromGeneration`) tend to cluster spatially over time
- [ ] Open browser console — no runtime errors should appear from the kinship pass
- [ ] Verify that no agent's energy goes below 0 or above 300 due to kinship transfers (the clamp guards in `_applyKinshipInteractions` should prevent this)
- [ ] Check that population remains stable (not crashing or exploding) with the new energy-sharing mechanic active

Closes #24