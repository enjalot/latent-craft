import * as THREE from "three";
import type { Engine } from "../engine/Engine.ts";
import type { FlightControls } from "../engine/FlightControls.ts";
import { MinimapRenderer } from "../minimap/MinimapRenderer.ts";
import type { MinimapPack } from "../minimap/Manifest.ts";
import type { Manifest } from "../streaming/Manifest.ts";
import type { ChunkStore } from "../streaming/ChunkStore.ts";
import type { RowToVoxel } from "../streaming/RowToVoxel.ts";
import { HighlightCubes } from "../voxels/HighlightCubes.ts";
import { EMPTY_REPR_ROW_ID } from "../types.ts";
import {
  MINIMAP_AVATAR_MOVE_EPSILON,
  MINIMAP_AVATAR_UPDATE_MS,
  MINIMAP_FLASHLIGHT_COLOR_3D,
  MINIMAP_FLASHLIGHT_CUBE_FILL,
  MINIMAP_FLASHLIGHT_CUBE_OPACITY,
  MINIMAP_FLASHLIGHT_MAX_ROWS,
  MINIMAP_FLASHLIGHT_MAX_VOXELS,
  MINIMAP_FLASHLIGHT_RADIUS_PX,
  MINIMAP_HOVER_PAN_DEBOUNCE_MS,
  MINIMAP_HOVER_PAN_MAX_MS,
  MINIMAP_HOVER_PAN_MIN_MS,
  MINIMAP_HOVER_PAN_MS_PER_WORLD_UNIT,
  TELEPORT_STANDOFF_CHUNKS,
  VOXEL_FILL,
} from "../config.ts";

/** A (chunk_id, local_voxel_id) pair packed into one number so it can be a
 * `Set` key. local_voxel_id is a u16 by construction (`row_to_voxel.bin`), so
 * 16 bits is exact, and chunk_id * 65536 stays well inside float64's integer
 * range for any plausible `chunks_per_axis`. */
function voxelKey(chunkId: number, localVoxelId: number): number {
  return chunkId * 65536 + localVoxelId;
}

export interface FlashlightResult {
  qx: number;
  qy: number;
  radiusQ: number;
  /** Points found inside the radius (capped at `MINIMAP_FLASHLIGHT_MAX_ROWS`). */
  rows: number;
  /** Distinct voxels those points live in (capped at `…MAX_VOXELS`). */
  voxels: number;
  /** How many of those voxels are in a currently-resident chunk. */
  residentVoxels: number;
  /** Wall time of the row scan + dedupe, ms — the thing worth watching if the
   * point count ever grows by an order of magnitude. */
  scanMs: number;
}

export interface VoxelHighlightResult {
  chunkId: number;
  localVoxelId: number;
  /** row_id used for the 2D marker, or -1 if none could be resolved. */
  rowId: number;
  /** Whether the voxel's chunk is streamed in right now. */
  chunkResident: boolean;
  /** Whether a 3D glow box was actually placed (always true for a voxel the
   * manifest knows about — see `highlightVoxel`'s doc comment). */
  lit3d: boolean;
  /** Whether a marker was drawn on the 2D minimap. */
  lit2d: boolean;
  world: { x: number; y: number; z: number };
}

export interface TeleportResult {
  qx: number;
  qy: number;
  rowId: number;
  chunkId: number;
  localVoxelId: number;
  /** Whether the destination chunk was already resident when the click landed
   * — i.e. whether the prefetch had anything to do. */
  chunkWasResident: boolean;
  /** Chunks the destination pulled into a fetching ring (see
   * `ChunkStore.prioritizeTeleport`). */
  pinnedChunks: number;
  targetWorld: { x: number; y: number; z: number };
  destinationWorld: { x: number; y: number; z: number };
}

export interface HoverPanResult extends TeleportResult {
  /** Flight time this pan was given (`MINIMAP_HOVER_PAN_*`, from the distance
   * the camera had left to cover when it fired). */
  durationMs: number;
  /** Whether this pan replaced one still in flight — i.e. the cursor came to
   * rest somewhere new before the camera got to the last place it rested. */
  retargeted: boolean;
}

/**
 * Where the hover-pan is in its lifecycle: `pending` = the cursor is resting
 * on the map and the debounce is running, `flying` = the camera is on its way
 * there, `idle` = neither (including while a CLICK teleport is in flight —
 * that is `activeFlightKind === "teleport"`, not a pan).
 */
export type HoverPanState = "idle" | "pending" | "flying";

