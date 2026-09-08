import * as THREE from "three";
import type { FlightControls } from "../engine/FlightControls.ts";
import { LOOK_DRAG_THRESHOLD_PX } from "../config.ts";

/** The voxel a pointerdown landed on, opaque beyond chunk/voxel identity —
 * `PointerController` never needs to know what a hold on it will do, only
 * whether the hover target it's tracking is still the same one. */
export interface VoxelTarget {
  chunkId: number;
  localVoxelId: number;
}

export interface PointerControllerCallbacks {
  /** Synchronous hit-test at the given NDC, called ONLY at pointerdown, to
   * resolve Phase 3.5's central ambiguity: is a voxel hovered right now (→
   * arm a candidate extraction hold) or not (→ start dragging immediately,
   * unambiguously)? */
  hitTestVoxel: (ndc: THREE.Vector2) => VoxelTarget | null;
  /**
   * Fired synchronously on every left-button pointerdown on the canvas,
   * BEFORE the hold-vs-drag decision and before `hitTestVoxel` runs. This is
   * "the player took hold of the 3D view", whichever of the two gestures it
   * turns into — the hook the minimap's hover-look uses to stand down (see
   * `MinimapBridge.cancelHoverLook`). Ordering matters: stopping a camera
   * turn here freezes the pose the hit test is about to raycast from, so a
   * hold armed on a voxel is armed on the voxel that stays under the cursor.
   */
  onPointerEngage: () => void;
  /** Fired synchronously the instant a hold candidate is armed. */
  onHoldStart: (target: VoxelTarget) => void;
  /** Fired when an armed hold is abandoned without completing — released
   * early, or promoted into a look-drag after crossing the drag threshold.
   * NOT fired for a hold that completes successfully (see `consumeHold`). */
  onHoldCancel: () => void;
}

/**
 * Owns the canvas's raw pointer stream and resolves the ambiguity a free
 * (never-captured) cursor introduces: a mousedown-then-move could mean
 * either "drag to look around" or "holding down on a voxel to extract from
 * it." Per the plan's resolution: if a voxel is hovered at mousedown, treat
 * it as a hold candidate and wait — only promote to a look-drag if the
 * pointer moves past `LOOK_DRAG_THRESHOLD_PX` before release, which cancels
 * the hold at that instant. If nothing is hovered at mousedown, there is no
 * ambiguity: start dragging immediately, from the first pixel.
 *
 * Deliberately knows nothing about voxels/chunks/mining beyond the opaque
 * `VoxelTarget` `hitTestVoxel` hands back, and nothing about hold *progress*
 * or *completion* — those are duration-based (need a per-frame `dt`), which
 * this purely event-driven class doesn't have. The caller's own render-loop
 * tick reads `holdTarget` each frame to drive the timer, and must also call
 * `cancelHold()` if the hover target changes out from under an armed hold
 * even without pointer movement (e.g. flying toward/away from it with WASD
 * while holding still) — see `main.ts`.
 */
export class PointerController {
  /** Current mouse position in NDC (-1..1), updated on every pointermove
   * regardless of button state. Hover/raycast reads this every frame instead
   * of a fixed screen center. */
  readonly ndc = new THREE.Vector2(0, 0);

  private _holdTarget: VoxelTarget | null = null;
  private dragging = false;
  private pointerDown = false;
  private downX = 0;
  private downY = 0;
  private activePointer: number | null = null;
  private lastX = 0;
  private lastY = 0;
  private readonly view: Window | null;

  constructor(
    private readonly domElement: HTMLElement,
    private readonly flightControls: FlightControls,
    private readonly callbacks: PointerControllerCallbacks,
  ) {
    this.view = domElement.ownerDocument?.defaultView ?? null;
    this.view?.addEventListener("blur", this.cancelPointer);
    domElement.tabIndex = -1;
    domElement.addEventListener("pointerdown", this.handlePointerDown);
    domElement.addEventListener("pointermove", this.handlePointerMove);
    domElement.addEventListener("pointerup", this.handlePointerUp);
    domElement.addEventListener("pointercancel", this.handlePointerUp);
    domElement.addEventListener("lostpointercapture", this.handlePointerUp);
  }

  /** The voxel a hold is currently armed against, or `null`. Read-only from
   * the outside — mutate only via `cancelHold()`/`consumeHold()`. */
  get holdTarget(): VoxelTarget | null {
    return this._holdTarget;
  }

