## Summary

- Adds **corpse energy depots** (Phase 1 of Proposal #21): when an agent dies of old age with meaningful energy, a temporary energy depot is left at its position on the terrain surface
- Corpses decay to zero over ~20 seconds with no replenishment, making scavenging a real energy source without flooding the world
- Agents can harvest from corpses via the existing `env.harvest()` path — no change to agent code needed
- Corpses render as dark-red semi-transparent discs that fade as they decay, giving players a clear visual signal of where agents have died

## Changes

- **`src/world/Environment.ts`**: Added `CorpseDepot` interface; added `corpseDepots` array and `addCorpse()` method to `Environment`; extended `update()` to decay and cull spent corpses; extended `harvest()` to include corpse depots alongside food zones
- **`src/world/World.ts`**: Added `_depositCorpse()` helper that places a corpse at terrain height below the dying agent; called on age-death path (where energy may be substantial); starvation deaths (energy ≤ 0) naturally produce no corpse
- **`src/render/Renderer.ts`**: Added `_corpseVisuals` pool; added `_renderCorpses()` method rendering corpses as pooled dark-red `CircleGeometry` discs that scale with depot radius and fade with remaining energy; `_ensureCorpseVisuals()` grows the pool lazily to avoid allocation spikes

## Test plan
- [ ] Run `npm run dev` and verify the simulation starts without errors
- [ ] Observe dark-red discs appearing on the ground after agents die of old age and fading over ~20 seconds
- [ ] Verify agents visibly move toward and linger near corpse discs (scavenging pressure)
- [ ] Confirm no corpse disc appears when an agent starves (energy ≤ 0 at death)
- [ ] Check browser console for runtime errors during normal operation and after population reseeds

Closes #21