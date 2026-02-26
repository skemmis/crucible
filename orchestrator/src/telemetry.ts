/**
 * telemetry.ts — Fetches recent simulation snapshots from Vercel KV and
 * formats them as a `## Current simulation state` section for agent prompts.
 *
 * This module is imported by dispatch.ts (or equivalent) immediately before
 * building any agent prompt, so agents always reason from observed reality.
 */

import { createClient } from '@vercel/kv';

// ── KV client ─────────────────────────────────────────────────────────────────

const kv = createClient({
  url: process.env.KV_REST_API_URL ?? '',
  token: process.env.KV_REST_API_TOKEN ?? '',
});

const LIST_KEY = 'crucible:telemetry:snapshots';

// ── Types (mirrored from src/world/World.ts — keep in sync) ──────────────────

interface AnomalyFlag {
  metric: string;
  description: string;
  value: number;
  baseline: number;
  sigmas: number;
}

interface TelemetrySnapshot {
  timestamp: number;
  simTime: number;
  stepCount: number;
  genomeDiversity: number;
  birthRate: number;
  deathRate: number;
  birthDeathRatio: number;
  diversityDelta: number;
  spatialEntropy: number;
  agentCount: number;
  meanEnergy: number;
  stddevEnergy: number;
  anomalies: AnomalyFlag[];
  canvasSnapshot?: string;
}

// ── Derived summary types ─────────────────────────────────────────────────────

interface MetricSummary {
  current: number;
  /** Change from 5 snapshots ago (undefined if fewer snapshots exist) */
  delta5: number | undefined;
  /** Change from 20 snapshots ago (undefined if fewer snapshots exist) */
  delta20: number | undefined;
  /** Direction label inferred from delta5 */
  trend: 'rising' | 'falling' | 'stable';
}

export interface SimulationStateSummary {
  asOf: string;           // human-readable timestamp
  snapshotCount: number;
  agentCount: MetricSummary;
  genomeDiversity: MetricSummary;
  birthDeathRatio: MetricSummary;
  spatialEntropy: MetricSummary;
  recentAnomalies: AnomalyFlag[];
}

// ── Fetch and parse snapshots from KV ────────────────────────────────────────

/**
 * Fetch the last `n` snapshots from KV (newest first).
 * Returns an empty array on any failure — callers should tolerate no-data.
 */
export async function fetchRecentSnapshots(n: number = 20): Promise<TelemetrySnapshot[]> {
  try {
    const raw = await kv.lrange(LIST_KEY, 0, n - 1);
    return raw
      .map(item => {
        try {
          return JSON.parse(item as string) as TelemetrySnapshot;
        } catch {
          return null;
        }
      })
      .filter((s): s is TelemetrySnapshot => s !== null);
  } catch (err) {
    console.warn('[telemetry] Failed to fetch snapshots from KV:', err);
    return [];
  }
}

// ── Build summary ─────────────────────────────────────────────────────────────

function trendLabel(delta: number | undefined): 'rising' | 'falling' | 'stable' {
  if (delta === undefined || Math.abs(delta) < 1e-6) return 'stable';
  return delta > 0 ? 'rising' : 'falling';
}

function metricSummary(
  snapshots: TelemetrySnapshot[],
  key: keyof Pick<
    TelemetrySnapshot,
    'agentCount' | 'genomeDiversity' | 'birthDeathRatio' | 'spatialEntropy'
  >,
): MetricSummary {
  const current = snapshots[0]?.[key] as number ?? 0;
  const at5  = snapshots[4]?.[key] as number | undefined;
  const at20 = snapshots[19]?.[key] as number | undefined;
  const delta5  = at5  !== undefined ? current - at5  : undefined;
  const delta20 = at20 !== undefined ? current - at20 : undefined;
  return { current, delta5, delta20, trend: trendLabel(delta5) };
}

/**
 * Build a structured summary from the last `n` snapshots.
 * Snapshots are expected newest-first (as stored by LPUSH).
 */
