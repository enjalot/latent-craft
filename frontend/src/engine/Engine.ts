import * as THREE from "three";
import {
  CAMERA_FAR,
  CAMERA_FOV_DEG,
  CAMERA_NEAR,
  FOG_COLOR,
  HEADLAMP_BACKSET,
  HEADLAMP_COLOR,
  HEADLAMP_DECAY,
  HEADLAMP_INTENSITY,
  HEADLAMP_RANGE,
  TELEPORT_MAX_MS,
  TELEPORT_MIN_MS,
  TELEPORT_MS_PER_WORLD_UNIT,
} from "../config.ts";
import { createSceneFog } from "./Fog.ts";
import { NebulaSky } from "./NebulaSky.ts";
import { Starfield } from "./Starfield.ts";

export type TickCallback = (deltaSeconds: number, elapsedSeconds: number) => void;

export interface EngineOptions {
  /** Draw the procedural nebula cubemap as the background (default true);
   * false keeps the flat clear colour — the `?sky=0` A/B switch. */
  sky?: boolean;
  /** Carry the headlamp with the camera (default true); false leaves only the
   * distance-independent fill + sun — the `?headlamp=0` A/B switch. */
  headlamp?: boolean;
}

export interface TeleportOptions {
  /** Point to face on arrival. Yaw/pitch sweep toward it during the flight
   * (roll-free, see `TeleportState`); if omitted the camera keeps its current
   * orientation. */
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
  /**
   * Orientation as yaw/pitch (radians, 'YXZ' like `FlightControls`), not as
   * quaternions to slerp. A slerp between two roll-free poses is not itself
   * roll-free in between — for a big yaw change with a pitch change it goes
   * "over the top" and rolled the cockpit by up to ~20° mid-flight, which was
   * invisible on a 260-800 ms click-teleport and plainly visible on a 1.6 s
   * hover-pan. Sweeping yaw (the short way round, `deltaYaw` is wrapped) and
   * pitch directly is how the camera turns under the player's own look-drag,
   * keeps roll at exactly zero throughout, and lands on the same yaw/pitch
   * `FlightControls.lookAt` derives on arrival, so that re-sync is a no-op.
   */
  fromYaw: number;
  fromPitch: number;
  deltaYaw: number;
  deltaPitch: number;
  elapsedMs: number;
  durationMs: number;
  /** Progress curve for the from→to blend, on raw time 0..1. */
  blend: (t: number) => number;
  /**
   * Start tangents carried over from the flight this one replaced, in
   * Hermite form (velocity × duration): a world-space offset for position, and
   * a dimensionless rate for the yaw/pitch blend parameter. Both zero for a
   * flight that starts from rest, which makes the `hermite10` terms in
   * `stepTeleport` vanish and the curve collapse to plain `blend`. See
   * `teleportTo`.
   */
  positionTangent: THREE.Vector3;
  rotationTangent: number;
  onArrive?: () => void;
}

/** Smooth acceleration out and deceleration in — the cheapest easing that
 * reads as "flew there" rather than "was dragged there". The curve for a
 * flight that starts from rest. */
function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/**
 * Cubic Hermite basis for a flight that starts already moving: `hermite01`
 * blends from→to (it is smoothstep, i.e. the Hermite curve from rest to rest)
 * and `hermite10` carries the start tangent, rising from 0 with unit slope and
 * settling back to 0 with zero slope. The end tangent is always zero — every
 * flight comes to rest at its destination — so the `h11` basis is never
 * needed.
 */
function hermite01(t: number): number {
  return t * t * (3 - 2 * t);
}
function hermite10(t: number): number {
  return t * (1 - t) * (1 - t);
}

/**
 * Largest carried tangent, as a multiple of the flight's own span. A cubic
 * Hermite with start tangent `k × span` and zero end tangent is monotone with
 * no overshoot for `0 ≤ k ≤ 3` (at exactly 3 it IS ease-out cubic); past 3 it
 * flies through the destination and comes back. So a replacement flight keeps
 * whatever speed the camera already has up to the point where honouring it
 * would mean overshooting a nearby destination, and clips there. A bound of
 * the math, not a feel knob — hence here rather than in config.
 */
const MAX_CARRIED_TANGENT = 3;

/** Wraps an angle difference into (-π, π] so a yaw sweep takes the short way
 * round rather than spinning the long way through the back. */
