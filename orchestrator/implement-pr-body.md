## Summary
- Reduces node position mutation sigma from 12 → 5 in `Genome.mutate()` (Proposal #43 Lever A)
- Extracts the sigma value into a named constant `NODE_POSITION_SIGMA` with a comment explaining the rationale and the change
- Spring parameter sigmas are intentionally unchanged — they are proportional and already small enough to allow within-lineage refinement
- This is the first phase of the consensus build order: ship A alone, measure lineage lifetime gains before adding further complexity

## Changes
- **`src/agent/Genome.ts`**: Added `NODE_POSITION_SIGMA = 5` constant; updated `mutate()` to use it for `dx`, `dy`, `dz` mutations instead of the hardcoded `12`

## Test plan
- [ ] Run `npm run dev` and verify the simulation starts without errors
- [ ] Let the simulation run for several minutes and observe that body plans within a lineage remain recognisably similar across generations (previously they drifted beyond recognition in 5–10 generations)
- [ ] Check that genome diversity in telemetry remains non-zero (lineages still diverge between lineages, just more slowly within them)
- [ ] Check browser console for runtime errors

Closes #43