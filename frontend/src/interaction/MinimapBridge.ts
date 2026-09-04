import * as THREE from "three";
import type { Engine } from "../engine/Engine.ts";
import type { FlightControls } from "../engine/FlightControls.ts";
import { MinimapRenderer } from "../minimap/MinimapRenderer.ts";
import type { MinimapPack } from "../minimap/Manifest.ts";
import type { Manifest } from "../streaming/Manifest.ts";
import type { ChunkStore } from "../streaming/ChunkStore.ts";
import type { RowToVoxel } from "../streaming/RowToVoxel.ts";
import { HighlightCubes } from "../voxels/HighlightCubes.ts";
import type { VoxelProxyCloud } from "../voxels/VoxelProxyCloud.ts";
import type { HierarchicalProxies } from "../voxels/HierarchicalProxies.ts";
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
  MINIMAP_HOVER_LOOK_MS,
  MINIMAP_HOVER_LOOK_SETTLE_MS,
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
  /** How many are currently drawn as flat proxies instead (chunk not
   * resident) — the ones whose proxy colour got the flashlight bump, so
   * turning toward them shows the highlight before anything loads. */
  proxyVoxels: number;
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
  /** Whether the voxel's proxy instance got the flashlight colour bump —
   * true for every occupied voxel; it is only SEEN while the chunk is out. */
  litProxy: boolean;
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

/** One hover-look turn, as started: where on the map it came from and the
 * voxel it turned toward. */
export interface HoverLookResult {
  qx: number;
  qy: number;
  rowId: number;
  chunkId: number;
  localVoxelId: number;
  targetWorld: { x: number; y: number; z: number };
}

/**
 * Where the hover-look is in its lifecycle — what the verification harness
 * reads (`window.lsv.minimap.hoverLookState`). `turning` = a
 * `FlightControls.lookTransitionTo` turn is in progress; `queued` = the latest
 * hover position still waiting for a turn (during the settle window from
 * idle, or throughout a turn), which the next turn will go to; `target` = the
 * world point the in-progress turn is aimed at.
 */
export interface HoverLookState {
  state: "idle" | "turning";
  queued: { qx: number; qy: number } | null;
  target: { x: number; y: number; z: number } | null;
}

/**
 * Everything a click-teleport needs to know before it moves the camera — and
 * everything a hover-look needs, which is only `target`: the resolved voxel
 * and where to stop relative to it. Computed against the camera's CURRENT
 * position (the standoff is on the camera's side of the voxel), so it is only
 * valid at the moment it was planned.
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
  voxelProxy: VoxelProxyCloud | HierarchicalProxies;
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
 * | flashlight (2D hover → 3D) | cursor px → q → row_ids in radius → `row_to_voxel` → glow boxes + proxy colour bump |
 * | crosshair (3D hover → 2D) | hovered voxel's `repr_row_id` → `qx/qy[row_id]` → overlay marker |
 * | avatar (camera → 2D) | nearest resident voxel → its `repr_row_id` → overlay marker (approximate, see below) |
 * | teleport (2D click → 3D) | q → nearest row_id → `row_to_voxel` → voxel center → prefetch + fly |
 * | look (2D hover → 3D orientation) | the teleport chain's `target`, turned toward in place — no flight, no prefetch |
 * | flashlight (inventory hover → 3D + 2D) | stack's (chunk, voxel) → glow box; stack's `repr_row_id` → overlay marker |
 *
 * The inventory row is Phase 6.5's addition (`highlightVoxel`) — the same
 * flashlight, aimed by a caller that already knows its target instead of by a
 * 2D cursor position. See its own doc comment for how it degrades when the
 * target's chunk isn't streamed in. The look row (`hoverLookToQ`) shares
 * `planFlight` with the click and nothing else: the click flies the camera
 * through the Engine, the look only turns it through `FlightControls`, and
 * hovers are coalesced into one turn after another rather than restarting
 * the turn on every pointermove — see "Minimap hover-look" in config.ts for
 * the ask and `update` for the mechanics.
 *
 * Phase 8 adds the second half of the 3D flashlight: besides the additive
 * glow box (which was always placed from grid math, chunk resident or not),
 * the lit voxels' PROXY instances (`voxels/VoxelProxyCloud.ts`) get a
 * brighter amber colour, so a region the map is pointing at reads as lit when
 * you turn toward it even though nothing there has streamed in — "still
 * highlight when turning to them but not showing images".
 *
 * This class owns the panel rather than being handed one, which keeps the
 * callback wiring acyclic: the panel's hover/click callbacks need the bridge,
 * and the bridge needs the panel to convert pixels to q.
 */
