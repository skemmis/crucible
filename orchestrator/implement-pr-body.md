## Summary

- Implements **Step 1 only** of Proposal #9: sinusoidal day/night cycle with food replenish rate scaling
- `World.ts` gains a public `timeOfDay` field (0=night, 1=midday) updated each tick from a 120-second sine wave
- `Environment.update()` accepts a `daylightFactor` parameter and applies a `1 + daylightFactor` multiplier to all food zone replenish rates (1× at night, 2× at full midday)
- No agent changes, no genome changes — Step 2 (lightSensitivity gene + vision penalty) is explicitly deferred per consensus

## Changes

- **`src/world/Environment.ts`**: Added `daylightFactor` parameter to `update(dt, daylightFactor)`. Replenish multiplier `= 1 + daylightFactor` scales smoothly from base rate (night) to double rate (midday). Default of `0.5` keeps existing callers unaffected.
- **`src/world/World.ts`**: Added `DAY_NIGHT_PERIOD_S = 120` constant and `timeOfDay` public field. Each tick: `timeOfDay = (sin(2π × time / 120) + 1) / 2`. Passes `timeOfDay` into `env.update()`. Field is exposed for future renderer use (sky colour) and Step 2 (genome hook).

## Test plan
- [ ] Run `npm run dev` and verify the simulation starts without errors
- [ ] Open browser console — no runtime errors expected
- [ ] Wait ~60 seconds and observe food zones visually brightening (more opaque discs) as `timeOfDay` peaks toward midday; zones refill slower during the night half of the cycle
- [ ] Confirm existing behaviour is unchanged: agents move, reproduce, harvest, and die as before

Closes #9