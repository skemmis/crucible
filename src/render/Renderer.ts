import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { World } from '../world/World';
import { Agent } from '../agent/Agent';
import { EnergyZone } from '../world/Environment';

// Pre-allocate generous upper bounds — never reallocate during the sim
const MAX_NODES = 600;
const MAX_SPRINGS = 1800;

// Per-tier visual palette
const TIER_COLORS = [
  new THREE.Color(0x3cdc50),   // 0: ground — green
  new THREE.Color(0xb8e020),   // 1: mid    — yellow-green
  new THREE.Color(0xff8c00),   // 2: high   — amber
];

interface ZoneVisual {
  disc: THREE.Mesh;
  stem: THREE.Mesh | null; // null for ground-tier zones
}

export class Renderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;

  selectedAgent: Agent | null = null;

  // ── instanced nodes ──
  private _nodeMesh: THREE.InstancedMesh;
  private _dummy = new THREE.Object3D();
  private _nodeColor = new THREE.Color();

  // ── spring lines ──
  private _springPositions: Float32Array;
  private _springColors: Float32Array;
  private _springGeo: THREE.BufferGeometry;
  private _springLines: THREE.LineSegments;

  // ── energy zones ──
  private _zoneVisuals: ZoneVisual[] = [];

  // ── selection indicator ──
  private _selectionRing: THREE.Mesh;

  // ── ground ──
  private _groundMesh: THREE.Mesh;
  private _groundInitialized = false;

  constructor(container: HTMLElement) {
    // ── Renderer ──────────────────────────────────────────────────────────────
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    container.appendChild(this.renderer.domElement);

    // ── Scene ─────────────────────────────────────────────────────────────────
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x070b14);
    this.scene.fog = new THREE.FogExp2(0x070b14, 0.00045);

    // ── Camera ────────────────────────────────────────────────────────────────
    this.camera = new THREE.PerspectiveCamera(
      55,
      container.clientWidth / container.clientHeight,
      1,
      6000,
    );
    this.camera.position.set(600, 600, 1300);

    // ── Controls ──────────────────────────────────────────────────────────────
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(600, 60, 600);   // look toward mid-tier height
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 30;
    this.controls.maxDistance = 4000;
    this.controls.maxPolarAngle = Math.PI / 2 - 0.01;
    this.controls.update();

    // ── Lighting ──────────────────────────────────────────────────────────────
    this.scene.add(new THREE.AmbientLight(0x556688, 1.5));
    const sun = new THREE.DirectionalLight(0xffeedd, 2.2);
    sun.position.set(500, 1000, 300);
    this.scene.add(sun);
    const fill = new THREE.DirectionalLight(0x3355aa, 0.5);
    fill.position.set(-300, 200, -300);
    this.scene.add(fill);

    // ── Ground plane ──────────────────────────────────────────────────────────
    const groundGeo = new THREE.PlaneGeometry(1, 1);
    groundGeo.rotateX(-Math.PI / 2);
    const groundMat = new THREE.MeshLambertMaterial({ color: 0x111e11 });
    this._groundMesh = new THREE.Mesh(groundGeo, groundMat);
    this.scene.add(this._groundMesh);

    // ── Nodes (InstancedMesh) ─────────────────────────────────────────────────
    const sphereGeo = new THREE.SphereGeometry(1, 10, 7);
    const nodeMat = new THREE.MeshPhongMaterial({ shininess: 40 });
    this._nodeMesh = new THREE.InstancedMesh(sphereGeo, nodeMat, MAX_NODES);
    this._nodeMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this._nodeMesh.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(MAX_NODES * 3), 3,
    );
    (this._nodeMesh.instanceColor as THREE.InstancedBufferAttribute)
      .setUsage(THREE.DynamicDrawUsage);
    this._nodeMesh.count = 0;
    this.scene.add(this._nodeMesh);

    // ── Springs (LineSegments) ────────────────────────────────────────────────
    this._springPositions = new Float32Array(MAX_SPRINGS * 2 * 3);
    this._springColors = new Float32Array(MAX_SPRINGS * 2 * 3);
    this._springGeo = new THREE.BufferGeometry();
    this._springGeo.setAttribute(
      'position',
      new THREE.BufferAttribute(this._springPositions, 3).setUsage(THREE.DynamicDrawUsage),
    );
    this._springGeo.setAttribute(
      'color',
      new THREE.BufferAttribute(this._springColors, 3).setUsage(THREE.DynamicDrawUsage),
    );
    const springMat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.85,
    });
    this._springLines = new THREE.LineSegments(this._springGeo, springMat);
    this.scene.add(this._springLines);

    // ── Selection ring ────────────────────────────────────────────────────────
    const ringGeo = new THREE.RingGeometry(0.85, 1.15, 32);
    ringGeo.rotateX(-Math.PI / 2);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.75,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this._selectionRing = new THREE.Mesh(ringGeo, ringMat);
    this._selectionRing.visible = false;
    this.scene.add(this._selectionRing);

    // ── Resize listener ───────────────────────────────────────────────────────
    window.addEventListener('resize', () => {
      const w = container.clientWidth;
      const h = container.clientHeight;
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(w, h);
    });
  }

  // ── Zone visual pool ──────────────────────────────────────────────────────────

  /**
   * Ensure we have enough disc + stem meshes for all zones.
   * We create them lazily and re-use across frames.
   */
  private _ensureZoneVisuals(zones: EnergyZone[]): void {
    while (this._zoneVisuals.length < zones.length) {
      const idx = this._zoneVisuals.length;
      const zone = zones[idx];
      const tier = zone?.tier ?? 0;
      const color = TIER_COLORS[tier];

      // Disc (flat circle)
      const discGeo = new THREE.CircleGeometry(1, 32);
      discGeo.rotateX(-Math.PI / 2);
      const discMat = new THREE.MeshBasicMaterial({
        color: color.clone(),
        transparent: true,
        opacity: 0.45,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const disc = new THREE.Mesh(discGeo, discMat);
      this.scene.add(disc);

      // Stem (thin cylinder from ground to zone height) — only for elevated tiers
      let stem: THREE.Mesh | null = null;
      if (tier > 0) {
        const stemGeo = new THREE.CylinderGeometry(1.5, 1.5, 1, 6);
        const stemMat = new THREE.MeshBasicMaterial({
          color: color.clone(),
          transparent: true,
          opacity: 0.18,
          depthWrite: false,
        });
        stem = new THREE.Mesh(stemGeo, stemMat);
        this.scene.add(stem);
      }

      this._zoneVisuals.push({ disc, stem });
    }
  }

  // ── Main render loop ──────────────────────────────────────────────────────────

  render(world: World): void {
    this.controls.update();

    // One-time ground + grid setup
    if (!this._groundInitialized) {
      this._groundMesh.scale.set(world.worldWidth, 1, world.worldDepth);
      this._groundMesh.position.set(world.worldWidth / 2, -0.2, world.worldDepth / 2);

      const grid = new THREE.GridHelper(
        Math.max(world.worldWidth, world.worldDepth),
        20,
        0x1e3a1e,
        0x1e3a1e,
      );
      grid.position.set(world.worldWidth / 2, 0.1, world.worldDepth / 2);
      this.scene.add(grid);

      this._groundInitialized = true;
    }

    this._renderZones(world);
    this._renderAgents(world);
    this._renderSelection();

    this.renderer.render(this.scene, this.camera);
  }

  // ── Zone rendering ────────────────────────────────────────────────────────────

  private _renderZones(world: World): void {
    const zones = world.env.zones;
    this._ensureZoneVisuals(zones);

    for (let i = 0; i < zones.length; i++) {
      const z = zones[i];
      const t = z.energy / z.maxEnergy;
      const vis = this._zoneVisuals[i];

      const visible = t > 0.02;
      vis.disc.visible = visible;
      if (vis.stem) vis.stem.visible = visible;
      if (!visible) continue;

      // Disc: positioned at zone centre, scaled to zone radius
      vis.disc.scale.set(z.radius, 1, z.radius);
      vis.disc.position.set(z.x, z.y + 0.5, z.z);
      (vis.disc.material as THREE.MeshBasicMaterial).opacity = t * 0.55;

      // Stem: cylinder from Y=0 to Y=z.y
      if (vis.stem && z.y > 0) {
        vis.stem.scale.set(1, z.y, 1);              // scaleY stretches the unit cylinder
        vis.stem.position.set(z.x, z.y / 2, z.z);  // centred vertically
        (vis.stem.material as THREE.MeshBasicMaterial).opacity = t * 0.22;
      }
    }

    for (let i = zones.length; i < this._zoneVisuals.length; i++) {
      this._zoneVisuals[i].disc.visible = false;
      if (this._zoneVisuals[i].stem) this._zoneVisuals[i].stem!.visible = false;
    }
  }

  // ── Agent rendering ───────────────────────────────────────────────────────────

  private _renderAgents(world: World): void {
    let nodeIdx = 0;
    let springIdx = 0;

    for (const agent of world.agents) {
      const hue = agent.hue / 360;
      const isSel = agent === this.selectedAgent;

      // ── Nodes ──────────────────────────────────────────────────────────────
      for (const node of agent.nodes) {
        if (nodeIdx >= MAX_NODES) break;

        this._dummy.position.set(node.pos.x, node.pos.y, node.pos.z);
        this._dummy.scale.setScalar(node.radius);
        this._dummy.updateMatrix();
        this._nodeMesh.setMatrixAt(nodeIdx, this._dummy.matrix);

        const energyRatio = Math.min(1, agent.energy / 250);
        const lightness = 0.38 + energyRatio * 0.32;
        this._nodeColor.setHSL(hue, 0.72, isSel ? lightness + 0.15 : lightness);
        this._nodeMesh.setColorAt(nodeIdx, this._nodeColor);

        nodeIdx++;
      }

      // ── Springs ────────────────────────────────────────────────────────────
      for (const spring of agent.springs) {
        if (springIdx >= MAX_SPRINGS) break;
        const b = springIdx * 6;

        this._springPositions[b + 0] = spring.nodeA.pos.x;
        this._springPositions[b + 1] = spring.nodeA.pos.y;
        this._springPositions[b + 2] = spring.nodeA.pos.z;
        this._springPositions[b + 3] = spring.nodeB.pos.x;
        this._springPositions[b + 4] = spring.nodeB.pos.y;
        this._springPositions[b + 5] = spring.nodeB.pos.z;

        if (spring.isActuated) {
          const act = spring.activation;
          const r = act > 0 ? act * 0.95 : 0.05;
          const g = act > 0 ? 0.05 : 0.15;
          const bl = act < 0 ? -act * 0.9 : 0.55;
          for (let v = 0; v < 2; v++) {
            this._springColors[b + v * 3 + 0] = r;
            this._springColors[b + v * 3 + 1] = g;
            this._springColors[b + v * 3 + 2] = bl;
          }
        } else {
          const grey = isSel ? 0.55 : 0.28;
          for (let k = 0; k < 6; k += 3) {
            this._springColors[b + k + 0] = grey;
            this._springColors[b + k + 1] = grey * 1.05;
            this._springColors[b + k + 2] = grey * 1.15;
          }
        }
        springIdx++;
      }
    }

    // Upload to GPU
    this._nodeMesh.count = nodeIdx;
    this._nodeMesh.instanceMatrix.needsUpdate = true;
    if (this._nodeMesh.instanceColor) this._nodeMesh.instanceColor.needsUpdate = true;

    this._springGeo.setDrawRange(0, springIdx * 2);
    (this._springGeo.attributes['position'] as THREE.BufferAttribute).needsUpdate = true;
    (this._springGeo.attributes['color'] as THREE.BufferAttribute).needsUpdate = true;
  }

  // ── Selection ring ────────────────────────────────────────────────────────────

  private _renderSelection(): void {
    const sel = this.selectedAgent;
    if (!sel || sel.dead) {
      this._selectionRing.visible = false;
      return;
    }
    const c = sel.centerPos;
    const r = sel.boundingRadius + 5;
    this._selectionRing.position.set(c.x, 0.5, c.z);
    this._selectionRing.scale.setScalar(r);
    this._selectionRing.visible = true;
  }

  // ── Camera helpers ────────────────────────────────────────────────────────────

  followAgent(agent: Agent): void {
    const c = agent.centerPos;
    this.controls.target.x += (c.x - this.controls.target.x) * 0.05;
    this.controls.target.y += (c.y - this.controls.target.y) * 0.05;
    this.controls.target.z += (c.z - this.controls.target.z) * 0.05;
  }

  resetCamera(worldWidth: number, worldDepth: number): void {
    const cx = worldWidth / 2;
    const cz = worldDepth / 2;
    this.camera.position.set(cx, worldWidth * 0.6, cz + worldWidth * 0.75);
    this.camera.lookAt(cx, 60, cz);
    this.controls.target.set(cx, 60, cz);   // orbit around mid-tier height
    this.controls.update();
  }

  pickAgent(screenX: number, screenY: number, agents: Agent[]): Agent | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndcX = ((screenX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -((screenY - rect.top) / rect.height) * 2 + 1;

    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera);

    let best: Agent | null = null;
    let bestDist = Infinity;
    for (const agent of agents) {
      const c = agent.centerPos;
      const sphere = new THREE.Sphere(
        new THREE.Vector3(c.x, c.y, c.z),
        agent.boundingRadius + 8,
      );
      const ray = raycaster.ray;
      if (ray.intersectsSphere(sphere)) {
        const d = ray.origin.distanceTo(new THREE.Vector3(c.x, c.y, c.z));
        if (d < bestDist) { bestDist = d; best = agent; }
      }
    }
    return best;
  }
}
