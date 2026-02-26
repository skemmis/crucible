# Crucible Roadmap

The path from the current evolution simulation to a Minecraft-like survival world with continuously evolving entities.

Each phase is a target state, not a rigid plan. The agent debate process will determine the specific changes within each phase.

---

## Phase 1 — Foundation ✅ (current)
*A working 3D evolution simulation*

- [x] 3D physics (Verlet integration, springs, ground collision)
- [x] Genome encoding (nodes + springs + neural brain)
- [x] Mutation and reproduction
- [x] Three-tier energy landscape (ground / mid / high)
- [x] Three.js renderer with orbit camera, agent selection, HUD
- [x] Agent debate governance structure (CONSTITUTION, AGENTS, templates)

---

## Phase 2 — World Richness
*Make the world worth being in*

- [ ] **Terrain** — replace flat ground with navigable heightmap; terrain affects locomotion cost and food distribution
- [ ] **Richer sensing** — vision cones, chemical gradients, proprioception; agents can detect other agents
- [ ] **Biomes** — distinct regions with different energy densities, hazards, and selection pressures
- [ ] **Agent morphology legibility** — creatures should look like *something* at close range

---

## Phase 3 — Player Entity
*Put the player in the world*

- [ ] First-person / third-person switchable camera
- [ ] Player entity with physics (walks, jumps, collides with terrain and creatures)
- [ ] Creature awareness of the player (flee, approach, ignore — based on evolved behavior)
- [ ] Basic UI: health, position, nearby creature info

---

## Phase 4 — Interaction Primitives
*Let player and world affect each other*

- [ ] Player can disturb creatures (scatter, stress, attract)
- [ ] Creatures can affect the player (graze past, block path, eventually harm)
- [ ] Environmental interaction (player can modify food zones, terrain features)
- [ ] Observation tools: tag a creature, follow its lineage

---

## Phase 5 — Survival Mechanics
*Give the player a reason to care*

- [ ] Player has resources (energy/food, tools)
- [ ] Resource gathering from the environment
- [ ] Shelter / base-building primitives
- [ ] Creature-derived resources (observing, harvesting, domesticating?)
- [ ] Day/night or seasonal cycles that shift selection pressure

---

## Phase 6 — Full Game
*Ship it*

- [ ] Main menu, save/load world state
- [ ] Sound design (ambient, creature, physics)
- [ ] Multiplayer (multiple players in the same evolving world)
- [ ] Performance target: 200+ entities, 60fps, 4-player multiplayer

---

## Open Questions (for agent debate)

- Should the player's presence exert selection pressure on the creatures? (predator pressure)
- Should creatures be able to evolve *in response to* a specific player's behavior?
- What is the creature's "experience" of the world — do they have memory?
- Should there be a meta-game around the constitution itself (players voting on agent criteria)?
