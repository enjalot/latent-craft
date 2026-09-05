import * as THREE from "three";
import {
  FLIGHT_ACCEL_TAU_S,
  FLIGHT_SPEED,
  FLIGHT_SPRINT_DOUBLE_TAP_MS,
  FLIGHT_SPRINT_MULTIPLIER,
  FLIGHT_VERTICAL_SPEED,
  LOOK_PITCH_LIMIT_RAD,
  LOOK_SENSITIVITY_RAD_PER_PX,
} from "../config.ts";

/** True if a keystroke is headed for something that legitimately wants raw
 * text (nothing in the app does today — this only exists so the Space
 * preventDefault below can never eat a keystroke a future HUD input needs). */
function isTextEntryTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element || typeof element.tagName !== "string") return false;
  const tag = element.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || element.isContentEditable === true;
}

/**
 * A scripted look turn in progress (`lookTransitionTo`): yaw/pitch sweep from
 * a snapshot toward a target over a fixed duration. Kept as yaw/pitch deltas
 * rather than quaternions to slerp, for the same reason `Engine`'s teleport
 * does: a slerp between two roll-free poses rolls the cockpit in between,
 * whereas sweeping the two angles the camera is actually parameterized by
 * keeps roll at exactly zero throughout and lands on the yaw/pitch a
 * `lookAt` at the target would derive.
 */
interface LookTransition {
  fromYaw: number;
  fromPitch: number;
  /** Wrapped into (-π, π] — the short way round. */
  deltaYaw: number;
  deltaPitch: number;
  elapsedS: number;
  durationS: number;
  /** Fired once, on the frame the turn completes; not on cancel. */
  onArrive?: () => void;
}

/**
 * Smallest yaw/pitch sweep (radians, hypot of the two) `lookTransitionTo`
 * will animate — ~0.25°. Below this the camera is already looking there for
 * every practical purpose, and animating it would only occupy the turn slot
 * for a full duration (blocking the next queued hover-look, see
 * `MinimapBridge`) to move the view by less than a pixel. A perception bound,
 * not a feel knob — hence here rather than in config.
 */
const LOOK_TRANSITION_MIN_SWEEP_RAD = 0.0044;

/** Same easing `Engine.teleportTo` uses for a flight from rest — a turn
 * that starts and stops smoothly reads as the camera turning, not cutting. */
function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/** Wraps an angle difference into (-π, π] so a yaw sweep takes the short way
 * round rather than spinning the long way through the back. */
function wrapAngle(delta: number): number {
  return delta - Math.round(delta / (2 * Math.PI)) * 2 * Math.PI;
}

/**
 * Spectator-style 6-DOF flight: no gravity, no collision, nothing to stand
 * on (there's no ground in a sparse point cloud, so noclip-fly is the only
 * mode). Movement is entirely our own, derived from the camera's current
 * quaternion each frame rather than any addon's built-in `moveForward`/
 * `moveRight` (which are typically XZ-plane-only and unsuitable for free 3D
 * flight).
 *
 * Phase 3.5 rewrite: this used to own `THREE.PointerLockControls` for
 * mouse-look (full pointer capture, hidden cursor, raw relative deltas). Per
 * user feedback after Phase 3, that's gone — the mouse now stays free and
 * visible at all times, and look-rotation is driven externally via
 * `applyLookDelta()`, called by `interaction/PointerController.ts` only
 * while an actual click-and-drag gesture is in progress (as opposed to a
 * click-and-HOLD, which `PointerController` instead routes to mining). This
 * class deliberately has no opinion on when a drag is happening or isn't —
 * that ambiguity needs to inspect voxel hover state, which is not
 * `FlightControls`' business.
 *
 * `yaw`/`pitch` (radians) are the single source of truth for look direction;
 * `camera.quaternion` is a derived value written any time either changes.
 * Nothing outside this class should assign `camera.quaternion` directly —
 * use `lookAt()`, which re-derives yaw/pitch afterward so the next
 * `applyLookDelta()` composes from the right baseline instead of snapping.
 * (The one exception is `Engine.stepTeleport`, which sweeps the quaternion
 * itself for the duration of a click-teleport; the flight's `onArrive`
 * re-syncs through `lookAt`, and this class's `update` is not called while
 * one is in progress.)
 *
 * Besides the player's own drag, the look direction has one scripted driver:
 * `lookTransitionTo()`, a timed eased turn toward a world point with no
 * translation — what the minimap's hover-look uses (`MinimapBridge`). It is
 * advanced from `update()` like flight is, so the two compose: a turn keeps
 * turning while WASD flies, and the movement that frame is along the
 * direction the turn has reached. A drag cancels it (the player's hand wins);
 * nothing else does implicitly — the caller that started it stops it with
 * `cancelLookTransition()` when its own reasons say so.
 *
 * Key bindings: WASD = forward/back/strafe (full 3D, follows look pitch),
 * Space = ascend, Shift = descend (world-space, not camera-relative — keeps
 * vertical control predictable regardless of where you're looking). E/Q stay
 * bound to up/down as a legacy alternate. Double-tap W and hold = sprint
 * (`FLIGHT_SPRINT_MULTIPLIER` x speed on every axis until W is released).
 *
 * Vertical moved from Q/E to Space/Shift per user feedback after flying the
 * real dataset: that's the binding anyone arriving from Minecraft creative
 * already has in their hands. Two deliberate decisions came with it:
 *
 *  1. Shift was previously a speed-boost modifier, which now collides. Rather
 *     than rebinding boost to another key (Ctrl, as some Minecraft versions
 *     use for sprint) the boost went away, folded into a higher baseline
 *     `FLIGHT_SPEED`. A later round then halved that baseline ("still too
 *     fast") and brought speed-up back as Minecraft's OWN gesture — the W
 *     double-tap — which needs no modifier key at all, so the scheme stays as
 *     lean as it was. See `config.ts`.
 *  2. Q/E are KEPT as an alternate vertical binding rather than dropped. They
 *     cost nothing (no other feature wants those keys), they keep every
 *     screenshot/note from Phases 1-5 accurate, and a left hand already parked
 *     on WASD can reach E/Q without the thumb+pinky stretch.
 *
 * Sprint detection lives in the key handlers, not `update()`: a second
 * non-auto-repeat W keydown within `FLIGHT_SPRINT_DOUBLE_TAP_MS` of the
 * previous one arms it, W's keyup (or a window blur) disarms it. Only the
 * TARGET velocity is scaled, so the same easing that rounds off press/release
 * also rounds off the sprint transition.
 */