/**
 * Everything a click-teleport or a hover-pan needs to know before it moves
 * the camera: the resolved voxel and where to stop relative to it. Computed
 * against the camera's CURRENT position (the standoff is on the camera's side
 * of the voxel), so it is only valid at the moment it was planned.
 */
export interface FlightPlan {
  rowId: number;
  chunkId: number;
  localVoxelId: number;
  /** The voxel's own center — what the camera ends up looking at. */
  target: THREE.Vector3;
  /** Where the camera comes to rest: `TELEPORT_STANDOFF_CHUNKS` back from the
   * target, toward where the camera is now. */
  destination: THREE.Vector3;
}

export interface MinimapBridgeDeps {
  container: HTMLElement;
  pack: MinimapPack;
  manifest: Manifest;
  chunkStore: ChunkStore;
  rowToVoxel: RowToVoxel;
  engine: Engine;
  flightControls: FlightControls;
}

/**
 * Wires the 2D minimap panel to the 3D world in all four directions the plan
 * calls for. Every one of them routes through `row_id`, because the 2D and 3D
 * UMAP fits are independent optimizations and no coordinate transform between
 * the two spaces exists (see `minimap/Manifest.ts`):
 *
 * | direction | path |
 * | --- | --- |
 * | flashlight (2D hover → 3D) | cursor px → q → row_ids in radius → `row_to_voxel` → glow boxes |
 * | crosshair (3D hover → 2D) | hovered voxel's `repr_row_id` → `qx/qy[row_id]` → overlay marker |
 * | avatar (camera → 2D) | nearest resident voxel → its `repr_row_id` → overlay marker (approximate, see below) |
 * | teleport (2D click → 3D) | q → nearest row_id → `row_to_voxel` → voxel center → prefetch + fly |
 * | pan (2D linger → 3D) | the teleport chain, fired by the cursor RESTING for `MINIMAP_HOVER_PAN_DEBOUNCE_MS` instead of by a click |
 * | flashlight (inventory hover → 3D + 2D) | stack's (chunk, voxel) → glow box; stack's `repr_row_id` → overlay marker |
 *
 * The inventory row is Phase 6.5's addition (`highlightVoxel`) — the same
 * flashlight, aimed by a caller that already knows its target instead of by a
 * 2D cursor position. See its own doc comment for how it degrades when the
 * target's chunk isn't streamed in. The pan row is Phase 6.9's
 * (`hoverPanToQ`); the two flights share `planFlight` and the Engine, and
 * differ only in what starts them, how fast they go, and what may interrupt
 * them — see `cancelHoverPan`.
 *
 * This class owns the panel rather than being handed one, which keeps the
 * callback wiring acyclic: the panel's hover/click callbacks need the bridge,
 * and the bridge needs the panel to convert pixels to q.
 */
export class MinimapBridge {
  readonly panel: MinimapRenderer;

  /** Public so the world can be poked at from the devtools console and from
   * the headless verification harness — same rationale as `window.lsv`. */
  readonly pack: MinimapPack;
  readonly rowToVoxel: RowToVoxel;

  private readonly manifest: Manifest;
  private readonly chunkStore: ChunkStore;
  private readonly engine: Engine;
  private readonly flightControls: FlightControls;

  private readonly highlight: HighlightCubes;
  private readonly rowScratch = new Uint32Array(MINIMAP_FLASHLIGHT_MAX_ROWS);
  private readonly litVoxels = new Set<number>();
  private readonly scratch = new THREE.Vector3();
  private readonly scratchB = new THREE.Vector3();

  /** Pending hover, applied at most once per frame (see `update`). Pointer
   * moves already arrive coalesced by the browser, but a fast drag across the
   * panel can still deliver several per frame, and each one costs a scan of
   * every point in the pack. */
  private pendingHover: { qx: number; qy: number } | null = null;

  private crosshairRowId = -1;

  private avatarRowId = -1;
  private avatarVoxel = -1;
  private avatarNextCheckMs = 0;
  private readonly avatarLastCameraPosition = new THREE.Vector3(Number.NaN, 0, 0);

  private lastFlashlightResult: FlashlightResult | null = null;
  private lastTeleportResult: TeleportResult | null = null;
  private lastVoxelHighlightResult: VoxelHighlightResult | null = null;
  private lastHoverPanResult: HoverPanResult | null = null;

