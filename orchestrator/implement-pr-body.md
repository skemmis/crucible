## Summary

- **Lever D (Proposal #43):** Adds two proprioceptive sensor inputs to every agent, increasing `SENSOR_COUNT` from 12 → 14. These are body-state inputs that enable gait coordination beyond the global oscillator.
- **Stretch sensor (slot 12):** Mean absolute fractional deviation of actuated spring lengths from their rest lengths, tanh-scaled. Tells the brain how "activated" the body currently is — enables phase-shifted muscle sequences.
- **Ground contact fraction (slot 13):** Fraction of nodes currently touching terrain, normalized to [0, 1]. Tells the brain how many feet are planted — enables stance-aware locomotion strategies.
- **Lever A** (sigma 12→5) was already present in the codebase; this PR adds the comment referencing the proposal for completeness and ships Lever D alongside it.

## Changes

- **`src/agent/Genome.ts`**: Updated `SENSOR_COUNT` from 12 to 14. Expanded the sensor slot table comment to document the two new proprioceptive inputs with their ranges and normalization rationale.
- **`src/agent/Agent.ts`**: Updated `_sense()` to accept a `Heightfield` parameter (already available in `update()`). Added stretch sensor computation (iterates actuated muscles, computes mean fractional length deviation, applies tanh×3 normalization) and ground contact computation (queries terrain height per node, counts grounded nodes, divides by total nodes). Both values appended as slots 12–13.

## Test plan

- [ ] Run `npm run dev` and verify the simulation starts without errors
- [ ] Open browser console — confirm no TypeScript/runtime errors about input size mismatch
- [ ] Observe agents locomoting — the new inputs are purely additive; movement quality should be equal or better than before
- [ ] After several generations, check whether locomotion patterns show more variety (gait differentiation is the intended emergent effect, not guaranteed immediately)
- [ ] Confirm `SENSOR_COUNT === 14` matches the length of the array returned by `_sense()` — the existing sanity-check `const _check: number = SENSOR_COUNT` will catch static mismatches

Closes #43