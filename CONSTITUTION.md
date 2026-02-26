# Crucible Constitution
> v0.1 — amendable by PR, subject to the standard agent debate process

---

## Mission

Build a Minecraft-like survival world populated by continuously evolving entities. Players navigate a living world; the entities in that world evolve independently and continuously, shaped by natural selection.

---

## Primary Criterion: Coherent Novelty

A proposed change is good if it increases **coherent novelty** — behaviors that are:

- **Surprising** — not trivially predictable from initial conditions or simple inspection of the rules
- **Legible** — a human observer can construct a plausible post-hoc narrative about *why* it happened
- **Stable** — doesn't collapse the simulation into noise (pure chaos) or frozen stasis (convergence to a fixed point)

Changes that maximize any one of these at the expense of the others are suspect. Noise is not novelty. Predictability is not stability.

---

## Secondary Criterion: Performance

Don't sacrifice coherent novelty for performance, but don't ignore it either.

Target: interactive framerates with 200+ simultaneous entities on consumer hardware.

---

## North Star: Player Experience

Every proposed change should be evaluable against:

> *"Does this make the world richer and more interesting to inhabit?"*

The player is a first-class participant in the world, not just an observer. Changes that are mechanically interesting but invisible or irrelevant to a player inside the world are lower priority than changes that create legible, experiential richness.

---

## The Agent Roster

See [`.github/AGENTS.md`](.github/AGENTS.md) for the full roster of agent personas, their models, and their philosophies.

---

## Proposal & Debate Process

1. Open an Issue using the **[Proposal template](.github/ISSUE_TEMPLATE/proposal.md)**
2. Label is automatically set to `proposed`
3. All registered agents respond within ~24 hours (triggered automatically)
4. 48-hour open debate window — agents and humans may comment freely
5. After 48 hours, the **Consensus Agent** reads the full thread and calls one of:
   - `consensus-reached` — rough agreement on direction; Implementer opens a PR
   - `needs-rework` — significant unresolved disagreement; proposer revises and re-triggers
6. If `consensus-reached`: an Implementer agent opens a PR linked to the issue
7. The human maintainer reviews the PR and merges or requests changes

---

## Amending This Constitution

This document can be amended by PR. Amendments follow the same proposal → debate → consensus → PR process. Label amendment proposals with `constitution`.

---

## Roadmap

See [`docs/ROADMAP.md`](docs/ROADMAP.md) for the phased path from current simulation to full game.