export class FlightControls {
  private speedMultiplier = 1;

  setSpeed(worldUnitsPerSecond: number): void {
    if (Number.isFinite(worldUnitsPerSecond) && worldUnitsPerSecond > 0) {
      this.speedMultiplier = worldUnitsPerSecond / FLIGHT_SPEED;
      this.velocity.set(0, 0, 0);
    }
  }
  private readonly camera: THREE.Camera;
  private readonly keys = new Set<string>();

  private yaw = 0;
  private pitch = 0;
  private lookTransition: LookTransition | null = null;

  private sprinting = false;
  /** `performance.now()` of the last non-auto-repeat W keydown — the first
   * half of a double-tap. */
  private lastForwardPressMs = Number.NEGATIVE_INFINITY;

  // Actual velocity eases toward the held-keys' target velocity each frame
  // rather than snapping to it — see the class comment on FLIGHT_ACCEL_TAU_S.
  // Persists across frames (unlike the scratch vectors below), so it's not
  // reset at the top of update().
  private readonly velocity = new THREE.Vector3();

  // scratch objects, reused per call to avoid allocation
  private readonly forward = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly targetVelocity = new THREE.Vector3();
  private readonly scratchEuler = new THREE.Euler(0, 0, 0, "YXZ");
  private readonly scratchMatrix = new THREE.Matrix4();

  private readonly handleKeydown = (event: KeyboardEvent): void => {
    // A focused HUD control gets first refusal. Its keyboard activation must
    // not also become a frame of flight (notably Space on a collapse header).
    if (event.defaultPrevented || isTextEntryTarget(event.target)) return;
    // Space's default action scrolls the page or activates the focused
    // control. Neither is wanted while it is acting as the ascend key.
    if (event.code === "Space") event.preventDefault();
    this.keys.add(event.code);
    // Holding a key fires repeated keydowns; only a genuine fresh press can
    // be half of a double-tap.
    if (event.code === "KeyW" && !event.repeat) {
      const now = performance.now();
      if (now - this.lastForwardPressMs <= FLIGHT_SPRINT_DOUBLE_TAP_MS) this.sprinting = true;
      this.lastForwardPressMs = now;
    }
  };

  private readonly handleKeyup = (event: KeyboardEvent): void => {
    this.keys.delete(event.code);
    if (event.code === "KeyW") this.sprinting = false;
  };

  private readonly handleBlur = (): void => {
    this.keys.clear();
    this.sprinting = false;
  };

  constructor(camera: THREE.Camera) {
    this.camera = camera;
    // Adopt whatever orientation the camera already has (Phase 1's synthetic
    // field spawns with the default identity quaternion, i.e. looking down
    // -Z) as the initial yaw/pitch, so the very first drag doesn't snap the
    // view to some unrelated zeroed baseline.
    this.syncFromCamera();

    window.addEventListener("keydown", this.handleKeydown);
    window.addEventListener("keyup", this.handleKeyup);
    // Don't let movement keys get "stuck" held down if the tab loses focus
    // (alt-tab etc.) without a matching keyup.
    window.addEventListener("blur", this.handleBlur);
  }

