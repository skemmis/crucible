```typescript
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@vercel/kv';

/**
 * POST /api/telemetry
 *
 * Receives a TelemetrySnapshot JSON body from the browser simulation and
 * stores it in Vercel KV.  Returns the list key so callers can reference it.
 *
 * Storage layout in KV:
 *   crucible:telemetry:snapshots  — Redis LIST (newest first, capped at 100)
 *   crucible:telemetry:latest     — STRING  (JSON of most-recent snapshot, for quick reads)
 */

const MAX_STORED_SNAPSHOTS = 100;
const LIST_KEY = 'crucible:telemetry:snapshots';
const LATEST_KEY = 'crucible:telemetry:latest';

const kv = createClient({
  url: process.env.KV_REST_API_URL ?? '',
  token: process.env.KV_REST_API_TOKEN ?? '',
});

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method Not Allowed' });
    return;
  }

  let body: unknown;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch {
    res.status(400).json({ error: 'Invalid JSON body' });
    return;
  }

  if (!body || typeof body !== 'object') {
    res.status(400).json({ error: 'Body must be a JSON object' });
    return;
  }

  const snapshot = body as Record<string, unknown>;

  // Basic shape validation — we don't want garbage in KV
  if (typeof snapshot['timestamp'] !== 'number' || typeof snapshot['simTime'] !== 'number') {
    res.status(400).json({ error: 'Snapshot missing required fields: timestamp, simTime' });
    return;
  }

  const serialized = JSON.stringify(snapshot);

  // Prepend to the list (LPUSH) then trim to cap at MAX_STORED_SNAPSHOTS
  await kv.lpush(LIST_KEY, serialized);
  await kv.ltrim(LIST_KEY, 0, MAX_STORED_SNAPSHOTS - 1);

  // Keep a quick-access "latest" key
  await kv.set(LATEST_KEY, serialized);

  res.status(200).json({ ok: true, stored: LIST_KEY });
}
```