  /**
   * Which of the bridge's two flights the Engine is currently flying, if
   * any. The Engine itself has one flight slot and no idea who filled it; the
   * bridge needs the distinction because a hover-pan yields to the player
   * (`cancelHoverPan`) and to a click, while a click-teleport yields to
   * nothing — not even a pan that comes due mid-flight (see `update`).
   */
  private activeFlight: "teleport" | "pan" | null = null;
  /** `voxelKey` of the voxel the in-flight pan is headed to, so a re-linger
   * on the same voxel doesn't restart a flight that is already going there. */
  private panVoxelKey = -1;
  /** The armed hover-pan: where the cursor is resting and when the debounce
   * runs out. Every pointermove over the panel replaces it (restarting the
   * clock); leaving the panel or taking the controls drops it. */
  private pendingPan: { qx: number; qy: number; dueAtMs: number } | null = null;
  private hoverPansFired = 0;

  constructor(deps: MinimapBridgeDeps) {
    this.pack = deps.pack;
    this.manifest = deps.manifest;
    this.chunkStore = deps.chunkStore;
    this.rowToVoxel = deps.rowToVoxel;
    this.engine = deps.engine;
    this.flightControls = deps.flightControls;

    this.panel = new MinimapRenderer(deps.container, deps.pack, {
      onHover: (qx, qy) => {
        this.pendingHover = { qx, qy };
        // Debounce, not throttle: the clock restarts on EVERY move, so it only
        // ever runs out while the cursor is holding still. Armed here rather
        // than in `update` so the timer starts at the event, not at the next
        // frame — at SwiftShader-class frame times that difference is the
        // whole debounce.
        this.pendingPan = { qx, qy, dueAtMs: performance.now() + MINIMAP_HOVER_PAN_DEBOUNCE_MS };
      },
      onLeave: () => {
        this.clearFlashlight();
        // A pan that hasn't fired yet was a promise about where the cursor is
        // resting, and it isn't resting there any more. A pan already in
        // flight is a different matter: it completes. The cursor leaving the
        // map is not the player taking the controls — it's usually on its way
        // to the world to look at what the pan is arriving at — and a flight
        // that died the instant the cursor crossed the panel border would
        // strand the camera mid-void more often than it would help.
        this.pendingPan = null;
      },
      onSelect: (qx, qy) => this.teleportToQ(qx, qy),
    });

    this.highlight = new HighlightCubes(
      MINIMAP_FLASHLIGHT_MAX_VOXELS,
      this.manifest.voxelWorldSize * VOXEL_FILL * MINIMAP_FLASHLIGHT_CUBE_FILL,
      MINIMAP_FLASHLIGHT_COLOR_3D,
      MINIMAP_FLASHLIGHT_CUBE_OPACITY,
    );
    this.engine.scene.add(this.highlight.mesh);
  }

  /** Fetches + composites the static density base image. */
  async loadBase(signal?: AbortSignal): Promise<void> {
    await this.panel.loadBase(signal);
  }

  get lastFlashlight(): FlashlightResult | null {
    return this.lastFlashlightResult;
  }

  get lastTeleport(): TeleportResult | null {
    return this.lastTeleportResult;
  }

  get lastVoxelHighlight(): VoxelHighlightResult | null {
    return this.lastVoxelHighlightResult;
  }

  get lastHoverPan(): HoverPanResult | null {
    return this.lastHoverPanResult;
  }

  get hoverPanState(): HoverPanState {
    if (this.activeFlight === "pan") return "flying";
    return this.pendingPan ? "pending" : "idle";
  }

  /** Which of the bridge's flights the Engine is on right now, or null. */
  get activeFlightKind(): "teleport" | "pan" | null {
    return this.activeFlight;
  }

  /** Running count of hover-pans that have fired — the cheapest way for the
   * verification harness to assert "exactly one pan / no pan happened". */
  get hoverPanCount(): number {
    return this.hoverPansFired;
  }

  get litVoxelCount(): number {
    return this.highlight.count;
  }

  /** row_id the avatar marker is currently drawn at, or -1. */
  get avatarRow(): number {
    return this.avatarRowId;
  }

  /** row_id the crosshair marker is currently drawn at, or -1. */
  get crosshairRow(): number {
    return this.crosshairRowId;
  }