  /** True while a double-tap-W sprint is held — for the HUD readout. */
  get isSprinting(): boolean {
    return this.sprinting;
  }

  /** True while a `lookTransitionTo` turn is in progress. */
  get isLookTransitioning(): boolean {
    return this.lookTransition !== null;
  }

  /** Re-derives yaw/pitch from the camera's current quaternion. */
  private syncFromCamera(): void {
    this.scratchEuler.setFromQuaternion(this.camera.quaternion, "YXZ");
    this.pitch = this.scratchEuler.x;
    this.yaw = this.scratchEuler.y;
  }

  /** Writes the current yaw/pitch (pitch clamped in place) to the camera. */
  private writeOrientation(): void {
    this.pitch = Math.max(-LOOK_PITCH_LIMIT_RAD, Math.min(LOOK_PITCH_LIMIT_RAD, this.pitch));
    this.scratchEuler.set(this.pitch, this.yaw, 0, "YXZ");
    this.camera.quaternion.setFromEuler(this.scratchEuler);
  }

  /**
   * Points the camera at `target` and keeps yaw/pitch in sync with the
   * result — the only sanctioned way for external code (`main.ts`'s spawn
   * framing, a teleport's arrival) to re-aim the camera outright. A raw
   * `camera.lookAt()` would silently desync yaw/pitch from the quaternion it
   * just set, so the next `applyLookDelta()` would compose from stale state
   * and snap the view back. A hard re-aim supersedes any turn in progress.
   */
  lookAt(target: THREE.Vector3): void {
    this.lookTransition = null;
    this.camera.lookAt(target);
    this.syncFromCamera();
  }

  /**
   * Applies one pointermove's worth of screen-pixel delta to yaw/pitch and
   * writes the result to `camera.quaternion`. Called by `PointerController`
   * only while an active look-drag is in progress — never on every
   * pointermove, and never while an extraction hold is armed. The player's
   * hand wins over a scripted turn: any `lookTransitionTo` in progress is
   * dropped where it is, so the drag composes from the pose on screen rather
   * than fighting the turn for the quaternion.
   */
  applyLookDelta(dxPixels: number, dyPixels: number): void {
    this.lookTransition = null;
    this.yaw -= dxPixels * LOOK_SENSITIVITY_RAD_PER_PX;
    this.pitch -= dyPixels * LOOK_SENSITIVITY_RAD_PER_PX;
    this.writeOrientation();
  }

  /**
   * Starts an eased turn (yaw/pitch only — the camera does not move) that
   * ends looking at `target` after `durationMs`, advanced by `update()`. The
   * end pose is the roll-free `lookAt` orientation from the camera's CURRENT
   * position and is not re-planned, so if the camera flies during the turn it
   * ends pointing where the target was relative to where the turn started.
   * At `FLIGHT_SPEED` that is ~1.7 units of travel over a 350 ms turn — a
   * miss of tens of degrees for a target a few voxels away, a fraction of a
   * degree for one across the map. Deliberate: the turn is a gesture toward
   * a spot, not a lock-on, and the caller that wants the camera on the spot
   * re-aims (`lookAt`) or turns again from the new position. Yaw goes the
   * short way round; pitch is clamped to the usual limit at the end pose, so
   * a target straight overhead turns as far up as a drag could.
   *
   * Replaces any turn already in progress (its `onArrive` never fires — it
   * never arrived). Returns `false`, starting nothing, when the camera is
   * already looking there to within `LOOK_TRANSITION_MIN_SWEEP_RAD`, so a
   * caller queuing turns can tell a no-op from a turn it has to wait for.
   */
  lookTransitionTo(target: THREE.Vector3, durationMs: number, onArrive?: () => void): boolean {
    // Matrix4.lookAt with a world up gives a roll-free orientation — the
    // same one `Object3D.lookAt` (and therefore `lookAt` above) produces, so
    // the turn lands exactly where a hard re-aim at the target would.
    this.scratchMatrix.lookAt(this.camera.position, target, this.up);
    this.scratchEuler.setFromRotationMatrix(this.scratchMatrix, "YXZ");
    const toPitch = Math.max(-LOOK_PITCH_LIMIT_RAD, Math.min(LOOK_PITCH_LIMIT_RAD, this.scratchEuler.x));
    const deltaYaw = wrapAngle(this.scratchEuler.y - this.yaw);
    const deltaPitch = toPitch - this.pitch;
    if (Math.hypot(deltaYaw, deltaPitch) < LOOK_TRANSITION_MIN_SWEEP_RAD) {
      this.lookTransition = null;
      return false;
    }
    this.lookTransition = {
      fromYaw: this.yaw,
      fromPitch: this.pitch,
      deltaYaw,
      deltaPitch,
      elapsedS: 0,
      durationS: Math.max(1e-3, durationMs) / 1000,
      onArrive,
    };
    return true;
  }

