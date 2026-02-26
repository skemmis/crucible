## Summary
- Increased `zoneCount` from 12 → 24 in `DEFAULT_CONFIG` — the primary Sprint 1 config change agreed by consensus, redistributing food across more zones to reduce bottleneck clustering around 12 fixed attractors
- Added `energyAcquisitionVariance` metric to telemetry: tracks per-agent energy gained each frame; low variance signals undifferentiated scramble competition, rising variance signals niche formation — the key crowding diagnostic the panel requested
- Added `morphologicalVarianceByGeneration` metric: computes mean morphological distance from the bucket centroid for four generation cohorts (0–9, 10–19, 20–49, 50+); collapsing variance across generations is the measurable signal that crowding is homogenising rather than differentiating
- No world size, agent count, or agent radius changes — held per consensus; depletable zones explicitly deferred to Sprint 2

## Changes
**`src/world/World.ts`**
- `DEFAULT_CONFIG.zoneCount`: `12` → `24`
- Added `GenerationVarianceBucket` interface to exports
- Extended `TelemetrySnapshot` with `energyAcquisitionVariance: number` and `morphologicalVarianceByGeneration: GenerationVarianceBucket[]`
- Added `_frameEnergyGained: Map<number, number>` field on `World`; populated in `update()` during the harvest loop
- Added `_computeEnergyAcquisitionVariance()` — O(n), uses the frame map
- Added `_computeMorphologicalVarianceByGeneration()` — O(nk) over four generation buckets, same feature encoding as existing `_computeGenomeDiversity`
- Both new metrics wired into `captureSnapshot()`; `energyAcquisitionVariance` also added to the anomaly-detection checks

## Test plan
- [ ] Run `npm run dev` and verify the simulation starts without errors
- [ ] Confirm 24 zone discs render across the world (more evenly spread than before)
- [ ] Let the simulation run for ~200 generations; open devtools and call `sim.world.captureSnapshot()` — verify `energyAcquisitionVariance` and `morphologicalVarianceByGeneration` are present and non-zero
- [ ] Verify `morphologicalVarianceByGeneration` buckets populate correctly as generation count grows (early runs will only have the `0–9` bucket populated)
- [ ] Check browser console for runtime errors
- [ ] Visually confirm agents are less clumped than with 12 zones

Closes #12