## Summary
- Adds a static procedural `Heightfield` baked once at world-gen using multi-octave sine waves (no external dependency, deterministic, O(1) per height query via bilinear interpolation)
- Threads terrain height through `PhysicsNode.constrainToGround(groundY, ...)`, `Agent.update(…, heightfield)`, and `World.update()` so every node rests on the actual terrain surface rather than a flat Y=0 plane
- Agents are spawned on top of the terrain surface at their (x, z) position, creating immediate selection pressure for bodies that can navigate hills vs. valleys
- Renders the terrain as a vertex-coloured, shaded `PlaneGeometry` deformed from the heightfield grid; ground-tier food discs are raised to sit on top of the terrain

## Changes
- **`src/world/Heightfield.ts`** *(new)* — `Heightfield` class: grid generation, bilinear `heightAt(x, z)` query
- **`src/physics/PhysicsNode.ts`** — `constrainToGround` gains a `groundY: number = 0` first parameter; all existing call sites with no argument default to flat ground (backward-compatible)
- **`src/agent/Agent.ts`** — `update()` accepts a `Heightfield` and passes per-node terrain height to `constrainToGround`; `_develop()` `shift` uses `spawnY` as the reference floor instead of hardcoded 0
- **`src/world/World.ts`** — constructs and owns a `readonly heightfield`; `_spawn()` queries terrain height at spawn point; `update()` passes heightfield to each agent
- **`src/render/Renderer.ts`** — replaces flat `PlaneGeometry` ground with a heightfield-deformed terrain mesh (vertex colours: dark-green valleys → brown hilltops); selection ring tracks terrain surface; no flat ground mesh left

## Test plan
- [ ] Run `npm run dev` and verify the simulation starts without errors
- [ ] Observe undulating terrain rendered with green-to-brown height colouring
- [ ] Confirm agents walk on top of the terrain surface (nodes don't clip through hills)
- [ ] Confirm ground-tier food discs sit visually on the terrain rather than clipping into hills
- [ ] Check browser console for runtime errors

Closes #15