  /** Whether a look-drag is currently in progress (for HUD/cursor-style
   * feedback only — nothing gates on this the way `FlightControls.isLocked`
   * used to). */
  get isDragging(): boolean {
    return this.dragging;
  }

  /** Explicit cancel hook for the caller: the hover target changed
   * underneath an armed hold (e.g. WASD flight moved the world under a
   * perfectly still cursor) even though the pointer itself never moved
   * enough to register as a drag. No-ops (and does not re-fire
   * `onHoldCancel`) if no hold is currently armed. */
  cancelHold(): void {
    if (this._holdTarget) {
      this._holdTarget = null;
      this.callbacks.onHoldCancel();
    }
  }

  /** Called by the frame loop when an armed hold has run its course (the
   * voxel emptied, or extraction couldn't run). Clears the target WITHOUT
   * firing `onHoldCancel` — this was a completion, not a cancellation — and
   * a fresh mousedown is required to arm the next hold: the button still
   * being physically down must not start a hold on whatever the cursor now
   * sees through the emptied voxel. */
  consumeHold(): void {
    this._holdTarget = null;
  }

  private updateNdc(clientX: number, clientY: number): void {
    const rect = this.domElement.getBoundingClientRect();
    this.ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.ndc.y = -(((clientY - rect.top) / rect.height) * 2 - 1);
  }

  private handlePointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || this.activePointer !== null) return;
    this.activePointer = event.pointerId;
    event.preventDefault();
    // preventDefault suppresses the browser's native focus transfer. Explicitly
    // release sliders/selects so subsequent movement/hotbar keys target the world.
    this.domElement.focus({ preventScroll: true });
    this.updateNdc(event.clientX, event.clientY);
    this.domElement.setPointerCapture(event.pointerId);

    this.pointerDown = true;
    this.downX = event.clientX;
    this.downY = event.clientY;
    this.lastX = event.clientX; this.lastY = event.clientY;

    this.callbacks.onPointerEngage();
    const target = this.callbacks.hitTestVoxel(this.ndc);
    if (target) {
      // A voxel is hovered: arm a candidate hold, do NOT start dragging yet.
      this.dragging = false;
      this._holdTarget = target;
      this.callbacks.onHoldStart(target);
    } else {
      // Nothing hovered: unambiguous look-drag from the first pixel.
      this.dragging = true;
      this._holdTarget = null;
    }
  };

  private handlePointerMove = (event: PointerEvent): void => {
    if (this.activePointer !== null && event.pointerId !== this.activePointer) return;
    this.updateNdc(event.clientX, event.clientY);
    if (!this.pointerDown) return;
    const dxLook = event.clientX - this.lastX, dyLook = event.clientY - this.lastY;
    this.lastX = event.clientX; this.lastY = event.clientY;

    if (!this.dragging) {
      const dx = event.clientX - this.downX;
      const dy = event.clientY - this.downY;
      if (Math.hypot(dx, dy) > (event.pointerType === "touch" ? 12 : LOOK_DRAG_THRESHOLD_PX)) {
        // Promote to a look-drag; the armed hold never completes.
        this.dragging = true;
        // Flight can invalidate the held voxel before the look finger moves.
        // That must not strand the pointer in a non-dragging, targetless state.
        this.cancelHold();
      }
    }

    if (this.dragging) {
      // Touch movementX/Y is zero on some browsers; client deltas are reliable.
      this.flightControls.applyLookDelta(dxLook, dyLook);
    }
  };

  private handlePointerUp = (event: PointerEvent): void => {
    if (event.pointerId !== this.activePointer) return;
    this.cancelPointer();
  };

  private cancelPointer = (): void => {
    const id = this.activePointer;
    this.activePointer = null;
    if (id !== null && this.domElement.hasPointerCapture(id)) {
      this.domElement.releasePointerCapture(id);
    }
    this.pointerDown = false;
    this.dragging = false;
    this.cancelHold();
  };

  dispose(): void {
    this.cancelPointer();
    this.view?.removeEventListener("blur", this.cancelPointer);
    this.domElement.removeEventListener("pointerdown", this.handlePointerDown);
    this.domElement.removeEventListener("pointermove", this.handlePointerMove);
    this.domElement.removeEventListener("pointerup", this.handlePointerUp);
    this.domElement.removeEventListener("pointercancel", this.handlePointerUp);
    this.domElement.removeEventListener("lostpointercapture", this.handlePointerUp);
  }
}