export class MinimapBridge {
  private queryController: AbortController | null = null;
  private queryIsSelect = false;
  private queryTimer: ReturnType<typeof setTimeout> | null = null;
  private coordinateToken = 0;
  private dead = false;

  private voxelOf(row: number): { chunk: number; local: number } {
    return this.pack.rowVoxel?.(row) ?? { chunk: this.rowToVoxel.chunkId[row], local: this.rowToVoxel.localVoxelId[row] };
  }

  private prepareInput(qx: number, qy: number, select: boolean): void {
    if (!select && this.queryIsSelect) return;
    this.queryController?.abort();
    if (this.queryTimer) clearTimeout(this.queryTimer);
    const controller = new AbortController();
    this.queryController = controller;
    this.queryIsSelect = select;
    const complete = () => {
      if (this.dead || controller.signal.aborted) return;
      if (select) { this.queryIsSelect = false; this.teleportToQ(qx, qy); }
      else { this.pendingHover = { qx, qy }; this.queueHoverLook(qx, qy); }
    };
    if (!this.pack.prepareQ) { complete(); return; }
    this.queryTimer = setTimeout(() => {
      this.panel.setCaption("Loading map neighbourhood…");
      void this.pack.prepareQ!(qx, qy, select ? 0 : this.panel.radiusQFromPx(MINIMAP_FLASHLIGHT_RADIUS_PX), controller.signal)
        .then(complete).catch(error => {
          if (this.queryController === controller) this.queryIsSelect = false;
          if (!controller.signal.aborted && !this.dead) this.panel.setCaption(`Map lookup failed: ${String(error)}`);
        });
    }, select ? 0 : 100);
  }
  readonly panel: MinimapRenderer;

  /** Public so the world can be poked at from the devtools console and from
   * the headless verification harness — same rationale as `window.lsv`. */
  readonly pack: MinimapPack;
  readonly rowToVoxel: RowToVoxel;

  private readonly manifest: Manifest;
  private readonly chunkStore: ChunkStore;
  private readonly voxelProxy: VoxelProxyCloud | HierarchicalProxies;
  private readonly engine: Engine;
  private readonly flightControls: FlightControls;

  private readonly highlight: HighlightCubes;
  private readonly rowScratch = new Uint32Array(MINIMAP_FLASHLIGHT_MAX_ROWS);
  private readonly litVoxels = new Set<number>();
  /** Proxy instance ids of the current flashlight set, rebuilt per query. */
  private readonly litProxyIds: number[] = [];
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
  private lastHoverLookResult: HoverLookResult | null = null;

  /**
   * The latest map position still owed a turn, and when it may start. ONE
   * slot, overwritten by every hover: that is the whole coalescing rule. From
   * idle a hover arms it `MINIMAP_HOVER_LOOK_SETTLE_MS` out (and later hovers
   * in that window only move it, they don't push the deadline); while a turn
   * is in progress hovers just keep overwriting the position, and `update`
   * starts the turn to wherever it ended up the moment the current turn
   * finishes. Leaving the panel, a click, or the player taking the 3D view
   * drops it.
   */
  private pendingLook: { qx: number; qy: number; dueAtMs: number } | null = null;
  /** World point the in-progress hover-look turn is aimed at, or null. */
  private lookTarget: THREE.Vector3 | null = null;
  private hoverLooksStarted = 0;

