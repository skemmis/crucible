import { World, DEFAULT_CONFIG } from './world/World';
import { Renderer } from './render/Renderer';

// ── Canvas setup ─────────────────────────────────────────────────────────────

const canvas = document.getElementById('canvas') as HTMLCanvasElement;
function resize() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}
resize();
window.addEventListener('resize', resize);

// ── World ─────────────────────────────────────────────────────────────────────

const GROUND_Y = canvas.height - 90;

const world = new World({
  ...DEFAULT_CONFIG,
  groundY: GROUND_Y,
});

const renderer = new Renderer(canvas);

// Expose for browser-console debugging / camera control
(window as any).sim = { world, renderer, get paused() { return paused; }, set paused(v) { paused = v; }, get speed() { return speed; }, set speed(v) { speed = v; } };

// Start camera roughly centered on the world
renderer.cameraX = world.worldWidth / 2 - canvas.width / 2;

// ── Sim state ─────────────────────────────────────────────────────────────────

let paused = false;
let speed = 1;         // simulation steps per render frame
let followSelected = false;

// ── Input ─────────────────────────────────────────────────────────────────────

let dragging = false;
let lastMX = 0;

canvas.addEventListener('mousedown', e => {
  dragging = true;
  lastMX = e.clientX;

  // Click to select nearest agent
  const w = renderer.screenToWorld(e.clientX, e.clientY);
  let best: typeof world.agents[0] | null = null;
  let bestDist = 40 / renderer.zoom; // 40px hit radius in screen space
  for (const a of world.agents) {
    const c = a.centerPos;
    const d = Math.hypot(c.x - w.x, c.y - w.y);
    if (d < bestDist) { bestDist = d; best = a; }
  }
  renderer.selectedAgent = best;
  followSelected = best !== null;
});

canvas.addEventListener('mousemove', e => {
  if (dragging && !followSelected) {
    renderer.cameraX -= (e.clientX - lastMX) / renderer.zoom;
  }
  lastMX = e.clientX;
});

canvas.addEventListener('mouseup', () => { dragging = false; });
canvas.addEventListener('mouseleave', () => { dragging = false; });

canvas.addEventListener('wheel', e => {
  e.preventDefault();
  const factor = e.deltaY < 0 ? 1.12 : 0.89;
  renderer.zoom = Math.max(0.15, Math.min(5, renderer.zoom * factor));
}, { passive: false });

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
      // Reset camera
      renderer.cameraX = 0;
      renderer.zoom = 1;
      break;
  }
});

// ── HUD ───────────────────────────────────────────────────────────────────────

const elTime    = document.getElementById('stat-time')!;
const elAgents  = document.getElementById('stat-agents')!;
const elGen     = document.getElementById('stat-gen')!;
const elSpeed   = document.getElementById('stat-speed')!;
const elPanel   = document.getElementById('agent-stats')!;

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
      `Dist: ${inf.distanceTravelled.toFixed(0)}px`;
  } else {
    if (sel?.dead) { renderer.selectedAgent = null; followSelected = false; }
    elPanel.style.display = 'none';
  }
}

// ── Main loop ─────────────────────────────────────────────────────────────────

const FIXED_DT = 1 / 60;
let lastTimestamp = 0;

function loop(ts: number): void {
  const elapsed = Math.min((ts - lastTimestamp) / 1000, 0.1); // cap at 100ms
  lastTimestamp = ts;

  if (!paused) {
    // Sub-steps: each real frame runs `speed` sim steps
    const steps = Math.max(1, Math.round(speed));
    for (let i = 0; i < steps; i++) {
      world.update(FIXED_DT);
    }
  }

  // Camera follow
  if (followSelected && renderer.selectedAgent && !renderer.selectedAgent.dead) {
    renderer.panTo(renderer.selectedAgent);
  } else if (followSelected) {
    followSelected = false;
  }
  renderer.clampCamera(world.worldWidth);

  renderer.render(world);
  updateHUD();

  requestAnimationFrame(loop);
}

requestAnimationFrame(loop);
