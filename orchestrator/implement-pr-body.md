## Summary

- Adds a lightweight telemetry pipeline that captures evolutionary trajectory metrics every 60 seconds and routes them back to the governance system so agents can observe simulation outcomes when evaluating proposals.
- Implements exactly the four O(n)/O(nk) metrics agreed in consensus: rolling genome centroid distance (diversity), birth/death ratio trend over 500 frames, diversity rate of change, and spatial grid entropy — no O(n²) pairwise diff, no continuous `toDataURL`.
- Canvas snapshots are only taken when an anomaly fires (>2σ deviation from rolling baseline), keeping the GPU readback off the render hot-path.
- Agent prompts receive delta-formatted summaries (`current`, `Δ last 5`, `Δ last 20`, `trend`) rather than raw snapshots, so agents reason about trajectory not instantaneous state. Storage uses Vercel KV (not Gist) to avoid race conditions with concurrent tabs.

## Changes

**`src/world/World.ts`**
Adds `TelemetryTracker` (ring-buffer birth/death counts, rolling diversity history, per-metric anomaly baseline) and `World.captureSnapshot()` — the four consensus metrics plus population basics and anomaly flags. Also records births and deaths inline in `update()` via `telemetry.recordBirth()` / `recordDeath()`, and updates the rolling diversity history each frame using `_computeGenomeDiversity()` (O(nk), fixed feature vector capped at 7 nodes).

**`src/main.ts`**
Adds a 60-second `setInterval` that calls `captureAndPost()`. Anomaly detection is done by inspecting the preliminary snapshot; `toDataURL` is only called if anomalies are present or a force-capture is requested. Posts JSON to `/api/telemetry` as fire-and-forget.

**`api/telemetry.ts`** *(new)*
Vercel serverless endpoint. Receives snapshot JSON, validates required fields, prepends to a capped Redis LIST in Vercel KV (`crucible:telemetry:snapshots`, max 100 entries), and writes a quick-read `crucible:telemetry:latest` key. Returns `200 { ok: true }`.

**`orchestrator/src/telemetry.ts`** *(new)*
Client-side helper for the orchestrator. `fetchRecentSnapshots(n)` reads from Vercel KV. `buildSummary()` computes per-metric `{current, delta5, delta20, trend}` structs and de-duplicates recent anomaly flags. `formatForPrompt()` renders a Markdown table with delta-first formatting. `buildTelemetryPromptSection()` is the single export for dispatch.ts to call — it fetches, summarises, and formats in one step, returning an empty stub if no data is available yet.

## Test plan
- [ ] Run `npm run dev` and verify the simulation starts without errors
- [ ] Open the browser console and confirm no errors appear at startup
- [ ] Wait 60 seconds and verify `[telemetry]` log entries appear (or a `Failed to post` warning if KV is unconfigured — both are acceptable)
- [ ] Trigger a fast population crash (open console, `sim.world.agents.forEach(a => a.dead = true)`) and confirm an anomaly snapshot is logged within the next telemetry cycle
- [ ] Verify the canvas JPEG is only attached when anomalies are present (check the JSON body in the network tab)
- [ ] With `KV_REST_API_URL` and `KV_REST_API_TOKEN` set, hit `POST /api/telemetry` with a valid snapshot body and confirm `200 { ok: true }`
- [ ] Call `buildTelemetryPromptSection()` from the orchestrator context and confirm it returns a Markdown table with delta columns

Closes #10