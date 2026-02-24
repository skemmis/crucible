import { World, DEFAULT_CONFIG } from './world/World';
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
