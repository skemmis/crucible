## Summary
- Adds **ComplexityScore** (∈ [0,1] or `null`) to every telemetry snapshot, computed as the geometric mean of five normalised sub-scores with two hard gates (birthDeathRatio band + maxGeneration growth)
- Logs all six sub-scores individually per snapshot so callers can diagnose *which* dimension is driving or suppressing the aggregate
- Tracks **complexityScoreVariance** and lag-1 **complexityScoreAutocorrelation** over a rolling 10-snapshot window — a near-critical system should fluctuate, not flatline
- Includes the active **WorldConfig** values in every telemetry snapshot, tying complexity scores to the parameters that produced them

## Changes
- `src/world/World.ts` — adds `ComplexitySubScores` interface; extends `TelemetrySnapshot` with `complexityScore`, `complexitySubScores`, `complexityScoreVariance`, `complexityScoreAutocorrelation`, and `config`; adds `_computeComplexitySubScores()` to World; extends `TelemetryTracker` with maxGeneration history (gate check) and score history (variance/autocorrelation); stores `config` on World instance

## Test plan
- [ ] Run `npm run dev` and verify the simulation starts without errors
- [ ] Open browser console, wait 60 s, observe a telemetry POST — confirm the payload includes `complexityScore`, `complexitySubScores`, `complexityScoreVariance`, `complexityScoreAutocorrelation`, and `config` fields
- [ ] Confirm `complexityScore` is `null` early in a run (before lineages have grown and population has stabilised) and becomes a number once gates pass
- [ ] Confirm `config` in the snapshot matches `DEFAULT_CONFIG`
- [ ] Check browser console for runtime errors

Closes #23