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

/** Every key `update()` turns into motion. `keys` records EVERY keydown (the
 * hotbar digits, effector brackets, …), so "is the player flying" has to be
 * asked against this list rather than against `keys` being non-empty. */
const MOVEMENT_KEY_CODES = [
  "KeyW",
  "KeyA",
  "KeyS",
  "KeyD",
  "Space",
  "ShiftLeft",
  "ShiftRight",
  "KeyE",
  "KeyQ",
] as const;

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
  private readonly camera: THREE.Camera;
  private readonly keys = new Set<string>();

  private yaw = 0;
  private pitch = 0;

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

  constructor(camera: THREE.Camera) {
    this.camera = camera;
    // Adopt whatever orientation the camera already has (Phase 1's synthetic
    // field spawns with the default identity quaternion, i.e. looking down
    // -Z) as the initial yaw/pitch, so the very first drag doesn't snap the
    // view to some unrelated zeroed baseline.
    this.syncFromCamera();

    window.addEventListener("keydown", (event) => {
      // Space's default action scrolls the page, and activates the focused
      // control if there is one (a <button> treats Space as a click). Neither
      // is wanted now that Space means "ascend" and gets held down for
      // seconds at a time. Today's HUD controls are all click-handling
      // <div>s, so nothing takes focus and only the scroll case can bite —
      // but that's an implementation detail of panels this file doesn't own,
      // so suppress both. Guarded on the event target so a future text field
      // in the HUD would still receive spaces normally.
      if (event.code === "Space" && !isTextEntryTarget(event.target)) event.preventDefault();
      this.keys.add(event.code);
      // Holding a key fires repeated keydowns with `repeat === true`; only a
      // genuine fresh press can be half of a double-tap.
      if (event.code === "KeyW" && !event.repeat) {
        const now = performance.now();
        if (now - this.lastForwardPressMs <= FLIGHT_SPRINT_DOUBLE_TAP_MS) this.sprinting = true;
        this.lastForwardPressMs = now;
      }
    });
    window.addEventListener("keyup", (event) => {
      this.keys.delete(event.code);
      if (event.code === "KeyW") this.sprinting = false;
    });
    // Don't let movement keys get "stuck" held down if the tab loses focus
    // (alt-tab etc.) without a matching keyup.
    window.addEventListener("blur", () => {
      this.keys.clear();
      this.sprinting = false;
    });
  }

  /** True while a double-tap-W sprint is held — for the HUD readout. */
  get isSprinting(): boolean {
    return this.sprinting;
  }

  /** True while any movement key is held — i.e. the next `update()` will
   * accelerate the camera. What the minimap's hover-pan polls to yield to the
   * player (see `main.ts`); a look-drag is reported separately by
   * `PointerController`, since it never passes through the key set. */
  get isMovementInputHeld(): boolean {
    for (const code of MOVEMENT_KEY_CODES) if (this.keys.has(code)) return true;
    return false;
  }

  /** Re-derives yaw/pitch from the camera's current quaternion. */
  private syncFromCamera(): void {
    this.scratchEuler.setFromQuaternion(this.camera.quaternion, "YXZ");
    this.pitch = this.scratchEuler.x;
    this.yaw = this.scratchEuler.y;
  }

  /**
   * Takes over from wherever `camera.quaternion` currently points — the
   * counterpart of `lookAt()` for a flight that was cancelled rather than
   * completed (`Engine.cancelTeleport`). Yaw/pitch are re-derived from the
   * quaternion and written straight back through the pitch clamp, so the next
   * drag composes from the pose the player is actually looking at, in range,
   * instead of from the stale pre-flight one and snapping.
   */
  adoptCameraOrientation(): void {
    this.syncFromCamera();
    this.applyLookDelta(0, 0);
  }

  /**
   * Points the camera at `target` and keeps yaw/pitch in sync with the
   * result — the only sanctioned way for external code (currently just
   * `main.ts`'s spawn framing) to re-aim the camera outright. A raw
   * `camera.lookAt()` would silently desync yaw/pitch from the quaternion it
   * just set, so the next `applyLookDelta()` would compose from stale state
   * and snap the view back.
   */
  lookAt(target: THREE.Vector3): void {
    this.camera.lookAt(target);
    this.syncFromCamera();
  }

  /**
   * Applies one pointermove's worth of screen-pixel delta to yaw/pitch and
   * writes the result to `camera.quaternion`. Called by `PointerController`
   * only while an active look-drag is in progress — never on every
   * pointermove, and never while a mine/restore hold is armed.
   */
  applyLookDelta(dxPixels: number, dyPixels: number): void {
    this.yaw -= dxPixels * LOOK_SENSITIVITY_RAD_PER_PX;
    this.pitch -= dyPixels * LOOK_SENSITIVITY_RAD_PER_PX;
    this.pitch = Math.max(-LOOK_PITCH_LIMIT_RAD, Math.min(LOOK_PITCH_LIMIT_RAD, this.pitch));
    this.scratchEuler.set(this.pitch, this.yaw, 0, "YXZ");
    this.camera.quaternion.setFromEuler(this.scratchEuler);
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
    const speedScale = this.sprinting ? FLIGHT_SPRINT_MULTIPLIER : 1;
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
    // Nothing owned here needs explicit teardown anymore — there is no
    // PointerLockControls instance to dispose. The window-level key
    // listeners live for the page's lifetime, same as Phase 1-3.
  }
}