  constructor(deps: MinimapBridgeDeps) {
    this.pack = deps.pack;
    this.manifest = deps.manifest;
    this.chunkStore = deps.chunkStore;
    this.voxelProxy = deps.voxelProxy;
    this.rowToVoxel = deps.rowToVoxel;
    this.engine = deps.engine;
    this.flightControls = deps.flightControls;

    this.panel = new MinimapRenderer(deps.container, deps.pack, {
      onHover: (qx, qy) => {
        this.prepareInput(qx, qy, false);
      },
      onLeave: () => {
        if (!this.queryIsSelect) {
          this.queryController?.abort();
          if (this.queryTimer) clearTimeout(this.queryTimer);
        }
        this.clearFlashlight();
        // A turn that hasn't started yet was about where the cursor is, and
        // it isn't there any more. A turn in progress is a different matter:
        // it finishes. The cursor leaving the map is not the player taking
        // the controls — it's usually on its way to the world to look at what
        // the camera is turning toward — and a turn that died the instant the
        // cursor crossed the panel border would leave the view pointed at
        // nothing in particular.
        this.pendingLook = null;
      },
      onSelect: (qx, qy) => this.prepareInput(qx, qy, true),
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

  get lastHoverLook(): HoverLookResult | null {
    return this.lastHoverLookResult;
  }

  get hoverLookState(): HoverLookState {
    const target = this.lookTarget;
    return {
      state: this.flightControls.isLookTransitioning ? "turning" : "idle",
      queued: this.pendingLook ? { qx: this.pendingLook.qx, qy: this.pendingLook.qy } : null,
      target: target ? { x: target.x, y: target.y, z: target.z } : null,
    };
  }

  /** Running count of hover-look turns that have started — the cheapest way
   * for the verification harness to assert "exactly one turn fired". */
  get hoverLookCount(): number {
    return this.hoverLooksStarted;
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
   * standoff destination, `teleportToQ` adds the prefetch and the camera
   * flight and `hoverLookToQ` the turn; keeping the lookup chain separate
   * makes it inspectable from the console and assertable from a test.
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
    const { chunk: chunkId, local: localVoxelId } = this.voxelOf(rowId);
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
    if (next >= 0 && this.pack.ensureRow && !this.pack.hasRow(next)) {
      this.panel.setCrosshair(null);
      void this.pack.ensureRow(next).then(() => {
        if (!this.dead && this.crosshairRowId === next) this.panel.setCrosshair({ qx: this.pack.rowQx(next), qy: this.pack.rowQy(next) });
      }).catch(() => { if (this.crosshairRowId === next) this.crosshairRowId = -1; });
      return;
    }
    if (next < 0 || !this.pack.hasRow(next)) {
      this.panel.setCrosshair(null);
      return;
    }
    this.panel.setCrosshair({ qx: this.pack.rowQx(next), qy: this.pack.rowQy(next) });
  }

  // --- per-frame -----------------------------------------------------------

  /** Called from the render loop, after `FlightControls.update` has advanced
   * any turn in progress: applies at most one coalesced hover per frame,
   * starts the next hover-look turn if one is owed and the turn slot is free,
   * then refreshes the avatar on its own slower schedule. */
  update(camera: THREE.Camera, deltaSeconds: number): void {
    if (this.pendingHover) {
      const { qx, qy } = this.pendingHover;
      this.pendingHover = null;
      this.applyFlashlight(qx, qy);
    }
    // The turn slot: one turn at a time, never restarted by a new hover. The
    // frame a turn ends (FlightControls has already stepped it this frame),
    // the position the cursor has moved on to gets its turn — "it will catch
    // up as the transition ends". A click-teleport's flight owns the camera
    // until it lands (`teleportToQ` drops the queue; hovers during it are
    // ignored in `queueHoverLook`), so the guard here is just the settle
    // window and the slot.
    if (
      this.pendingLook &&
      !this.flightControls.isLookTransitioning &&
      !this.engine.isTeleporting &&
      performance.now() >= this.pendingLook.dueAtMs
    ) {
      const { qx, qy } = this.pendingLook;
      this.pendingLook = null;
      this.hoverLookToQ(qx, qy);
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
      const location = this.voxelOf(row);
      const key = voxelKey(location.chunk, location.local);
      if (this.litVoxels.size >= MINIMAP_FLASHLIGHT_MAX_VOXELS && !this.litVoxels.has(key)) break;
      this.litVoxels.add(key);
    }

    let residentVoxels = 0;
    let proxyVoxels = 0;
    this.litProxyIds.length = 0;
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
      // …and its proxy cube — the thing actually on screen out there — gets
      // the colour bump too. Lit regardless of residency (see
      // `VoxelProxyCloud.setLit`); the count only reports the ones showing.
      const proxyId = this.voxelProxy.instanceIdOf(chunkId, localVoxelId);
      if (proxyId >= 0) {
        this.litProxyIds.push(proxyId);
        if (!this.voxelProxy.isChunkHidden(chunkId)) proxyVoxels++;
      }
    }
    this.highlight.commit();
    this.voxelProxy.setLit(this.litProxyIds);

    const scanMs = performance.now() - started;
    this.lastFlashlightResult = {
      qx,
      qy,
      radiusQ,
      rows,
      voxels: this.litVoxels.size,
      residentVoxels,
      proxyVoxels,
      scanMs,
    };

    this.panel.setCaption(
      `${rows.toLocaleString()} ${this.pack.prepareQ ? "sampled " : ""}pts → ${this.litVoxels.size} voxels lit\n` +
        `2D ${this.pack.rawX(qx).toFixed(2)}, ${this.pack.rawY(qy).toFixed(2)} · ` +
        `${residentVoxels} loaded · ${proxyVoxels} not loaded`,
    );
  }

  private clearFlashlight(): void {
    this.pendingHover = null;
    this.highlight.clear();
    this.voxelProxy.clearLit();
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
   *   at the right place either way; when the chunk is out, what sits inside
   *   it is the voxel's flat proxy cube (Phase 8), which gets the flashlight
   *   colour bump like any other lit voxel — the honest signal is now "your
   *   points came from that block over there, which hasn't loaded".
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
    const token = ++this.coordinateToken;
    if (rowIdHint >= 0 && this.pack.ensureRow && !this.pack.hasRow(rowIdHint)) {
      void this.pack.ensureRow(rowIdHint).then(() => {
        if (!this.dead && token === this.coordinateToken) this.highlightVoxel(chunkId, localVoxelId, rowIdHint);
      }).catch(() => undefined);
    }
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
    const proxyId = this.voxelProxy.instanceIdOf(chunkId, localVoxelId);
    this.voxelProxy.setLit(proxyId >= 0 ? [proxyId] : []);

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
          : `chunk not loaded · lit as proxy${rowId >= 0 ? "" : " · no 2D fix"}`),
    );

    const result: VoxelHighlightResult = {
      chunkId,
      localVoxelId,
      rowId,
      chunkResident: chunk !== undefined,
      lit3d,
      litProxy: proxyId >= 0,
      lit2d: rowId >= 0,
      world: { x: this.scratch.x, y: this.scratch.y, z: this.scratch.z },
    };
    this.lastVoxelHighlightResult = result;
    return result;
  }