  /**
   * The full 2D→3D resolution for a quantized position, without acting on it:
   * nearest row_id, the voxel it lives in, that voxel's world center, and
   * whether its chunk is resident right now. `planFlight` is this plus the
   * standoff destination, and `teleportToQ`/`hoverPanToQ` add the prefetch
   * and the camera flight; keeping the lookup chain separate makes it
   * inspectable from the console and assertable from a test.
   */
  resolveQ(
    qx: number,
    qy: number,
  ): {
    rowId: number;
    distanceQ: number;
    chunkId: number;
    localVoxelId: number;
    world: { x: number; y: number; z: number };
    chunkResident: boolean;
  } | null {
    const { rowId, distanceQ } = this.pack.nearestRow(qx, qy);
    if (rowId < 0) return null;
    const chunkId = this.rowToVoxel.chunkId[rowId];
    const localVoxelId = this.rowToVoxel.localVoxelId[rowId];
    this.manifest.voxelCenterWorldById(chunkId, localVoxelId, this.scratch);
    return {
      rowId,
      distanceQ,
      chunkId,
      localVoxelId,
      world: { x: this.scratch.x, y: this.scratch.y, z: this.scratch.z },
      chunkResident: this.chunkStore.chunk(chunkId) !== undefined,
    };
  }

  // --- crosshair: 3D hover → 2D --------------------------------------------

  /**
   * Publishes whichever voxel the 3D view currently has under the cursor, as
   * that voxel's representative row_id (`meta.bin`'s `repr_row_id`, already
   * resolved by `main.ts`'s hover logic). Pass `-1`/`null` for "nothing
   * hovered". Cheap to call every frame: the panel skips the redraw when the
   * marker hasn't moved.
   */
  setHoveredRow(rowId: number | null): void {
    const next = rowId === null || rowId === EMPTY_REPR_ROW_ID ? -1 : rowId;
    if (next === this.crosshairRowId) return;
    this.crosshairRowId = next;
    if (next < 0 || !this.pack.hasRow(next)) {
      this.panel.setCrosshair(null);
      return;
    }
    this.panel.setCrosshair({ qx: this.pack.rowQx(next), qy: this.pack.rowQy(next) });
  }

  // --- per-frame -----------------------------------------------------------

  /** Called from the render loop: applies at most one coalesced hover per
   * frame, fires the hover-pan if its debounce has run out, then refreshes
   * the avatar on its own slower schedule. */
  update(camera: THREE.Camera, deltaSeconds: number): void {
    if (this.pendingHover) {
      const { qx, qy } = this.pendingHover;
      this.pendingHover = null;
      this.applyFlashlight(qx, qy);
    }
    // A click-teleport in flight is never retargeted by a pan: the click was
    // a command and gets to land. The pan stays armed and fires on the frame
    // after arrival if the cursor is still resting there.
    if (this.pendingPan && this.activeFlight !== "teleport" && performance.now() >= this.pendingPan.dueAtMs) {
      const { qx, qy } = this.pendingPan;
      this.pendingPan = null;
      this.hoverPanToQ(qx, qy);
    }
    this.updateAvatar(camera, deltaSeconds * 1000);
  }

  // --- flashlight: 2D hover → 3D -------------------------------------------

  private applyFlashlight(qx: number, qy: number): void {
    const radiusQ = this.panel.radiusQFromPx(MINIMAP_FLASHLIGHT_RADIUS_PX);
    this.panel.setFlashlight({ qx, qy, radiusQ });

    const started = performance.now();
    const rows = this.pack.collectRowsNear(qx, qy, radiusQ, this.rowScratch);

    // Thousands of points typically collapse to tens of voxels — the dedupe is
    // what makes the highlight legible (and keeps the glow-box pool small).
    this.litVoxels.clear();
    for (let i = 0; i < rows; i++) {
      const row = this.rowScratch[i];
      const key = voxelKey(this.rowToVoxel.chunkId[row], this.rowToVoxel.localVoxelId[row]);
      if (this.litVoxels.size >= MINIMAP_FLASHLIGHT_MAX_VOXELS && !this.litVoxels.has(key)) break;
      this.litVoxels.add(key);
    }

    let residentVoxels = 0;
    this.highlight.begin();
    for (const key of this.litVoxels) {
      const chunkId = Math.floor(key / 65536);
      const localVoxelId = key % 65536;
      if (this.chunkStore.chunk(chunkId)) residentVoxels++;
      // Position comes from pure chunk/voxel grid math, so a voxel whose chunk
      // hasn't streamed in yet still lights up — which is the useful behavior
      // when the flashlight points somewhere the camera has never been.
      this.manifest.voxelCenterWorldById(chunkId, localVoxelId, this.scratch);
      if (!this.highlight.add(this.scratch)) break;
    }
    this.highlight.commit();

    const scanMs = performance.now() - started;
    this.lastFlashlightResult = {
      qx,
      qy,
      radiusQ,
      rows,
      voxels: this.litVoxels.size,
      residentVoxels,
      scanMs,
    };

    this.panel.setCaption(
      `${rows.toLocaleString()} pts → ${this.litVoxels.size} voxels lit\n` +
        `2D ${this.pack.rawX(qx).toFixed(2)}, ${this.pack.rawY(qy).toFixed(2)} · ` +
        `${residentVoxels} in loaded chunks`,
    );
  }

