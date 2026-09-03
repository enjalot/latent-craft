import * as THREE from "three";
import { PointerLockControls } from "three/addons/controls/PointerLockControls.js";
import { FLIGHT_BOOST_MULTIPLIER, FLIGHT_SPEED, FLIGHT_VERTICAL_SPEED } from "../config.ts";

/**
 * Spectator-style 6-DOF flight: no gravity, no collision, nothing to stand
 * on (there's no ground in a sparse point cloud, so noclip-fly is the only
 * mode). Uses `THREE.PointerLockControls` only for mouse-look (it owns
 * `camera.quaternion` via its internal mousemove listener) — movement is
 * entirely our own, derived from the camera's current quaternion each
 * frame, rather than the addon's built-in `moveForward`/`moveRight` (which
 * are XZ-plane-only and unsuitable for free 3D flight).
 *
 * Key bindings: WASD = forward/back/strafe (full 3D, follows look pitch),
 * Q/E = down/up (world-space, not camera-relative — keeps vertical control
 * predictable regardless of where you're looking), Shift = speed boost.
 */
export class FlightControls {
  readonly pointerLock: PointerLockControls;

  private readonly camera: THREE.Camera;
  private readonly keys = new Set<string>();

  // scratch vectors, reused per frame to avoid per-frame allocation
  private readonly forward = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly moveVec = new THREE.Vector3();

  constructor(camera: THREE.Camera, domElement: HTMLElement) {
    this.camera = camera;
    this.pointerLock = new PointerLockControls(camera, domElement);

    domElement.addEventListener("click", () => {
      if (!this.pointerLock.isLocked) this.pointerLock.lock();
    });

    window.addEventListener("keydown", (event) => this.keys.add(event.code));
    window.addEventListener("keyup", (event) => this.keys.delete(event.code));
    // Don't let movement keys get "stuck" held down if the tab loses focus
    // (alt-tab, pointer-unlock via Esc, etc.) without a matching keyup.
    window.addEventListener("blur", () => this.keys.clear());
    this.pointerLock.addEventListener("unlock", () => this.keys.clear());
  }

  get isLocked(): boolean {
    return this.pointerLock.isLocked;
  }

  /** Advances the camera position by one frame's worth of flight. */
  update(deltaSeconds: number): void {
    if (!this.pointerLock.isLocked) return;

    const boosted = this.keys.has("ShiftLeft") || this.keys.has("ShiftRight");
    const speed = (boosted ? FLIGHT_SPEED * FLIGHT_BOOST_MULTIPLIER : FLIGHT_SPEED) * deltaSeconds;
    const verticalSpeed = (boosted ? FLIGHT_VERTICAL_SPEED * FLIGHT_BOOST_MULTIPLIER : FLIGHT_VERTICAL_SPEED) * deltaSeconds;

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
    // Q/E are world-space vertical, independent of camera pitch/roll.
    if (this.keys.has("KeyE")) this.moveVec.addScaledVector(this.up, verticalSpeed);
    if (this.keys.has("KeyQ")) this.moveVec.addScaledVector(this.up, -verticalSpeed);

    this.camera.position.add(this.moveVec);
  }

  dispose(): void {
    this.pointerLock.dispose();
  }
}