  /** Clears whatever `highlightVoxel` last lit up. Same teardown as leaving
   * the minimap, deliberately — one flashlight, two ways to aim it. */
  clearVoxelHighlight(): void {
    ++this.coordinateToken;
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
    if (rowId !== EMPTY_REPR_ROW_ID && this.pack.ensureRow && !this.pack.hasRow(rowId)) {
      void this.pack.ensureRow(rowId).then(() => {
        if (!this.dead && this.avatarVoxel === key) {
          this.avatarRowId = rowId;
          this.panel.setAvatar({ qx: this.pack.rowQx(rowId), qy: this.pack.rowQy(rowId) });
        }
      }).catch(() => { if (this.avatarVoxel === key) this.avatarVoxel = -1; });
      return;
    }
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

  // --- teleport (2D click → 3D) and look (2D hover → 3D orientation) --------

  /**
   * Resolves a 2D position to the flight a click would make from the camera's
   * current pose: the single nearest row_id (for a discrete destination the
   * nearest point is the right answer — unlike the flashlight, which wants a
   * whole neighbourhood), its voxel, and a standoff destination on the
   * camera's side of that voxel. The hover-look uses the same plan's `target`
   * — it turns toward the voxel a click would fly to, by construction. Public
   * so the console and the verification harness can ask "where would this
   * take me" without going anywhere; `null` if the pack is empty or the row's
   * chunk is one the manifest omits.
   */
  planFlight(qx: number, qy: number): FlightPlan | null {
    const { rowId } = this.pack.nearestRow(qx, qy);
    if (rowId < 0) return null;

    const { chunk: chunkId, local: localVoxelId } = this.voxelOf(rowId);
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
   * Starts the Engine flight for a click-teleport.
   *
   * Order matters and is load-bearing: `prioritizeTeleport` runs
   * synchronously BEFORE `teleportTo`, so the destination's chunk fetches are
   * already in flight while the camera is still flying. The always-resident
   * voxel proxies (`VoxelProxyCloud`) cover whatever hasn't arrived by
   * touchdown — a destination that hasn't loaded yet is a flat-coloured block
   * you land in front of, not a hole.
   *
   * @returns how many chunks the destination pinned into a fetching ring.
   */
  private fly(plan: FlightPlan): number {
    const pinnedChunks = this.chunkStore.prioritizeTeleport(plan.target, this.engine.camera);
    this.engine.teleportTo(plan.destination, {
      lookAt: plan.target,
      onArrive: () => {
        // Re-aim through FlightControls so its yaw/pitch match the pose the
        // flight landed on — otherwise the next look-drag would compose from
        // stale state and snap the view. (Since the Engine sweeps yaw/pitch
        // directly this is a re-sync of already-consistent state, kept so
        // FlightControls stays the single owner of that pair.)
        this.flightControls.lookAt(plan.target);
        this.chunkStore.clearTeleportTarget();
      },
    });
    return pinnedChunks;
  }

  /**
   * Flies the camera to the 3D voxel holding the point nearest a clicked 2D
   * position — immediately, with no debounce, and superseding any hover-look
   * (queued or turning: the flight sweeps the orientation itself, and a turn
   * left running underneath it would resume against the landed pose the
   * moment the flight ended).
   */
  teleportToQ(qx: number, qy: number): TeleportResult | null {
    const plan = this.planFlight(qx, qy);
    if (!plan) return null;
    this.cancelHoverLook();

    const chunkWasResident = this.chunkStore.chunk(plan.chunkId) !== undefined;
    const pinnedChunks = this.fly(plan);

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
   * A hover over the map: records the position as the one owed the next
   * turn (see `pendingLook`). From idle the first hover sets the settle
   * deadline and later ones only move the position, so the turn that fires
   * `MINIMAP_HOVER_LOOK_SETTLE_MS` after the cursor arrived goes to wherever
   * it is by then; during a turn the deadline is "now", so the next turn
   * starts the frame this one ends. Ignored outright while a click-teleport
   * is flying — the click was a command and lands looking where it was
   * aimed; a hover during the flight must not swing the view away on
   * arrival.
   */
  private queueHoverLook(qx: number, qy: number): void {
    if (this.engine.isTeleporting) return;
    if (this.pendingLook) {
      this.pendingLook.qx = qx;
      this.pendingLook.qy = qy;
      return;
    }
    this.pendingLook = {
      qx,
      qy,
      dueAtMs: this.flightControls.isLookTransitioning ? 0 : performance.now() + MINIMAP_HOVER_LOOK_SETTLE_MS,
    };
  }

  /**
   * The hover-look: turns the camera, in place, toward the voxel a click at
   * this 2D position would fly to — `planFlight`'s `target` — over
   * `MINIMAP_HOVER_LOOK_MS` (`FlightControls.lookTransitionTo`). No flight,
   * no prefetch (nothing is going anywhere), and no caption of its own: the
   * flashlight's readout already describes the spot under the cursor, and a
   * turn fires on nearly every hover, so a second caption would only fight
   * it. Returns `null` when nothing was resolved or the camera is already
   * looking there (see `lookTransitionTo`'s minimum sweep) — either way no
   * turn occupies the slot, so a queued hover can go straight through.
   */
  hoverLookToQ(qx: number, qy: number): HoverLookResult | null {
    const plan = this.planFlight(qx, qy);
    if (!plan) return null;
    const started = this.flightControls.lookTransitionTo(plan.target, MINIMAP_HOVER_LOOK_MS, () => {
      this.lookTarget = null;
    });
    if (!started) return null;
    this.lookTarget = plan.target;
    this.hoverLooksStarted++;

    const result: HoverLookResult = {
      qx,
      qy,
      rowId: plan.rowId,
      chunkId: plan.chunkId,
      localVoxelId: plan.localVoxelId,
      targetWorld: { x: plan.target.x, y: plan.target.y, z: plan.target.z },
    };
    this.lastHoverLookResult = result;
    return result;
  }

  /**
   * The player took the 3D view (a pointerdown on the canvas — look-drag or
   * a hold on a voxel, `PointerController.onPointerEngage`), or a click on
   * the map is about to fly the camera: stop a turn in progress where it
   * points and drop the queued position. Flight keys are deliberately NOT a
   * cancel — turning while flying is fine, and `FlightControls.update`
   * composes the two. A click-teleport already in flight is left alone: it
   * was asked for, and it lands.
   *
   * Nothing else needs re-syncing: the turn wrote yaw/pitch every frame, so
   * `FlightControls` already owns the pose on screen, and a look never
   * pinned any chunks.
   *
   * @returns whether a turn was actually abandoned (a queued position being
   *   dropped doesn't count — nothing had moved yet).
   */
  cancelHoverLook(): boolean {
    this.queryIsSelect = false;
    this.queryController?.abort();
    if (this.queryTimer) clearTimeout(this.queryTimer);
    this.pendingLook = null;
    const turning = this.flightControls.isLookTransitioning;
    this.flightControls.cancelLookTransition();
    this.lookTarget = null;
    return turning;
  }

  dispose(): void {
    this.dead = true;
    this.queryController?.abort();
    if (this.queryTimer) clearTimeout(this.queryTimer);
    this.highlight.dispose();
    this.panel.dispose();
  }
}
