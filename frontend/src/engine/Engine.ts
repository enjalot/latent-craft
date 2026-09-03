import * as THREE from "three";
import { CAMERA_FAR, CAMERA_FOV_DEG, CAMERA_NEAR } from "../config.ts";

export type TickCallback = (deltaSeconds: number, elapsedSeconds: number) => void;

/**
 * Owns the renderer, scene, camera, and the continuous requestAnimationFrame
 * loop. Deliberately dumb: it doesn't know about voxels, controls, or the
 * HUD — callers register a per-frame `onUpdate` callback via `start()` and
 * Engine takes care of clock bookkeeping, resize, and the render call.
 *
 * Phase 2+ note: this stays a plain WebGLRenderer (not WebGPURenderer) per
 * the project plan's correction #3 — InstancedMesh2 doesn't support
 * WebGPURenderer yet, and our resident-instance budget is bounded by chunk
 * streaming rather than raw GPU instancing throughput, so the WebGPU
 * compute-instancing win doesn't apply here.
 */
export class Engine {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly timer: THREE.Timer;

  private container: HTMLElement;
  private onUpdate: TickCallback | null = null;
  private rafHandle = 0;

  constructor(container: HTMLElement) {
    this.container = container;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setClearColor(0x05060a, 1);
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();

    this.camera = new THREE.PerspectiveCamera(
      CAMERA_FOV_DEG,
      window.innerWidth / window.innerHeight,
      CAMERA_NEAR,
      CAMERA_FAR,
    );

    // THREE.Timer supersedes the deprecated THREE.Clock; it also uses the
    // Page Visibility API (via connect()) to avoid a huge dt spike the
    // first frame after a tab-switch/minimize, instead of us hand-rolling
    // that clamp.
    this.timer = new THREE.Timer();
    this.timer.connect(document);

    window.addEventListener("resize", this.handleResize);
  }

  private handleResize = () => {
    const width = window.innerWidth;
    const height = window.innerHeight;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  };

  /** Starts the continuous rAF loop. `onUpdate` runs before each render. */
  start(onUpdate: TickCallback): void {
    this.onUpdate = onUpdate;
    this.rafHandle = requestAnimationFrame(this.loop);
  }

  stop(): void {
    cancelAnimationFrame(this.rafHandle);
  }

  private loop = (timestamp: number) => {
    this.rafHandle = requestAnimationFrame(this.loop);
    this.timer.update(timestamp);
    // still clamp defensively — Timer's visibility-API guard covers the
    // hidden-tab case, but not e.g. a slow synchronous stall while visible.
    const dt = Math.min(this.timer.getDelta(), 0.1);
    const elapsed = this.timer.getElapsed();
    this.onUpdate?.(dt, elapsed);
    this.renderer.render(this.scene, this.camera);
  };

  dispose(): void {
    this.stop();
    this.timer.dispose();
    window.removeEventListener("resize", this.handleResize);
    this.renderer.dispose();
    this.container.removeChild(this.renderer.domElement);
  }
}