function wrapAngle(delta: number): number {
  return delta - Math.round(delta / (2 * Math.PI)) * 2 * Math.PI;
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
  /** The nebula cubemap behind the stars (see `NebulaSky.ts`), or null under
   * `?sky=0`. Same ownership argument as the starfield. */
  readonly sky: NebulaSky | null;
  /** The camera-carried point light (see `HEADLAMP_*` in config.ts), or null
   * under `?headlamp=0`. Owned here because following the camera has to happen
   * after the tick callback has moved it and before the render — i.e. inside
   * `loop`, which nothing outside Engine can get between. */
  readonly headlamp: THREE.PointLight | null;

  private container: HTMLElement;
  private onUpdate: TickCallback | null = null;
  private rafHandle = 0;
  private teleport: TeleportState | null = null;
  private readonly teleportScratch = new THREE.Matrix4();
  private readonly worldUp = new THREE.Vector3(0, 1, 0);
  /** The camera's actual motion over the last teleport step — world units/s
   * and yaw/pitch radians/s — so a flight that replaces this one can pick up
   * where it is moving, not just where it is (see `teleportTo`). Zero whenever
   * no flight is in progress. */
  private readonly flightVelocity = new THREE.Vector3();
  private flightAngularRate = 0;
  private readonly stepFromPosition = new THREE.Vector3();
  private readonly flightEuler = new THREE.Euler(0, 0, 0, "YXZ");
  private readonly headlampBackward = new THREE.Vector3();

  constructor(container: HTMLElement, options: EngineOptions = {}) {
    this.container = container;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setClearColor(FOG_COLOR, 1);
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
    // streams in), and no frame can render fogged proxy voxels against
    // unfogged textured ones. `createSceneFog` also swaps in the fog curve (see `Fog.ts`),
    // which has to precede the first compile for the same reason.
    this.scene.fog = createSceneFog();
    // The sky renders its cubemap right here, before the starfield or anything
    // else exists — it is the first thing the renderer ever draws, into an
    // offscreen target, so the main scene never sees a frame without it.
    this.sky = options.sky === false ? null : new NebulaSky(this.renderer);
    if (this.sky) this.scene.background = this.sky.texture;
    this.starfield = new Starfield();
    this.scene.add(this.starfield.points);

    this.camera = new THREE.PerspectiveCamera(
      CAMERA_FOV_DEG,
      window.innerWidth / window.innerHeight,
      CAMERA_NEAR,
      CAMERA_FAR,
    );

    // The headlamp is a plain scene child re-placed every frame (`loop`)
    // rather than a child of the camera: the camera is not in the scene graph,
    // and three only collects lights it finds by traversing the scene. Present
    // from the start so every material compiles with its one point light once,
    // instead of recompiling the moment it appears.
    if (options.headlamp === false) {
      this.headlamp = null;
    } else {
      this.headlamp = new THREE.PointLight(
        HEADLAMP_COLOR,
        HEADLAMP_INTENSITY,
        HEADLAMP_RANGE + HEADLAMP_BACKSET,
        HEADLAMP_DECAY,
      );
      this.headlamp.name = "headlamp";
      this.scene.add(this.headlamp);
    }

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
   * `onArrive` does not fire — it never arrived) and CONTINUES its motion: the
   * new flight starts from the camera's current pose AND its current linear
   * and angular velocity, on a cubic Hermite curve that decays that velocity
   * into the usual come-to-rest arrival. Without this a retarget mid-flight
   * would stop dead and ease out again from zero — no snap in position, but a
   * visible hitch in every retarget, and the minimap's hover-pan retargets on
   * every new place the cursor rests. A flight that starts from rest is
   * unchanged (ease-in-out cubic, zero tangents).
   *
   * Only the magnitude of the angular rate is carried, along the new yaw/pitch
   * sweep; the position tangent is carried as a full vector, clipped to
   * `MAX_CARRIED_TANGENT` × the span so it can never overshoot.
   */
  teleportTo(destination: THREE.Vector3, options: TeleportOptions = {}): void {
    const fromPosition = this.camera.position.clone();
    const toPosition = destination.clone();
    this.flightEuler.setFromQuaternion(this.camera.quaternion, "YXZ");
    const fromYaw = this.flightEuler.y;
    const fromPitch = this.flightEuler.x;
    let deltaYaw = 0;
    let deltaPitch = 0;
    if (options.lookAt) {
      // Matrix4.lookAt with a world up gives a roll-free orientation — the
      // same one `Object3D.lookAt` (and therefore `FlightControls.lookAt`)
      // produces at the destination — so its yaw/pitch are exactly where the
      // arrival re-sync puts them, with no snap on the last frame.
      this.teleportScratch.lookAt(toPosition, options.lookAt, this.worldUp);
      this.flightEuler.setFromRotationMatrix(this.teleportScratch, "YXZ");
      deltaYaw = wrapAngle(this.flightEuler.y - fromYaw);
      deltaPitch = this.flightEuler.x - fromPitch;
    }

    const distance = fromPosition.distanceTo(toPosition);
    const durationMs =
      options.durationMs ??
      Math.min(TELEPORT_MAX_MS, Math.max(TELEPORT_MIN_MS, distance * TELEPORT_MS_PER_WORLD_UNIT));

    const carried = this.teleport !== null;
    const positionTangent = new THREE.Vector3();
    let rotationTangent = 0;
    if (carried) {
      const durationS = durationMs / 1000;
      positionTangent.copy(this.flightVelocity).multiplyScalar(durationS);
      const maxTangent = MAX_CARRIED_TANGENT * distance;
      if (positionTangent.length() > maxTangent) positionTangent.setLength(maxTangent);
      const sweep = Math.hypot(deltaYaw, deltaPitch);
      // A turn too small to measure has nothing to carry a rate into.
      if (sweep > 1e-4) {
        rotationTangent = Math.min(MAX_CARRIED_TANGENT, (this.flightAngularRate * durationS) / sweep);
      }
    }

    this.teleport = {
      fromPosition,
      toPosition,
      fromYaw,
      fromPitch,
      deltaYaw,
      deltaPitch,
      elapsedMs: 0,
      durationMs,
      blend: carried ? hermite01 : easeInOutCubic,
      positionTangent,
      rotationTangent,
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
   * not fire. Whoever owns yaw/pitch (`FlightControls`) has to re-adopt the
   * camera's mid-flight orientation afterwards, for the same reason `onArrive`
   * re-syncs it on a completed flight. */
  cancelTeleport(): void {
    this.endFlight();
  }

  private endFlight(): void {
    this.teleport = null;
    this.flightVelocity.set(0, 0, 0);
    this.flightAngularRate = 0;
  }

  private stepTeleport(dt: number): void {
    const state = this.teleport;
    if (!state) return;
    this.stepFromPosition.copy(this.camera.position);
    this.flightEuler.setFromQuaternion(this.camera.quaternion, "YXZ");
    const stepFromYaw = this.flightEuler.y;
    const stepFromPitch = this.flightEuler.x;

    state.elapsedMs += dt * 1000;
    const raw = Math.min(1, state.elapsedMs / state.durationMs);
    const t = state.blend(raw);
    const carry = hermite10(raw);
    this.camera.position
      .lerpVectors(state.fromPosition, state.toPosition, t)
      .addScaledVector(state.positionTangent, carry);
    const turn = t + state.rotationTangent * carry;
    this.flightEuler.set(state.fromPitch + state.deltaPitch * turn, state.fromYaw + state.deltaYaw * turn, 0, "YXZ");
    this.camera.quaternion.setFromEuler(this.flightEuler);

    if (raw >= 1) {
      this.endFlight();
      state.onArrive?.();
      return;
    }
    if (dt > 0) {
      this.flightVelocity.subVectors(this.camera.position, this.stepFromPosition).divideScalar(dt);
      this.flightAngularRate =
        Math.hypot(wrapAngle(this.flightEuler.y - stepFromYaw), this.flightEuler.x - stepFromPitch) / dt;
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
    this.followCamera();
    this.renderer.render(this.scene, this.camera);
  };

  /**
   * Parks the headlamp `HEADLAMP_BACKSET` units behind the camera, along its
   * own backward axis, for the pose this frame renders from. Runs after
   * `onUpdate` (flight input has been applied) and after `stepTeleport`, so it
   * never trails the camera by a frame; the renderer's own
   * `scene.updateMatrixWorld()` then picks the new position up.
   */
  private followCamera(): void {
    if (!this.headlamp) return;
    this.headlampBackward.set(0, 0, 1).applyQuaternion(this.camera.quaternion);
    this.headlamp.position.copy(this.camera.position).addScaledVector(this.headlampBackward, HEADLAMP_BACKSET);
  }

  dispose(): void {
    this.stop();
    this.sky?.dispose();
    this.headlamp?.removeFromParent();
    this.starfield.dispose();
    this.timer.dispose();
    window.removeEventListener("resize", this.handleResize);
    this.renderer.dispose();
    this.container.removeChild(this.renderer.domElement);
  }
}
