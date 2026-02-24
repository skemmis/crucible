import { World } from '../world/World';
import { Agent } from '../agent/Agent';

/** Pixels from the bottom of the canvas where the ground line sits. */
const GROUND_MARGIN = 90;

export class Renderer {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;

  cameraX: number = 0;
  zoom: number = 1;
  selectedAgent: Agent | null = null;

  /** Cached groundY from the last render call — used in coordinate helpers. */
  private _groundY: number = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
  }

  // ── Transform helpers ────────────────────────────────────────────────────────

  /**
   * Screen y-coordinate where world.groundY always appears, regardless of zoom.
   * Keeps the ground anchored to GROUND_MARGIN px from the bottom.
   */
  private get _groundScreenY(): number {
    return this.canvas.height - GROUND_MARGIN;
  }

  /**
   * The full 2-D camera transform:
   *   screenX = zoom * (worldX - cameraX)
   *   screenY = groundScreenY + zoom * (worldY - groundY)
   *
   * This anchors world.groundY to the bottom of the viewport at any zoom level.
   */
  private _applyTransform(groundY: number): void {
    const { ctx } = this;
    const ty = this._groundScreenY - groundY * this.zoom;
    ctx.translate(-this.cameraX * this.zoom, ty);
    ctx.scale(this.zoom, this.zoom);
  }

  screenToWorld(sx: number, sy: number): { x: number; y: number } {
    return {
      x: sx / this.zoom + this.cameraX,
      y: (sy - this._groundScreenY) / this.zoom + this._groundY,
    };
  }

  // ── Main render ──────────────────────────────────────────────────────────────

  render(world: World): void {
    const { ctx, canvas } = this;
    this._groundY = world.groundY;
    const W = canvas.width;
    const H = canvas.height;

    // Sky — full screen, drawn before world transform
    ctx.clearRect(0, 0, W, H);
    const sky = ctx.createLinearGradient(0, 0, 0, this._groundScreenY);
    sky.addColorStop(0, '#050710');
    sky.addColorStop(1, '#0c1828');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, H);

    // World-space content
    ctx.save();
    this._applyTransform(world.groundY);

    this._drawGround(world.worldWidth, world.groundY);
    this._drawEnvironment(world);
    this._drawAgents(world);

    ctx.restore();
  }

  // ── Ground ───────────────────────────────────────────────────────────────────

  private _drawGround(worldWidth: number, groundY: number): void {
    const ctx = this.ctx;
    // Soil fill — extends "downward" far enough for any zoom
    ctx.fillStyle = '#111e11';
    ctx.fillRect(0, groundY, worldWidth, 2000 / this.zoom);
    // Surface line — keep it 2 screen-pixels thick
    ctx.strokeStyle = '#3a5a3a';
    ctx.lineWidth = 2 / this.zoom;
    ctx.beginPath();
    ctx.moveTo(0, groundY);
    ctx.lineTo(worldWidth, groundY);
    ctx.stroke();
  }

  // ── Environment ──────────────────────────────────────────────────────────────

  private _drawEnvironment(world: World): void {
    const ctx = this.ctx;
    for (const z of world.env.zones) {
      const t = z.energy / z.maxEnergy;
      if (t < 0.02) continue;
      const grad = ctx.createRadialGradient(z.x, z.y, 0, z.x, z.y, z.radius);
      grad.addColorStop(0, `rgba(60,220,80,${(t * 0.55).toFixed(3)})`);
      grad.addColorStop(0.5, `rgba(40,180,60,${(t * 0.22).toFixed(3)})`);
      grad.addColorStop(1, 'rgba(40,180,60,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(z.x, z.y, z.radius, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // ── Agents ───────────────────────────────────────────────────────────────────

  private _drawAgents(world: World): void {
    const ctx = this.ctx;
    for (const agent of world.agents) {
      this._drawAgent(ctx, agent, agent === this.selectedAgent);
    }
  }

  private _drawAgent(ctx: CanvasRenderingContext2D, agent: Agent, isSelected: boolean): void {
    const iz = 1 / this.zoom; // inverse zoom for screen-constant sizes

    // Springs
    for (const s of agent.springs) {
      const ax = s.nodeA.pos.x, ay = s.nodeA.pos.y;
      const bx = s.nodeB.pos.x, by = s.nodeB.pos.y;

      if (s.isActuated) {
        const act = s.activation; // [-1, 1]
        const r = act > 0 ? Math.floor(act * 220) : 0;
        const g = act < 0 ? Math.floor(-act * 200) : 50;
        ctx.strokeStyle = `rgba(${r},${g},130,0.88)`;
        ctx.lineWidth = 2.5 * iz;
      } else {
        ctx.strokeStyle = 'rgba(150,160,190,0.4)';
        ctx.lineWidth = 1.5 * iz;
      }
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
    }

    // Nodes
    const hue = agent.hue;
    for (const node of agent.nodes) {
      const r = node.radius;
      const grad = ctx.createRadialGradient(
        node.pos.x - r * 0.3, node.pos.y - r * 0.35, r * 0.08,
        node.pos.x, node.pos.y, r,
      );
      grad.addColorStop(0, `hsl(${hue},78%,80%)`);
      grad.addColorStop(1, `hsl(${hue},68%,38%)`);
      ctx.beginPath();
      ctx.arc(node.pos.x, node.pos.y, r, 0, Math.PI * 2);
      ctx.fillStyle = grad;
      ctx.fill();
      if (isSelected) {
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.lineWidth = 1.5 * iz;
        ctx.stroke();
      }
    }

    // Energy bar (always screen-constant size)
    const c = agent.centerPos;
    const barW = 28 * iz, barH = 3 * iz;
    const bx = c.x - barW / 2, by = c.y - 22 * iz;
    const ratio = Math.min(1, Math.max(0, agent.energy / 250));
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(bx, by, barW, barH);
    ctx.fillStyle = ratio > 0.5 ? '#4ef060' : ratio > 0.25 ? '#f0c040' : '#f04040';
    ctx.fillRect(bx, by, barW * ratio, barH);

    // Label on selected agent
    if (isSelected) {
      const label = `G${agent.generation} · #${agent.id}`;
      const fs = 10 * iz;
      ctx.font = `${fs}px monospace`;
      ctx.fillStyle = 'rgba(210,235,255,0.95)';
      ctx.fillText(label, c.x - ctx.measureText(label).width / 2, c.y - 26 * iz);
    }
  }

  // ── Camera helpers ───────────────────────────────────────────────────────────

  panTo(agent: Agent): void {
    const c = agent.centerPos;
    this.cameraX = c.x - this.canvas.width / (2 * this.zoom);
  }

  clampCamera(worldWidth: number): void {
    const visibleW = this.canvas.width / this.zoom;
    this.cameraX = Math.max(0, Math.min(worldWidth - visibleW, this.cameraX));
  }
}
