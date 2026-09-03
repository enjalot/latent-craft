import * as THREE from "three";
import type { FlightControls } from "../engine/FlightControls.ts";
import { LOOK_DRAG_THRESHOLD_PX } from "../config.ts";

/** The voxel a pointerdown landed on, opaque beyond chunk/voxel identity —
 * `PointerController` never needs to know whether it's minable or
 * restorable, only whether the hover target it's tracking is still the same
 * one. */
export interface VoxelTarget {
  chunkId: number;
  localVoxelId: number;
}

export interface PointerControllerCallbacks {
  /** Synchronous hit-test at the given NDC, called ONLY at pointerdown, to
   * resolve Phase 3.5's central ambiguity: is a voxel hovered right now (→
   * arm a candidate mine/restore hold) or not (→ start dragging
   * immediately, unambiguously)? */
  hitTestVoxel: (ndc: THREE.Vector2) => VoxelTarget | null;
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
 * either "drag to look around" or "holding down on a voxel to mine/restore
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

  constructor(
    private readonly domElement: HTMLElement,
    private readonly flightControls: FlightControls,
    private readonly callbacks: PointerControllerCallbacks,
  ) {
    domElement.addEventListener("pointerdown", this.handlePointerDown);
    domElement.addEventListener("pointermove", this.handlePointerMove);
    domElement.addEventListener("pointerup", this.handlePointerUp);
    domElement.addEventListener("pointercancel", this.handlePointerUp);
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

  /** Called by the frame loop when an armed hold's timer completes and the
   * mine/restore action has been performed. Clears the target WITHOUT
   * firing `onHoldCancel` — this was a successful completion, not a
   * cancellation — so a completed mine can't immediately auto-chain into an
   * accidental restore just because the button is still physically down; a
   * fresh mousedown is required to arm the next hold. */
  consumeHold(): void {
    this._holdTarget = null;
  }

  private updateNdc(clientX: number, clientY: number): void {
    const rect = this.domElement.getBoundingClientRect();
    this.ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.ndc.y = -(((clientY - rect.top) / rect.height) * 2 - 1);
  }

  private handlePointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return; // left button only
    event.preventDefault();
    this.updateNdc(event.clientX, event.clientY);
    this.domElement.setPointerCapture(event.pointerId);

    this.pointerDown = true;
    this.downX = event.clientX;
    this.downY = event.clientY;

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
    this.updateNdc(event.clientX, event.clientY);
    if (!this.pointerDown) return;

    if (!this.dragging && this._holdTarget) {
      const dx = event.clientX - this.downX;
      const dy = event.clientY - this.downY;
      if (Math.hypot(dx, dy) > LOOK_DRAG_THRESHOLD_PX) {
        // Promote to a look-drag; the armed hold never completes.
        this.dragging = true;
        this._holdTarget = null;
        this.callbacks.onHoldCancel();
      }
    }

    if (this.dragging) {
      this.flightControls.applyLookDelta(event.movementX, event.movementY);
    }
  };

  private handlePointerUp = (event: PointerEvent): void => {
    if (this.domElement.hasPointerCapture(event.pointerId)) {
      this.domElement.releasePointerCapture(event.pointerId);
    }
    this.pointerDown = false;
    this.dragging = false;
    this.cancelHold();
  };

  dispose(): void {
    this.domElement.removeEventListener("pointerdown", this.handlePointerDown);
    this.domElement.removeEventListener("pointermove", this.handlePointerMove);
    this.domElement.removeEventListener("pointerup", this.handlePointerUp);
    this.domElement.removeEventListener("pointercancel", this.handlePointerUp);
  }
}