  /** Abandons a turn in progress where it currently points; its `onArrive`
   * does not fire. Yaw/pitch are already the pose on screen (the turn writes
   * them every frame), so nothing needs re-syncing. */
  cancelLookTransition(): void {
    this.lookTransition = null;
  }

  private stepLookTransition(deltaSeconds: number): void {
    const turn = this.lookTransition;
    if (!turn) return;
    turn.elapsedS += deltaSeconds;
    const raw = Math.min(1, turn.elapsedS / turn.durationS);
    const t = easeInOutCubic(raw);
    this.yaw = turn.fromYaw + turn.deltaYaw * t;
    this.pitch = turn.fromPitch + turn.deltaPitch * t;
    this.writeOrientation();
    if (raw >= 1) {
      this.lookTransition = null;
      turn.onArrive?.();
    }
  }

  /**
   * Advances the camera position by one frame's worth of flight. Runs
   * unconditionally — under the old `PointerLockControls` scheme this
   * gated on `isLocked`, but there's no "lock" concept anymore: WASD/Q/E
   * just always work, per the addendum ("WASD+Q/E flight movement is
   * unchanged").
   *
   * Eases toward the held-keys' target velocity rather than snapping to it
   * (real user feedback: an instant on/off at speed read as sudden/jerky).
   * `FLIGHT_ACCEL_TAU_S` is an exponential time constant, not a linear ramp —
   * framerate-independent, and it decays on release the same way it ramps up
   * on press, which also happens to suit this project's space-sim framing
   * (thruster inertia) better than an instant stop.
   */
  update(deltaSeconds: number): void {
    // A scripted turn advances first, so this frame's flight is along the
    // direction the camera has turned to, not the one it had last frame.
    this.stepLookTransition(deltaSeconds);

    // Full 3D look direction (includes pitch) so W/S fly exactly where
    // you're looking, like Minecraft spectator / a space-sim, not an
    // FPS-style XZ-locked walk.
    this.forward.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
    // Rotating (1,0,0) by a yaw+pitch(+0 roll) quaternion stays level
    // (pitch rotates about the local X axis, which leaves it fixed), so
    // this is already a horizontal strafe direction with no extra
    // projection needed.
    this.right.set(1, 0, 0).applyQuaternion(this.camera.quaternion);

    // Sprint scales every axis (see the class comment) — a strafe or climb
    // mid-sprint keeps pace with the forward motion.
    const speedScale = this.speedMultiplier * (this.sprinting ? FLIGHT_SPRINT_MULTIPLIER : 1);
    const speed = FLIGHT_SPEED * speedScale;
    const verticalSpeed = FLIGHT_VERTICAL_SPEED * speedScale;

    this.targetVelocity.set(0, 0, 0);
    if (this.keys.has("KeyW")) this.targetVelocity.addScaledVector(this.forward, speed);
    if (this.keys.has("KeyS")) this.targetVelocity.addScaledVector(this.forward, -speed);
    if (this.keys.has("KeyD")) this.targetVelocity.addScaledVector(this.right, speed);
    if (this.keys.has("KeyA")) this.targetVelocity.addScaledVector(this.right, -speed);
    // Vertical is world-space, independent of camera pitch/roll. Space/Shift
    // is the primary (Minecraft creative) binding; E/Q the legacy alternate.
    if (this.keys.has("Space") || this.keys.has("KeyE")) {
      this.targetVelocity.addScaledVector(this.up, verticalSpeed);
    }
    if (this.keys.has("ShiftLeft") || this.keys.has("ShiftRight") || this.keys.has("KeyQ")) {
      this.targetVelocity.addScaledVector(this.up, -verticalSpeed);
    }

    const blend = 1 - Math.exp(-deltaSeconds / FLIGHT_ACCEL_TAU_S);
    this.velocity.lerp(this.targetVelocity, blend);
    this.camera.position.addScaledVector(this.velocity, deltaSeconds);
  }

  dispose(): void {
    window.removeEventListener("keydown", this.handleKeydown);
    window.removeEventListener("keyup", this.handleKeyup);
    window.removeEventListener("blur", this.handleBlur);
    this.keys.clear();
    this.velocity.set(0, 0, 0);
    this.lookTransition = null;
    this.sprinting = false;
  }
}
