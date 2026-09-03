import * as THREE from "three";
import {
  FLIGHT_SPEED,
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
 * bound to up/down as a legacy alternate.
 *
 * Vertical moved from Q/E to Space/Shift per user feedback after flying the
 * real dataset: that's the binding anyone arriving from Minecraft creative
 * already has in their hands. Two deliberate decisions came with it:
 *
 *  1. Shift was previously a speed-boost modifier, which now collides. Rather
 *     than rebinding boost to another key (Ctrl, as some Minecraft versions
 *     use for sprint) the boost is GONE, folded into a higher baseline
 *     `FLIGHT_SPEED` — the same feedback round also asked for flight to be
 *     generally faster, so one faster speed satisfies both asks and leaves the
 *     control scheme with one fewer modifier to remember. See `config.ts`.
 *  2. Q/E are KEPT as an alternate vertical binding rather than dropped. They
 *     cost nothing (no other feature wants those keys), they keep every
 *     screenshot/note from Phases 1-5 accurate, and a left hand already parked
 *     on WASD can reach E/Q without the thumb+pinky stretch.
 */
export class FlightControls {
  private readonly camera: THREE.Camera;
  private readonly keys = new Set<string>();

  private yaw = 0;
  private pitch = 0;

  // scratch objects, reused per call to avoid allocation
  private readonly forward = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly moveVec = new THREE.Vector3();
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
    });
    window.addEventListener("keyup", (event) => this.keys.delete(event.code));
    // Don't let movement keys get "stuck" held down if the tab loses focus
    // (alt-tab etc.) without a matching keyup.
    window.addEventListener("blur", () => this.keys.clear());
  }

  /** Re-derives yaw/pitch from the camera's current quaternion. */
  private syncFromCamera(): void {
    this.scratchEuler.setFromQuaternion(this.camera.quaternion, "YXZ");
    this.pitch = this.scratchEuler.x;
    this.yaw = this.scratchEuler.y;
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
   */
  update(deltaSeconds: number): void {
    const speed = FLIGHT_SPEED * deltaSeconds;
    const verticalSpeed = FLIGHT_VERTICAL_SPEED * deltaSeconds;

    // Full 3D look direction (includes pitch) so W/S fly exactly where
    // you're looking, like Minecraft spectator / a space-sim, not an
    // FPS-style XZ-locked walk.
    this.forward.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
    // Rotating (1,0,0) by a yaw+pitch(+0 roll) quaternion stays level
    // (pitch rotates about the local X axis, which leaves it fixed), so
    // this is already a horizontal strafe direction with no extra
    // projection needed.
    this.right.set(1, 0, 0).applyQuaternion(this.camera.quaternion);

    this.moveVec.set(0, 0, 0);
    if (this.keys.has("KeyW")) this.moveVec.addScaledVector(this.forward, speed);
    if (this.keys.has("KeyS")) this.moveVec.addScaledVector(this.forward, -speed);
    if (this.keys.has("KeyD")) this.moveVec.addScaledVector(this.right, speed);
    if (this.keys.has("KeyA")) this.moveVec.addScaledVector(this.right, -speed);
    // Vertical is world-space, independent of camera pitch/roll. Space/Shift
    // is the primary (Minecraft creative) binding; E/Q the legacy alternate.
    if (this.keys.has("Space") || this.keys.has("KeyE")) {
      this.moveVec.addScaledVector(this.up, verticalSpeed);
    }
    if (this.keys.has("ShiftLeft") || this.keys.has("ShiftRight") || this.keys.has("KeyQ")) {
      this.moveVec.addScaledVector(this.up, -verticalSpeed);
    }

    this.camera.position.add(this.moveVec);
  }

  dispose(): void {
    // Nothing owned here needs explicit teardown anymore — there is no
    // PointerLockControls instance to dispose. The window-level key
    // listeners live for the page's lifetime, same as Phase 1-3.
  }
}
