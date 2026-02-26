import { World, DEFAULT_CONFIG, TelemetrySnapshot } from './world/World';
import { Renderer } from './render/Renderer';

// ── Container ──────────────────────────────────────────────────────────────────

const container = document.getElementById('app')!;

// ── World ──────────────────────────────────────────────────────────────────────

const world = new World(DEFAULT_CONFIG);

// ── Renderer ───────────────────────────────────────────────────────────────────

const renderer = new Renderer(container);
renderer.resetCamera(world.worldWidth, world.worldDepth);

// ── Sim state ──────────────────────────────────────────────────────────────────

let paused = false;
let speed = 1;
let followSelected = false;

// Expose for browser-console debugging
(window as any).sim = {
  world,
  renderer,
  get paused() { return paused; },
  set paused(v) { paused = v; },
  get speed() { return speed; },
  set speed(v) { speed = v; },
};

// ── Input ──────────────────────────────────────────────────────────────────────

const canvas = renderer.renderer.domElement;

canvas.addEventListener('click', e => {
  const agent = renderer.pickAgent(e.clientX, e.clientY, world.agents);
  renderer.selectedAgent = agent;
  followSelected = agent !== null;
});

window.addEventListener('keydown', e => {
  switch (e.key) {
    case ' ':
      paused = !paused;
      e.preventDefault();
      break;
    case '>':
    case '.':
      speed = Math.min(16, speed * 2);
      break;
    case '<':
    case ',':
      speed = Math.max(0.5, speed / 2);
      break;
    case 'Escape':
      renderer.selectedAgent = null;
      followSelected = false;
      break;
    case 'r':
    case 'R':
      renderer.resetCamera(world.worldWidth, world.worldDepth);
      renderer.selectedAgent = null;
      followSelected = false;
      break;
  }
});

// ── HUD ────────────────────────────────────────────────────────────────────────

const elTime   = document.getElementById('stat-time')!;
const elAgents = document.getElementById('stat-agents')!;
const elGen    = document.getElementById('stat-gen')!;
const elSpeed  = document.getElementById('stat-speed')!;
const elPanel  = document.getElementById('agent-stats')!;

function updateHUD(): void {
  const s = world.stats;
  elTime.textContent   = `Time: ${s.time.toFixed(1)}s`;
  elAgents.textContent = `Agents: ${s.agentCount}`;
  elGen.textContent    = `Max Gen: ${s.maxGeneration}`;
  elSpeed.textContent  = `Speed: ${speed}× ${paused ? '(paused)' : ''}`;

  const sel = renderer.selectedAgent;
  if (sel && !sel.dead) {
    const inf = sel.inspect();
    elPanel.style.display = 'block';
    elPanel.innerHTML =
      `<strong>Agent #${inf.id}</strong><br>` +
      `Gen: ${inf.generation}  Parent: ${inf.parentId ?? '—'}<br>` +
      `Energy: ${inf.energy.toFixed(1)}<br>` +
      `Age: ${inf.age.toFixed(1)}s<br>` +
      `Nodes: ${inf.nodes}  Muscles: ${inf.muscles}<br>` +
      `Dist: ${inf.distanceTravelled.toFixed(0)}u`;
  } else {
    if (sel?.dead) { renderer.selectedAgent = null; followSelected = false; }
    elPanel.style.display = 'none';
  }
}

// ── Telemetry ──────────────────────────────────────────────────────────────────

const TELEMETRY_INTERVAL_MS = 60_000;
const TELEMETRY_ENDPOINT = '/api/telemetry';

/**
 * Post a snapshot to the telemetry endpoint.
 * Fire-and-forget — we log failures but never throw.
 */
function postSnapshot(snapshot: TelemetrySnapshot): void {
  fetch(TELEMETRY_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(snapshot),
  }).catch(err => {
    console.warn('[telemetry] Failed to post snapshot:', err);
  });
}

/**
 * Capture a snapshot and optionally attach a canvas JPEG.
 * Canvas capture is only performed when anomalies are present, keeping
 * toDataURL() off the render hot-path.
 */
function captureAndPost(forceCanvasCapture: boolean = false): void {
  // First pass: compute snapshot without canvas to check for anomalies
  const preliminary = world.captureSnapshot();
  const hasAnomaly = preliminary.anomalies.length > 0;

  if (hasAnomaly || forceCanvasCapture) {
    // Only do the synchronous GPU readback when we actually need an image
    let dataUrl: string | undefined;
    try {
      dataUrl = renderer.renderer.domElement.toDataURL('image/jpeg', 0.4);
    } catch {
      // toDataURL can fail if canvas is tainted or context is lost
      dataUrl = undefined;
    }
    // Re-capture with canvas attached (snapshot is cheap — no O(n²) ops)
    const fullSnapshot = world.captureSnapshot(dataUrl);
    postSnapshot(fullSnapshot);

    if (hasAnomaly) {
      console.info(
        '[telemetry] Anomaly snapshot posted:',
        fullSnapshot.anomalies.map(a => a.description).join('; '),
      );
    }
  } else {
    postSnapshot(preliminary);
  }
}

// Periodic snapshot — every 60 seconds regardless of anomalies
setInterval(() => captureAndPost(), TELEMETRY_INTERVAL_MS);

// ── Main loop ──────────────────────────────────────────────────────────────────

const FIXED_DT = 1 / 60;

function loop(): void {
  requestAnimationFrame(loop);

  if (!paused) {
    const steps = Math.max(1, Math.round(speed));
    for (let i = 0; i < steps; i++) {
      world.update(FIXED_DT);
    }
  }

  // Camera follow
  if (followSelected && renderer.selectedAgent && !renderer.selectedAgent.dead) {
    renderer.followAgent(renderer.selectedAgent);
  } else if (followSelected) {
    followSelected = false;
  }

  renderer.render(world);
  updateHUD();
}

requestAnimationFrame(loop);