  private clearFlashlight(): void {
    this.pendingHover = null;
    this.highlight.clear();
    this.panel.setFlashlight(null);
    this.lastFlashlightResult = null;
    this.lastVoxelHighlightResult = null;
    this.panel.setCaption(null);
  }

  // --- flashlight: direct voxel target (inventory hover) --------------------

  /**
   * The OTHER entry point into the same flashlight machinery
   * `applyFlashlight` drives, for callers that already know exactly which
   * voxel they mean — currently hovering a stack row in the inventory panel
   * (Phase 6.5). Nothing is duplicated: this reuses the same `HighlightCubes`
   * overlay for 3D, the same `panel.setFlashlight` amber marker for 2D, and
   * the same caption box; it just skips the 2D-position → row_ids → voxels
   * resolution chain, because the answer is already in hand.
   *
   * **Graceful degradation when the target isn't resident** — the case the
   * plan flagged. It turns out to degrade barely at all, and for a reason
   * worth stating: BOTH halves of this highlight are computed from data that
   * does not depend on the chunk being streamed in.
   *
   * - 3D: the glow box's position comes from `Manifest.voxelCenterWorldById`,
   *   which is pure chunk/voxel grid math (the same property Phase 5 relied on
   *   so the minimap could light up regions the camera has never visited), and
   *   `HighlightCubes` is an independent overlay mesh with `depthTest: false`
   *   — not the chunk's own per-instance opacity channel. So the box is drawn
   *   at the right place either way; the only thing missing when the chunk is
   *   out is the textured voxel inside it, which is exactly the honest signal
   *   ("your points came from over there, but there's nothing loaded there
   *   right now").
   * - 2D: the marker needs a row_id, and the stack's `reprRowId` was captured
   *   when the voxel was first extracted, so it survives eviction too. The
   *   `rowIdHint` parameter is how the inventory passes it in; if it's absent
   *   or unknown to the 2D pack, this falls back to the resident chunk's
   *   `meta.reprRowId`, and only if BOTH are unavailable does the 2D marker
   *   get skipped (reported as `lit2d: false` rather than failing silently).
   *
   * The caption says which of those applies, so an unloaded target reads as a
   * state, not as a broken hover.
   */
  highlightVoxel(chunkId: number, localVoxelId: number, rowIdHint = -1): VoxelHighlightResult {
    // A pending 2D hover would otherwise overwrite this highlight on the very
    // next frame (see `update`), since both write the same overlay.
    this.pendingHover = null;

    const chunk = this.chunkStore.chunk(chunkId);
    let rowId = -1;
    if (rowIdHint >= 0 && this.pack.hasRow(rowIdHint)) {
      rowId = rowIdHint;
    } else if (chunk) {
      const repr = chunk.meta.reprRowId[localVoxelId];
      if (repr !== EMPTY_REPR_ROW_ID && this.pack.hasRow(repr)) rowId = repr;
    }

    this.manifest.voxelCenterWorldById(chunkId, localVoxelId, this.scratch);
    this.highlight.begin();
    const lit3d = this.highlight.add(this.scratch);
    this.highlight.commit();

    if (rowId >= 0) {
      this.panel.setFlashlight({
        qx: this.pack.rowQx(rowId),
        qy: this.pack.rowQy(rowId),
        radiusQ: this.panel.radiusQFromPx(MINIMAP_FLASHLIGHT_RADIUS_PX),
      });
    } else {
      this.panel.setFlashlight(null);
    }

    this.panel.setCaption(
      `inventory → chunk ${chunkId} voxel ${localVoxelId}\n` +
        (chunk
          ? `loaded · row ${rowId >= 0 ? rowId : "—"}`
          : `chunk not loaded · 3D marker only${rowId >= 0 ? "" : " · no 2D fix"}`),
    );

    const result: VoxelHighlightResult = {
      chunkId,
      localVoxelId,
      rowId,
      chunkResident: chunk !== undefined,
      lit3d,
      lit2d: rowId >= 0,
      world: { x: this.scratch.x, y: this.scratch.y, z: this.scratch.z },
    };
    this.lastVoxelHighlightResult = result;
    return result;
  }