export function buildSummary(snapshots: TelemetrySnapshot[]): SimulationStateSummary {
  const latest = snapshots[0];
  const asOf = latest
    ? new Date(latest.timestamp).toISOString()
    : 'no data';

  // Collect all anomalies from the most recent 5 snapshots, deduplicated by metric
  const seenMetrics = new Set<string>();
  const recentAnomalies: AnomalyFlag[] = [];
  for (const snap of snapshots.slice(0, 5)) {
    for (const flag of snap.anomalies) {
      if (!seenMetrics.has(flag.metric)) {
        seenMetrics.add(flag.metric);
        recentAnomalies.push(flag);
      }
    }
  }

  return {
    asOf,
    snapshotCount: snapshots.length,
    agentCount:      metricSummary(snapshots, 'agentCount'),
    genomeDiversity: metricSummary(snapshots, 'genomeDiversity'),
    birthDeathRatio: metricSummary(snapshots, 'birthDeathRatio'),
    spatialEntropy:  metricSummary(snapshots, 'spatialEntropy'),
    recentAnomalies,
  };
}

// ── Format for agent prompt ───────────────────────────────────────────────────

function fmt(value: number, precision: number = 2): string {
  return value.toFixed(precision);
}

function fmtDelta(delta: number | undefined, precision: number = 2): string {
  if (delta === undefined) return 'n/a';
  const sign = delta >= 0 ? '+' : '';
  return `${sign}${delta.toFixed(precision)}`;
}

/**
 * Render the summary as a Markdown section suitable for prepending to an
 * agent prompt.  Uses delta-first formatting so agents reason about trajectory,
 * not current state.
 *
 * Example output:
 * ```
 * ## Current simulation state
 * _As of 2025-01-15T12:34:56.000Z — based on 17 snapshots_
 *
 * | Metric | Current | Δ last 5 snapshots | Δ last 20 snapshots | Trend |
 * ...
 * ```
 */
export function formatForPrompt(summary: SimulationStateSummary): string {
  const rows = [
    [
      'Agent count',
      fmt(summary.agentCount.current, 0),
      fmtDelta(summary.agentCount.delta5, 0),
      fmtDelta(summary.agentCount.delta20, 0),
      summary.agentCount.trend,
    ],
    [
      'Genome diversity',
      fmt(summary.genomeDiversity.current),
      fmtDelta(summary.genomeDiversity.delta5),
      fmtDelta(summary.genomeDiversity.delta20),
      summary.genomeDiversity.trend,
    ],
    [
      'Birth/death ratio',
      fmt(summary.birthDeathRatio.current),
      fmtDelta(summary.birthDeathRatio.delta5),
      fmtDelta(summary.birthDeathRatio.delta20),
      summary.birthDeathRatio.trend,
    ],
    [
      'Spatial entropy',
      fmt(summary.spatialEntropy.current),
      fmtDelta(summary.spatialEntropy.delta5),
      fmtDelta(summary.spatialEntropy.delta20),
      summary.spatialEntropy.trend,
    ],
  ];

  const header = '| Metric | Current | Δ last 5 snapshots | Δ last 20 snapshots | Trend |';
  const divider = '|--------|---------|---------------------|----------------------|-------|';
  const tableRows = rows
    .map(([name, cur, d5, d20, trend]) => `| ${name} | ${cur} | ${d5} | ${d20} | ${trend} |`)
    .join('\n');

  let anomalySection = '';
  if (summary.recentAnomalies.length > 0) {
    const flags = summary.recentAnomalies
      .map(a => `- **${a.metric}**: ${a.description} (current: ${fmt(a.value)}, baseline: ${fmt(a.baseline)})`)
      .join('\n');
    anomalySection = `\n\n### ⚠️ Recent anomalies\n${flags}`;
  }

  return [
    '## Current simulation state',
    `_As of ${summary.asOf} — based on ${summary.snapshotCount} snapshot(s)_`,
    '',
    header,
    divider,
    tableRows,
    anomalySection,
  ].join('\n');
}

// ── Main export: fetch + format in one call ───────────────────────────────────

/**
 * Convenience function: fetch recent snapshots and return a formatted Markdown
 * block ready to prepend to any agent prompt.
 *
 * Returns an empty string if no snapshots are available (tolerate gracefully).
 */
export async function buildTelemetryPromptSection(snapshotCount: number = 20): Promise<string> {
  const snapshots = await fetchRecentSnapshots(snapshotCount);
  if (snapshots.length === 0) {
    return '## Current simulation state\n_No telemetry data available yet._\n';
  }
  const summary = buildSummary(snapshots);
  return formatForPrompt(summary);
}
