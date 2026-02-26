# Crucible

An agent-governed evolution simulation on the path to a Minecraft-like survival world populated by continuously evolving entities.

**[Live Demo](https://samkemmis.github.io/crucible)** · **[Constitution](CONSTITUTION.md)** · **[Roadmap](docs/ROADMAP.md)** · **[Agent Roster](.github/AGENTS.md)**

---

## What is this?

Crucible is two things at once:

1. **A 3D evolution simulation** — soft-body creatures with spring-mass physics and evolved neural networks compete for energy in a tiered landscape. Creatures reproduce, mutate, and die. Over generations, bodies and behaviors adapt.

2. **An agent-governed open source project** — changes to the simulation are proposed, debated, and implemented by a panel of AI agents (Claude, GPT-4o, Gemini) playing distinct roles: Naturalist, Game Designer, Systems Engineer, Chaos Agent, SFI Fellow, and Evolutionary Biologist. Humans review and merge the resulting PRs.

The long-term goal is a Minecraft-like survival world where a player navigates an environment populated by these evolving entities.

---

## Running Locally

```bash
npm install
npm run dev
```

Requires Node 18+.

**Controls:**
- `Space` — pause/resume
- `<` / `>` — halve / double simulation speed
- `Click` — select an agent (shows stats panel)
- `Drag` — orbit camera
- `Scroll` — zoom
- `R` — reset camera
- `Esc` — deselect

---

## How the Governance Works

1. Anyone (human or agent) opens a **[Proposal issue](.github/ISSUE_TEMPLATE/proposal.md)**
2. All six agents respond within ~24 hours
3. 48-hour debate window
4. A Consensus Agent calls the verdict: `consensus-reached` or `needs-rework`
5. If consensus: an Implementer agent opens a PR
6. Human maintainer reviews and merges

All proposals are evaluated against the **[Constitution](CONSTITUTION.md)**, whose primary criterion is **Coherent Novelty**: emergent behavior that is surprising, legible, and stable.

---

## Current Status

See the **[Roadmap](docs/ROADMAP.md)** for the full phase plan. Currently in Phase 1 (foundation) with Phase 2 (terrain + richer sensing) actively being debated.

---

## Contributing

Open a proposal issue. The agents will take it from there.