  /** Clears whatever `highlightVoxel` last lit up. Same teardown as leaving
   * the minimap, deliberately — one flashlight, two ways to aim it. */
  clearVoxelHighlight(): void {
    this.clearFlashlight();
  }

  // --- avatar: camera → 2D --------------------------------------------------

  /**
   * Places the "you are here" marker at the 2D position of the nearest
   * occupied voxel to the camera.
   *
   * **This is an approximation, and unavoidably so.** The camera is a point in
   * a continuous 3D space, and the 2D minimap only has positions for points
   * that exist in the dataset — with the two fits being independent
   * optimizations, an arbitrary 3D position (empty space between clusters,
   * say) simply has no image in 2D minimap space. What *is* well defined is
   * "the nearest real point to the camera", so that point's own 2D position is
   * what the marker shows.
   *
   * Consequences a future reader should expect, rather than treat as bugs:
   * - the marker JUMPS when the nearest voxel changes to one that happens to
   *   sit somewhere else in the 2D fit — flying smoothly in 3D does not
   *   produce a smooth 2D path, because neighbourhoods in the two fits only
   *   loosely correspond;
   * - it is "nearest *resident*", not nearest overall: only streamed chunks
   *   have voxel occupancy in memory (`meta.bin`), so a camera parked far
   *   outside the streamed region reports the nearest thing that is loaded;
   * - it does not move at all while the camera is stationary — deliberately,
   *   so hovering in place costs nothing.
   *
   * Two-stage search, exact within the resident set: sort resident chunks by
   * center distance, then scan each chunk's occupied voxels in that order,
   * stopping as soon as a chunk's bounding-sphere lower bound can't beat the
   * best voxel found so far.
   */
  private updateAvatar(camera: THREE.Camera, deltaMs: number): void {
    this.avatarNextCheckMs -= deltaMs;
    if (this.avatarNextCheckMs > 0) return;
    this.avatarNextCheckMs = MINIMAP_AVATAR_UPDATE_MS;

    const moved = this.avatarLastCameraPosition.distanceTo(camera.position);
    if (Number.isFinite(this.avatarLastCameraPosition.x) && moved < MINIMAP_AVATAR_MOVE_EPSILON) {
      return;
    }
    this.avatarLastCameraPosition.copy(camera.position);

    const nearest = this.findNearestResidentVoxel(camera.position);
    if (!nearest) {
      if (this.avatarVoxel !== -1) {
        this.avatarVoxel = -1;
        this.avatarRowId = -1;
        this.panel.setAvatar(null);
      }
      return;
    }

    const key = voxelKey(nearest.chunkId, nearest.localVoxelId);
    if (key === this.avatarVoxel) return; // same voxel, same 2D position

    const chunk = this.chunkStore.chunk(nearest.chunkId);
    const rowId = chunk ? chunk.meta.reprRowId[nearest.localVoxelId] : EMPTY_REPR_ROW_ID;
    this.avatarVoxel = key;
    if (rowId === EMPTY_REPR_ROW_ID || !this.pack.hasRow(rowId)) {
      this.avatarRowId = -1;
      this.panel.setAvatar(null);
      return;
    }
    this.avatarRowId = rowId;
    this.panel.setAvatar({ qx: this.pack.rowQx(rowId), qy: this.pack.rowQy(rowId) });
  }

  private findNearestResidentVoxel(
    position: THREE.Vector3,
  ): { chunkId: number; localVoxelId: number; distance: number } | null {
    const byDistance: Array<{ chunkId: number; distance: number }> = [];
    for (const chunkId of this.chunkStore.residentChunkIds) {
      this.manifest.chunkCenterWorld(chunkId, this.scratchB);
      byDistance.push({ chunkId, distance: this.scratchB.distanceTo(position) });
    }
    if (byDistance.length === 0) return null;
    byDistance.sort((a, b) => a.distance - b.distance);

    // Any voxel in a chunk is at least (centerDistance - halfDiagonal) away,
    // which is what makes the early exit below sound rather than a heuristic.
    const halfDiagonal = (this.manifest.chunkWorldSize * Math.sqrt(3)) / 2;
    let bestChunk = -1;
    let bestVoxel = -1;
    let bestDistance = Infinity;

    for (const candidate of byDistance) {
      if (candidate.distance - halfDiagonal > bestDistance) break;
      const chunk = this.chunkStore.chunk(candidate.chunkId);
      if (!chunk) continue;
      const occupied = chunk.meta.occupied;
      for (let i = 0; i < occupied.length; i++) {
        const localVoxelId = occupied[i];
        this.manifest.voxelCenterWorldById(candidate.chunkId, localVoxelId, this.scratchB);
        const distance = this.scratchB.distanceTo(position);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestChunk = candidate.chunkId;
          bestVoxel = localVoxelId;
        }
      }
    }

