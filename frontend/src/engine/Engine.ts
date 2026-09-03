import * as THREE from "three";
import {
  CAMERA_FAR,
  CAMERA_FOV_DEG,
  CAMERA_NEAR,
  FOG_COLOR,
  FOG_DENSITY,
  TELEPORT_MAX_MS,
  TELEPORT_MIN_MS,
  TELEPORT_MS_PER_WORLD_UNIT,
} from "../config.ts";
import { Starfield } from "./Starfield.ts";

export type TickCallback = (deltaSeconds: number, elapsedSeconds: number) => void;

export interface TeleportOptions {
  /** Point to face on arrival. Orientation is slerped toward it during the
   * flight; if omitted the camera keeps its current orientation. */
  lookAt?: THREE.Vector3;
  /** Override the distance-derived duration. */
  durationMs?: number;
  /** Fired once, on the frame the flight completes. */
  onArrive?: () => void;
}

/** In-flight teleport state. Position and orientation are both interpolated
 * from a fixed start snapshot, which is why flight/look input has to stand
 * down for the duration (see `isTeleporting`). */
interface TeleportState {
  fromPosition: THREE.Vector3;
  toPosition: THREE.Vector3;
  fromQuaternion: THREE.Quaternion;
  toQuaternion: THREE.Quaternion;
  elapsedMs: number;
  durationMs: number;
  onArrive?: () => void;
}

/** Smooth acceleration out and deceleration in — the cheapest easing that
 * reads as "flew there" rather than "was dragged there". */
function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

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
  /** The backdrop shell (see `Starfield.ts`). Owned here because it is part of
   * the scene's environment — the same category as the clear color and the fog
   * — not part of any dataset's content. */
  readonly starfield: Starfield;

  private container: HTMLElement;
  private onUpdate: TickCallback | null = null;
  private rafHandle = 0;
  private teleport: TeleportState | null = null;
  private readonly teleportScratch = new THREE.Matrix4();
  private readonly worldUp = new THREE.Vector3(0, 1, 0);

  constructor(container: HTMLElement) {
    this.container = container;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setClearColor(0x05060a, 1);
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    // Depth cues for a black void (see config.ts's "Environment" section).
    //
    // Set here, in the constructor, rather than anywhere downstream: whether a
    // scene has fog is baked into every material's compiled program as
    // `USE_FOG`, and the voxel material additionally pins its own
    // `customProgramCacheKey`. Establishing the fog before a single material
    // exists means nothing has to depend on three noticing a later change (or
    // on someone remembering a `needsUpdate` on every chunk material as it
    // streams in), and no frame can render fogged proxy cubes against unfogged
    // voxels.
    this.scene.fog = new THREE.FogExp2(FOG_COLOR, FOG_DENSITY);
    this.starfield = new Starfield();
    this.scene.add(this.starfield.points);

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

  /**
   * Flies the camera to `destination` over a short eased animation.
   *
   * Deliberately does NOT itself prefetch anything — the caller is expected to
   * kick off streaming for the destination *before* calling this (see
   * `ChunkStore.prioritizeTeleport`), so the fetches overlap the flight
   * instead of starting when it ends. Nor does it touch `FlightControls`:
   * Engine stays free of any controls dependency, so the caller passes an
   * `onArrive` that re-syncs whatever owns yaw/pitch (`FlightControls.lookAt`)
   * from the final pose.
   *
   * A second call replaces an in-flight teleport (the previous one's
   * `onArrive` does not fire — it never arrived).
   */
  teleportTo(destination: THREE.Vector3, options: TeleportOptions = {}): void {
    const fromPosition = this.camera.position.clone();
    const toPosition = destination.clone();
    const fromQuaternion = this.camera.quaternion.clone();
    let toQuaternion = fromQuaternion.clone();
    if (options.lookAt) {
      // Matrix4.lookAt with a world up gives a roll-free orientation, matching
      // what `Object3D.lookAt` (and therefore `FlightControls.lookAt`) will
      // produce at the destination — so the slerp lands exactly where the
      // arrival re-sync puts it, with no snap on the last frame.
      this.teleportScratch.lookAt(toPosition, options.lookAt, this.worldUp);
      toQuaternion = new THREE.Quaternion().setFromRotationMatrix(this.teleportScratch);
    }

    const distance = fromPosition.distanceTo(toPosition);
    const durationMs =
      options.durationMs ??
      Math.min(TELEPORT_MAX_MS, Math.max(TELEPORT_MIN_MS, distance * TELEPORT_MS_PER_WORLD_UNIT));

    this.teleport = {
      fromPosition,
      toPosition,
      fromQuaternion,
      toQuaternion,
      elapsedMs: 0,
      durationMs,
      onArrive: options.onArrive,
    };
  }

  /**
   * True while a teleport flight is in progress. Callers driving the camera
   * (flight controls, look-drag) must stand down while this is set: the
   * animation interpolates from a fixed start snapshot every frame, so any
   * input applied in between is silently discarded rather than composed.
   */
  get isTeleporting(): boolean {
    return this.teleport !== null;
  }

  /** Abandons an in-flight teleport where it currently is; `onArrive` does
   * not fire. */
  cancelTeleport(): void {
    this.teleport = null;
  }

  private stepTeleport(dt: number): void {
    const state = this.teleport;
    if (!state) return;
    state.elapsedMs += dt * 1000;
    const raw = Math.min(1, state.elapsedMs / state.durationMs);
    const t = easeInOutCubic(raw);
    this.camera.position.lerpVectors(state.fromPosition, state.toPosition, t);
    this.camera.quaternion.slerpQuaternions(state.fromQuaternion, state.toQuaternion, t);
    if (raw >= 1) {
      this.teleport = null;
      state.onArrive?.();
    }
  }

  private loop = (timestamp: number) => {
    this.rafHandle = requestAnimationFrame(this.loop);
    this.timer.update(timestamp);
    // still clamp defensively — Timer's visibility-API guard covers the
    // hidden-tab case, but not e.g. a slow synchronous stall while visible.
    const dt = Math.min(this.timer.getDelta(), 0.1);
    const elapsed = this.timer.getElapsed();
    // Teleport advances BEFORE onUpdate so everything the tick callback does
    // with the camera this frame — chunk ring classification, hover raycast,
    // HUD readout — sees the pose the frame will actually be rendered from.
    this.stepTeleport(dt);
    this.onUpdate?.(dt, elapsed);
    this.renderer.render(this.scene, this.camera);
  };

  dispose(): void {
    this.stop();
    this.starfield.dispose();
    this.timer.dispose();
    window.removeEventListener("resize", this.handleResize);
    this.renderer.dispose();
    this.container.removeChild(this.renderer.domElement);
  }
}
