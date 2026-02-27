## Summary

- **Archetype seeding (A):** Generation-0 population now draws ~62% of agents from three hand-crafted locomoting archetypes (worm, quad, tripod) and the remainder from the existing random genome factory. Archetypes are procedurally defined in `Genome.ts` — no new files or data formats, just static methods. Post-crash reseeding continues to use random genomes only, preserving the Evolutionary Biologist's consensus position that archetypes belong at generation 0.
- **Inter-agent sphere-sphere collision (E):** A new `SpatialHash` class provides O(n·k) broad-phase queries (k ≈ cells per query, not total nodes). `World._applyInterAgentCollision()` rebuilds the hash each frame and applies linear repulsion forces to any two nodes from *different* agents that overlap. Cell-size tuning notes and ownership are documented in `SpatialHash.ts`.
- **Triangle-completion bias (C-soft):** `Genome._pickNewSpring()` replaces the inline spring-addition logic. When a spring is added during mutation, it scans for open triangles (pairs sharing a common neighbour but not directly connected) and completes one with 70% probability — otherwise falls back to a random edge. Hard constraint rejected per consensus.

## Changes

- **`src/agent/Genome.ts`** — Added `archetype()`, `randomArchetypeName()`, and three private archetype factories (`_worm`, `_quad`, `_tripod`). Replaced inline spring-addition mutation with `_pickNewSpring()` implementing the triangle-completion bias.
- **`src/world/SpatialHash.ts`** *(new file)* — Lightweight XZ-plane spatial hash for collision broad phase. Documents cell-size tuning notes and named ownership.
- **`src/world/World.ts`** — Replaced `Genome.random()` loop with `_seedInitialPopulation()` that mixes archetypes and random genomes. Added `_collisionHash` field and `_applyInterAgentCollision()` called at the end of each `update()` tick.

## Test plan

- [ ] Run `npm run dev` and verify the simulation starts without errors
- [ ] Observe that generation-0 agents include clearly recognisable worm, quad, and tripod body shapes rather than all being collapsed blobs
- [ ] Watch agents physically repel each other when they collide — nodes should not pass through nodes from other agents
- [ ] Check browser console for runtime errors (especially no "Maximum call stack" or NaN propagation from the spatial hash)
- [ ] Confirm the mutation operator occasionally produces triangulated spring graphs over many generations (inspect via `sim.world.agents[0].genome.springs` in the console)

Closes #36