    if (bestChunk < 0) return null;
    return { chunkId: bestChunk, localVoxelId: bestVoxel, distance: bestDistance };
  }

  // --- teleport (2D click → 3D) and pan (2D linger → 3D) --------------------

  /**
   * Resolves a 2D position to the flight a click or a pan would make from the
   * camera's current pose: the single nearest row_id (for a discrete
   * destination the nearest point is the right answer — unlike the
   * flashlight, which wants a whole neighbourhood), its voxel, and a standoff
   * destination on the camera's side of that voxel. Public so the console and
   * the verification harness can ask "where would this take me" without
   * going anywhere; `null` if the pack is empty or the row's chunk is one the
   * manifest omits.
   */
  planFlight(qx: number, qy: number): FlightPlan | null {
    const { rowId } = this.pack.nearestRow(qx, qy);
    if (rowId < 0) return null;

    const chunkId = this.rowToVoxel.chunkId[rowId];
    const localVoxelId = this.rowToVoxel.localVoxelId[rowId];
    if (!this.manifest.chunksById.has(chunkId)) {
      console.warn(`[minimap] row ${rowId} maps to chunk ${chunkId}, which the manifest omits`);
      return null;
    }

    const target = this.manifest.voxelCenterWorldById(chunkId, localVoxelId, new THREE.Vector3());

    // Approach from whichever side the camera is already on, so the arrival
    // pose is a natural continuation of the current view and never lands
    // inside the cluster.
    const direction = new THREE.Vector3().subVectors(this.engine.camera.position, target);
    if (direction.lengthSq() < 1e-6) direction.set(0, 0, 1);
    direction.normalize();
    const destination = target
      .clone()
      .addScaledVector(direction, this.manifest.chunkWorldSize * TELEPORT_STANDOFF_CHUNKS);

    return { rowId, chunkId, localVoxelId, target, destination };
  }

  /**
   * Starts the Engine flight for a plan, as a click-teleport or a hover-pan.
   *
   * Order matters and is load-bearing: `prioritizeTeleport` runs
   * synchronously BEFORE `teleportTo`, so the destination's chunk fetches are
   * already in flight while the camera is still flying. The always-resident
   * `ProxyCloud` covers whatever hasn't arrived by touchdown.
   *
   * @returns how many chunks the destination pinned into a fetching ring.
   */
  private fly(plan: FlightPlan, kind: "teleport" | "pan", durationMs?: number): number {
    const pinnedChunks = this.chunkStore.prioritizeTeleport(plan.target, this.engine.camera);
    this.activeFlight = kind;
    this.panVoxelKey = kind === "pan" ? voxelKey(plan.chunkId, plan.localVoxelId) : -1;
    this.engine.teleportTo(plan.destination, {
      lookAt: plan.target,
      durationMs,
      onArrive: () => {
        // Re-aim through FlightControls so its yaw/pitch match the quaternion
        // the slerp landed on — otherwise the next look-drag would compose
        // from stale state and snap the view.
        this.flightControls.lookAt(plan.target);
        this.chunkStore.clearTeleportTarget();
        this.activeFlight = null;
        this.panVoxelKey = -1;
      },
    });
    return pinnedChunks;
  }

  /**
   * Flies the camera to the 3D voxel holding the point nearest a clicked 2D
   * position — immediately, with no debounce, and replacing any hover-pan
   * (pending or in flight: the click is the more deliberate gesture, and a
   * pan to the same spot firing right after the click landed would be a
   * zero-length flight to nowhere).
   */
  teleportToQ(qx: number, qy: number): TeleportResult | null {
    const plan = this.planFlight(qx, qy);
    if (!plan) return null;
    this.pendingPan = null;

    const chunkWasResident = this.chunkStore.chunk(plan.chunkId) !== undefined;
    const pinnedChunks = this.fly(plan, "teleport");

    const result: TeleportResult = {
      qx,
      qy,
      rowId: plan.rowId,
      chunkId: plan.chunkId,
      localVoxelId: plan.localVoxelId,
      chunkWasResident,
      pinnedChunks,
      targetWorld: { x: plan.target.x, y: plan.target.y, z: plan.target.z },
      destinationWorld: { x: plan.destination.x, y: plan.destination.y, z: plan.destination.z },
    };
    this.lastTeleportResult = result;
    const corpus = this.pack.rowCorpusName(plan.rowId);
    this.panel.setCaption(
      `→ row ${plan.rowId}${corpus ? ` · ${corpus}` : ""}\n` +
        `chunk ${plan.chunkId} voxel ${plan.localVoxelId} · ${pinnedChunks} prefetched`,
    );
    return result;
  }

  /**
   * The hover-pan (Phase 6.9): the click-teleport's flight, started by the
   * cursor resting on the map for `MINIMAP_HOVER_PAN_DEBOUNCE_MS` (see
   * `update`) instead of by a click, and slower (`MINIMAP_HOVER_PAN_*`).
   *
   * Fired while a previous pan is still flying, this RETARGETS: the Engine
   * starts the new flight from the camera's current pose and carries its
   * current velocity (see `Engine.teleportTo`), so the camera bends toward
   * the new destination instead of stopping, or worse, starting over from
   * where the first pan began. A linger on the voxel the in-flight pan is
   * already headed to is a no-op — restarting it would only reset the
   * easing. The duration is recomputed from wherever the camera is at that
   * moment, so a retarget to somewhere close finishes soon.
   */
  hoverPanToQ(qx: number, qy: number): HoverPanResult | null {
    const plan = this.planFlight(qx, qy);
    if (!plan) return null;
    const key = voxelKey(plan.chunkId, plan.localVoxelId);
    if (this.activeFlight === "pan" && key === this.panVoxelKey) return null;
    const retargeted = this.activeFlight === "pan";

    const distance = this.engine.camera.position.distanceTo(plan.destination);
    const durationMs = Math.min(
      MINIMAP_HOVER_PAN_MAX_MS,
      Math.max(MINIMAP_HOVER_PAN_MIN_MS, distance * MINIMAP_HOVER_PAN_MS_PER_WORLD_UNIT),
    );
    const chunkWasResident = this.chunkStore.chunk(plan.chunkId) !== undefined;
    const pinnedChunks = this.fly(plan, "pan", durationMs);
    this.hoverPansFired++;

    const result: HoverPanResult = {
      qx,
      qy,
      rowId: plan.rowId,
      chunkId: plan.chunkId,
      localVoxelId: plan.localVoxelId,
      chunkWasResident,
      pinnedChunks,
      targetWorld: { x: plan.target.x, y: plan.target.y, z: plan.target.z },
      destinationWorld: { x: plan.destination.x, y: plan.destination.y, z: plan.destination.z },
      durationMs,
      retargeted,
    };
    this.lastHoverPanResult = result;
    const corpus = this.pack.rowCorpusName(plan.rowId);
    this.panel.setCaption(
      `pan → row ${plan.rowId}${corpus ? ` · ${corpus}` : ""}\n` +
        `chunk ${plan.chunkId} voxel ${plan.localVoxelId} · ${(durationMs / 1000).toFixed(1)}s`,
    );
    return result;
  }

  /**
   * The player took the controls: drop a pending hover-pan and abandon one in
   * flight where it is. Called from `main.ts` every frame a movement key is
   * held and synchronously on every pointerdown on the 3D canvas
   * (`PointerController.onPointerEngage`) — a look-drag or a hold on a
   * voxel, either way the view is theirs now. A click-teleport is left alone:
   * it was asked for, and it lands (its ≤ 0.8s flight simply ignores input,
   * as it always has — see `main.ts`).
   *
   * Two other things the cancel has to leave consistent: the chunk pin
   * (`clearTeleportTarget`, or the abandoned destination keeps prefetching
   * a neighbourhood nobody is going to) and `FlightControls`' yaw/pitch
   * (`adoptCameraOrientation` — the same re-sync `onArrive` does with
   * `lookAt`, but from a mid-slerp pose that has no target to look at).
   *
   * @returns whether a flight was actually abandoned (a pending pan being
   *   dropped doesn't count — nothing had moved yet).
   */
  cancelHoverPan(): boolean {
    this.pendingPan = null;
    if (this.activeFlight !== "pan") return false;
    this.engine.cancelTeleport();
    this.chunkStore.clearTeleportTarget();
    this.flightControls.adoptCameraOrientation();
    this.activeFlight = null;
    this.panVoxelKey = -1;
    return true;
  }

  dispose(): void {
    this.highlight.dispose();
    this.panel.dispose();
  }
}
