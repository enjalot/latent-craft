import * as THREE from "three";
import { Engine } from "./engine/Engine.ts";
import { FlightControls } from "./engine/FlightControls.ts";
import { VoxelRaycaster, type VoxelHit } from "./engine/Raycast.ts";
import { createSyntheticVoxelField } from "./voxels/VoxelField.ts";
import { AtlasCache } from "./voxels/AtlasCache.ts";
import { loadProxyCloud, type ProxyCloud } from "./voxels/ProxyCloud.ts";
import { loadManifest, type Manifest } from "./streaming/Manifest.ts";
import { ChunkLoader, type ChunkMeshUserData } from "./streaming/ChunkLoader.ts";
import { ChunkStore } from "./streaming/ChunkStore.ts";
import { loadPointIndex, resolveThumbUrl, type PointIndex } from "./streaming/PointIndex.ts";
import { loadRowToVoxel } from "./streaming/RowToVoxel.ts";
import { loadMinimapPack } from "./minimap/Manifest.ts";
import { MinimapBridge } from "./interaction/MinimapBridge.ts";
import { MiningController, type ExtractionCycle } from "./interaction/MiningController.ts";
import { PointerController, type VoxelTarget } from "./interaction/PointerController.ts";
import { XRayController } from "./interaction/XRayController.ts";
import { EffectorFieldController } from "./interaction/EffectorField.ts";
import { Hud, type HudStreamingState } from "./ui/Hud.ts";
import { createHoldProgressRing } from "./ui/hud/Crosshair.ts";
import { InventoryPanel } from "./ui/InventoryPanel.ts";
import { ExtractionFlights } from "./ui/ExtractionFlight.ts";
import { Hotbar } from "./ui/Hotbar.ts";
import {
  DATASETS,
  DEFAULT_DATASET,
  EXTRACTION_CYCLE_MS,
  RESTORE_HOLD_DURATION_MS,
  WORLD_HALF_EXTENT,
  WORLD_SCALE,
  XRAY_OPACITY,
  resolveDatasetBaseUrl,
  resolveMinimapBaseUrl,
} from "./config.ts";

const app = document.getElementById("app");
if (!app) throw new Error("#app container missing from index.html");

const params = new URLSearchParams(window.location.search);
/** `?synthetic=1` brings back the Phase 1 procedural field — handy for
 * comparing engine feel against real data, and for working with the chunk
 * server down. */
const useSynthetic = params.get("synthetic") === "1";
/** `?dataset=bl-160` switches chunk-packs; the registry lives in config.ts. */
const datasetKey = params.get("dataset") ?? DEFAULT_DATASET;

const engine = new Engine(app);

// Lighting: MeshStandardMaterial needs something to shade against. A cool
// hemisphere fill + one directional "sun" gives the cubes enough form to
// read as blocks rather than flat color swatches. Dimmer than the Phase 1
// synthetic field on purpose — most BL book illustrations are dark ink on
// near-white paper, so Phase 1's intensities blew the paper out to flat
// white and destroyed the very detail the atlas is there to show.
const hemiLight = new THREE.HemisphereLight(0xbcd0ff, 0x14141f, 1.35);
engine.scene.add(hemiLight);
const sunLight = new THREE.DirectionalLight(0xfff2e0, 1.55);
sunLight.position.set(1, 1.4, 0.8);
engine.scene.add(sunLight);

const flightControls = new FlightControls(engine.camera);
const raycaster = new VoxelRaycaster(engine.camera);

/** Resolves a raycast hit back to its chunk/voxel identity, or `null` if the
 * hit isn't against a chunk-voxel mesh (e.g. the Phase 1 `?synthetic=1`
 * field, whose userData carries no `chunkId`). Shared by the per-frame hover
 * logic below and `PointerController`'s mousedown-time hit test, so the two
 * never disagree about what counts as "a voxel." */
function resolveVoxelTarget(hit: VoxelHit | null): VoxelTarget | null {
  if (!hit) return null;
  const userData = hit.mesh.userData as Partial<ChunkMeshUserData>;
  if (userData.chunkId === undefined || !userData.instanceToLocalVoxelId) return null;
  const localVoxelId = userData.instanceToLocalVoxelId[hit.instanceId];
  if (localVoxelId === undefined) return null;
  return { chunkId: userData.chunkId, localVoxelId };
}

/** Raycasts from an arbitrary NDC position against whatever the world's
 * current raycast target is (`raycastTarget`/`raycastRecursive`, set once
 * the streamed world or the synthetic field is up). */
function raycastAt(ndc: THREE.Vector2): VoxelHit | null {
  return raycastTarget ? raycaster.raycast(raycastTarget, raycastRecursive, ndc) : null;
}

// Hover highlight: a separate wireframe box repositioned to match the
// hovered instance's transform each frame.
const highlightGeometry = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
const highlightMaterial = new THREE.LineBasicMaterial({ color: 0x7fffe0, transparent: true, opacity: 0.9 });
const highlightBox = new THREE.LineSegments(highlightGeometry, highlightMaterial);
highlightBox.visible = false;
engine.scene.add(highlightBox);

const hud = new Hud(app);
const holdRing = createHoldProgressRing(app);

// Phase 4 hotbar: equip-change fans out to whichever tool controller cares.
// Both controllers are `null` until `bootstrapStreamedWorld()` finishes (see
// below), so equipping before the world loads (or under `?synthetic=1`,
// which never sets either) safely no-ops via optional chaining — nothing
// special needs to happen at construction time here.
const hotbar = new Hotbar(app, (tool) => {
  xrayController?.setActive(tool === "xray");
  effectorField?.setActive(tool === "effector", engine.camera);
});

// Fly-to-inventory tiles (one per extraction cycle) — see ExtractionFlight.ts.
const extractionFlights = new ExtractionFlights(app);

// scratch objects reused every frame to avoid per-frame allocation
const hitMatrix = new THREE.Matrix4();
const hitPosition = new THREE.Vector3();
const hitQuaternion = new THREE.Quaternion();
const hitScale = new THREE.Vector3();
const projectScratch = new THREE.Vector3();

let fpsEma = 60;
let status: string | undefined = "loading manifest…";

// --- world, either synthetic (Phase 1) or streamed (Phase 2) ----------------

let raycastTarget: THREE.Object3D | null = null;
let raycastRecursive = false;
let manifest: Manifest | null = null;
let chunkStore: ChunkStore | null = null;
let proxyCloud: ProxyCloud | null = null;
let syntheticInstances = 0;
let miningController: MiningController | null = null;
let xrayController: XRayController | null = null;
let effectorField: EffectorFieldController | null = null;
let minimap: MinimapBridge | null = null;
let inventoryPanel: InventoryPanel | null = null;

// --- pointer: click-and-drag to look, click-and-HOLD to mine/restore --------
//
// `PointerController` owns the raw pointer stream and the drag-vs-hold
// ambiguity; this module only supplies the hit-test and reacts to hold
// lifecycle events. Hold *progress* is duration-based (needs `dt`), so it's
// driven from the per-frame loop below rather than from PointerController's
// event callbacks — see that class's doc comment.
let holdElapsedSeconds = 0;

const pointerController = new PointerController(engine.renderer.domElement, flightControls, {
  hitTestVoxel: (ndc) => resolveVoxelTarget(raycastAt(ndc)),
  onHoldStart: (target) => {
    holdElapsedSeconds = 0;
    // A hold means "keep extracting" on any voxel that still has points in it,
    // and "push the whole stack back" only once it is completely drained —
    // one gesture, two unambiguous meanings, no second binding needed. See
    // `MiningController.restoreAll`.
    const restoring = miningController?.isFullyExtracted(target.chunkId, target.localVoxelId) ?? false;
    holdRing.show(restoring ? "restore" : "mine");
  },
  onHoldCancel: () => {
    holdElapsedSeconds = 0;
    holdRing.hide();
  },
});

// point_index.bin (whole-dataset row_id → thumbnail lookup) is only needed
// once the inventory panel actually wants to render a thumbnail, so it's
// fetched lazily rather than blocking the bootstrap chain above — but kicked
// off as soon as the manifest is known (see bootstrapStreamedWorld) so it's
// usually already resolved by the time the first voxel gets mined.
let pointIndexPromise: Promise<PointIndex> | null = null;
/** The resolved table, once it lands — for the couple of call sites that are
 * synchronous by nature (the fly-to-inventory tile is created inside a frame
 * callback and can't await anything). Null before then, which those call sites
 * degrade around rather than block on. */
let pointIndexReady: PointIndex | null = null;
function loadPointIndexOnce(): Promise<PointIndex> {
  if (!manifest) return Promise.reject(new Error("point_index: manifest not loaded yet"));
  if (!pointIndexPromise) {
    pointIndexPromise = loadPointIndex(manifest)
      .then((index) => {
        pointIndexReady = index;
        return index;
      })
      .catch((error: unknown) => {
        console.error("[latent-scope-3d] point_index.bin load failed", error);
        pointIndexPromise = null; // allow a later retry instead of caching the failure forever
        throw error;
      });
  }
  return pointIndexPromise;
}

if (useSynthetic) {
  const voxelField = createSyntheticVoxelField(engine.renderer);
  engine.scene.add(voxelField);
  raycastTarget = voxelField;
  syntheticInstances = voxelField.instancesCount;
  engine.camera.position.set(0, 6, WORLD_HALF_EXTENT * 1.7);
  status = undefined;
} else {
  void bootstrapStreamedWorld();
}

/**
 * Phase 2 startup: manifest → proxy cloud (immediately visible, so the world
 * is never blank) → chunk streaming. Each step is awaited in order because the
 * later ones need the earlier ones' geometry constants, but the render loop is
 * already running throughout, so the page is interactive the whole time.
 */
async function bootstrapStreamedWorld(): Promise<void> {
  try {
    const baseUrl = resolveDatasetBaseUrl(datasetKey);
    manifest = await loadManifest(baseUrl, WORLD_SCALE);
    console.info(
      `[latent-scope-3d] ${manifest.datasetId}: ${manifest.chunks.length} occupied chunks / ` +
        `${manifest.chunksPerAxis ** 3} slots, ${manifest.totalPoints.toLocaleString()} points, ` +
        `num_voxels=${manifest.numVoxels}`,
    );
    // Kick off in the background — not awaited — so it's usually already
    // resolved by the time mining/inventory needs it, without delaying the
    // proxy/chunk streaming that makes the world visible.
    void loadPointIndexOnce();

    status = "loading proxy…";
    proxyCloud = await loadProxyCloud(manifest, engine.renderer);
    engine.scene.add(proxyCloud.mesh);

    const atlasCache = new AtlasCache(engine.renderer);
    const chunkLoader = new ChunkLoader(manifest, atlasCache, engine.renderer);
    chunkStore = new ChunkStore(manifest, chunkLoader, {
      onResidencyChanged: (chunkId, resident) => {
        proxyCloud?.setChunkResident(chunkId, resident);
        // Re-apply whatever this chunk's voxels should look like/be visible
        // as before it was evicted — mined-but-not-restored opacity
        // (MiningController), the global X-Ray toggle (XRayController), and
        // "does the Effector Field currently overlap any of these voxels"
        // (EffectorFieldController) are all independent per-voxel state
        // that can't live on the mesh itself, since a chunk's InstancedMesh2
        // is disposed on eviction and rebuilt from scratch on reload. See
        // each controller's own onChunkResident doc comment.
        if (resident) {
          miningController?.onChunkResident(chunkId);
          xrayController?.onChunkResident(chunkId);
          effectorField?.onChunkResident(chunkId);
        }
      },
    });
    engine.scene.add(chunkStore.group);
    raycastTarget = chunkStore.group;
    raycastRecursive = true;

    // All four constructed synchronously right after chunkStore, with no
    // `await` in between, so the `onResidencyChanged` closure above (which
    // only ever runs from a later microtask, once a chunk load resolves)
    // never sees any of them still null.
    //
    // Ordering note: `MiningController` and `XRayController` each need to
    // query the OTHER's current state (a mined voxel under X-Ray must
    // combine both, see `voxels/VoxelOpacity.ts`), which would be a
    // constructor cycle if either held a direct reference to the other.
    // Both instead take a plain callback — `miningController` closes over
    // the `xrayController` *module-scope `let`* (declared `null` above,
    // same pattern already used for `miningController` itself pre-Phase-4),
    // which is only ever CALLED later from user interaction, by which point
    // `xrayController` is assigned; `xrayController` itself is constructed
    // one line later and can reference the by-then-real `miningController`
    // directly.
    miningController = new MiningController(chunkStore, () => xrayController?.isActive ?? false);
    xrayController = new XRayController(chunkStore, (chunkId, localVoxelId) =>
      miningController?.extractedFraction(chunkId, localVoxelId) ?? 0,
    );
    effectorField = new EffectorFieldController(chunkStore, manifest, engine.scene);
    // Non-null assertion: `app`'s null-check `throw` above is at module scope,
    // but TS doesn't carry that narrowing into a separate nested function
    // (this one) even though `app` is a never-reassigned `const`.
    inventoryPanel = new InventoryPanel(app!, miningController.inventory, {
      getPointIndex: loadPointIndexOnce,
      onReturnRow: (stackId, rowId) => miningController?.returnRow(stackId, rowId) ?? false,
      onReturnStack: (stackId) => miningController?.returnStack(stackId) ?? false,
      // `minimap` is a module-scope `let` that only gets assigned once the 2D
      // pack finishes loading in the background (see `bootstrapMinimap`), and
      // this closure only ever runs from a real pointer event — so hovering an
      // inventory row before the minimap is up simply does nothing, rather than
      // needing the panel's construction to wait on a panel it doesn't own.
      onHoverStack: (stack) => {
        if (!minimap) return;
        if (stack) minimap.highlightVoxel(stack.chunkId, stack.localVoxelId, stack.reprRowId);
        else minimap.clearVoxelHighlight();
      },
    });

    // Spawn just outside the densest chunk looking straight into it, so the
    // first thing on screen is the most interesting part of the embedding
    // rather than an arbitrary corner of empty space.
    frameDensestChunk(manifest);

    status = undefined;
    chunkStore.updateCamera(engine.camera, true);

    // Phase 5's minimap comes up last and in the background: it needs ~17 MB
    // of lookup tables (the 2D pack's xy_id.bin + the chunk pack's
    // row_to_voxel.bin) that nothing else in the app depends on, so awaiting
    // it here would delay the world for a panel. A dataset with no minimap
    // pack configured simply runs without one.
    void bootstrapMinimap(manifest, chunkStore);
  } catch (error) {
    console.error("[latent-scope-3d] failed to load dataset", error);
    status = `ERROR: ${(error as Error).message}`;
  }
}

/**
 * Phase 5: the 2D minimap. Loads the minimap pack (its own manifest +
 * `points/xy_id.bin`) and the chunk pack's `row_to_voxel.bin` in parallel,
 * then stands up the panel and its 2D↔3D bridge. The density base image
 * composites after that, so the panel appears (with live markers) before its
 * background picture does.
 */
async function bootstrapMinimap(m: Manifest, store: ChunkStore): Promise<void> {
  const minimapBaseUrl = resolveMinimapBaseUrl(datasetKey);
  if (!minimapBaseUrl) {
    console.info(`[latent-scope-3d] dataset ${datasetKey} has no minimap pack — panel disabled`);
    return;
  }
  try {
    const [pack, rowToVoxel] = await Promise.all([
      loadMinimapPack(minimapBaseUrl),
      loadRowToVoxel(m),
    ]);
    if (pack.nPoints !== m.totalPoints) {
      // Both packs index the same points table by row_id; if they disagree on
      // its size they were built from different runs and every cross-reference
      // would be silently wrong.
      throw new Error(
        `minimap pack has ${pack.nPoints} points, chunk pack has ${m.totalPoints} — ` +
          `these packs are not from the same points table`,
      );
    }
    minimap = new MinimapBridge({
      // Non-null assertion: same module-scope `throw` narrowing limitation as
      // the InventoryPanel construction above.
      container: app!,
      pack,
      manifest: m,
      chunkStore: store,
      rowToVoxel,
      engine,
      flightControls,
    });
    await minimap.loadBase();
    console.info(
      `[latent-scope-3d] minimap ready: ${pack.datasetId}, ${pack.nPoints.toLocaleString()} 2D points, ` +
        `base z${minimap.panel.densityBase?.zoom} ` +
        `(${minimap.panel.densityBase?.tilesDrawn}/${minimap.panel.densityBase?.tilesExpected} tiles)`,
    );
  } catch (error) {
    console.error("[latent-scope-3d] minimap failed to load", error);
  }
}

function frameDensestChunk(m: Manifest): void {
  const densest = m.densestChunk();
  if (!densest) return;
  const center = m.chunkCenterWorld(densest.chunk_id, new THREE.Vector3());
  // Stand-off distance is floored against the world size, not just the chunk
  // size: at higher num_voxels a chunk is small enough that "1.6 chunks back"
  // would spawn the camera *inside* the densest cluster, nose against a voxel.
  const back = Math.max(m.chunkWorldSize * 1.6, m.worldScale * 0.5);
  engine.camera.position.set(center.x + back * 0.55, center.y + back * 0.45, center.z + back);
  // Go through FlightControls so its yaw/pitch stay in sync with the
  // quaternion this sets — see `FlightControls.lookAt`'s doc comment.
  flightControls.lookAt(center);
}

/** The raycast hit as of the most recent frame, from the current cursor
 * position — read by the hold-completion logic below rather than
 * re-raycasting, since the frame loop already raycasts every frame. */
let currentHit: VoxelHit | null = null;

/**
 * Sends one tile flying from the just-drained voxel to the inventory panel.
 *
 * `worldPosition` is the voxel's own center (already decomposed this frame for
 * the hover highlight), projected to screen here rather than reusing the
 * cursor position — the cursor is on the voxel's FACE wherever you happened to
 * click, and points should read as leaving the block, not the mouse. Falls
 * back to the cursor if the projection lands somewhere unusable (behind the
 * camera can only happen if the world moved between raycast and projection,
 * but a NaN start position would strand a tile on screen forever).
 */
function launchExtractionFlight(cycle: ExtractionCycle, worldPosition: THREE.Vector3): void {
  if (!inventoryPanel) return;
  const rect = inventoryPanel.dropTargetRect();

  projectScratch.copy(worldPosition).project(engine.camera);
  let fromX = (projectScratch.x * 0.5 + 0.5) * window.innerWidth;
  let fromY = (1 - (projectScratch.y * 0.5 + 0.5)) * window.innerHeight;
  if (!Number.isFinite(fromX) || !Number.isFinite(fromY) || projectScratch.z > 1) {
    fromX = (pointerController.ndc.x * 0.5 + 0.5) * window.innerWidth;
    fromY = (1 - (pointerController.ndc.y * 0.5 + 0.5)) * window.innerHeight;
  }

  extractionFlights.launch({
    fromX,
    fromY,
    // Aim at the panel's header rather than its center: a tall panel full of
    // stacks would otherwise have tiles landing halfway down a scrolling list.
    toX: rect.left + rect.width / 2,
    toY: rect.top + 26,
    url: pointIndexReady ? resolveThumbUrl(pointIndexReady, cycle.leadRowId) : null,
    count: cycle.rowIds.length,
  });
}

// --- per-frame loop ---------------------------------------------------------

const streamingState: HudStreamingState = {
  dataset: DATASETS[datasetKey]?.label ?? datasetKey,
  chunksResident: 0,
  chunksLoading: 0,
  chunksTotal: 0,
  chunksFailed: 0,
  proxyInstances: 0,
  atlasBytes: 0,
};

/** Tracks the canvas's CSS `cursor` value so we only touch the DOM when it
 * actually changes (same "skip unchanged writes" discipline `Hud.ts` uses
 * for its text). Idle hover-state feedback (is anything targetable here?)
 * is deliberately handled this way — via the native cursor — rather than a
 * second on-screen indicator; see `Crosshair.ts`'s doc comment. */
let lastCursorStyle = "";
function setCursorStyle(value: string): void {
  if (value === lastCursorStyle) return;
  lastCursorStyle = value;
  engine.renderer.domElement.style.cursor = value;
}

/** Builds the Hotbar's status line from whichever tool is currently
 * equipped — kept out of Hud.ts per the task brief (that panel is another
 * agent's finished work), so this is the only place equip/tool state shows
 * up on screen. Cheap to call every frame: `Hotbar.setStatusLine` itself
 * skips the DOM write when the text hasn't changed. */
function computeHotbarStatus(): string {
  const tool = hotbar.equippedTool;
  if (tool === "xray") {
    return (
      `X-Ray equipped — all resident voxels translucent (opacity ${XRAY_OPACITY}) · ` +
      `hover/extract/return work exactly as normal`
    );
  }
  if (tool === "effector") {
    if (!effectorField) return "Effector Field equipped — waiting for world to load…";
    return (
      `Effector Field — radius ${effectorField.currentRadius.toFixed(2)} · ` +
      `distance ${effectorField.currentDistance.toFixed(2)} · suppressing ${effectorField.suppressedCount} voxels\n` +
      `scroll = resize · - / = = resize · [ / ] = move closer/farther`
    );
  }
  return "";
}

engine.start((dt) => {
  // Flight input stands down during a teleport flight: `Engine.stepTeleport`
  // (which already ran this frame, before this callback) interpolates the
  // camera from a fixed start snapshot, so anything WASD added here would be
  // silently discarded next frame rather than composed.
  if (!engine.isTeleporting) flightControls.update(dt);
  chunkStore?.updateCamera(engine.camera);
  effectorField?.update(engine.camera);
  minimap?.update(engine.camera, dt);
  // Self-corrects a stuck inventory-hover flashlight; a no-op (one null check)
  // whenever no inventory row is hovered. See `InventoryPanel.validateHover`
  // for the Chromium boundary-event race this defends against.
  inventoryPanel?.validateHover();
  hotbar.setStatusLine(computeHotbarStatus());

  let hoverLabel = "none";
  const hit = raycastAt(pointerController.ndc);
  currentHit = hit;
  const target = resolveVoxelTarget(hit);
  const hoveredFraction = target
    ? (miningController?.extractedFraction(target.chunkId, target.localVoxelId) ?? 0)
    : 0;
  const hoveredDrained = target
    ? (miningController?.isFullyExtracted(target.chunkId, target.localVoxelId) ?? false)
    : false;

  /** The hovered voxel's representative row_id — the ONLY handle the minimap
   * has on "where is this voxel in the 2D fit" (see MinimapBridge). */
  let hoveredRowId: number | null = null;

  if (hit) {
    hit.mesh.getMatrixAt(hit.instanceId, hitMatrix);
    hitMatrix.decompose(hitPosition, hitQuaternion, hitScale);
    highlightBox.position.copy(hitPosition);
    highlightBox.quaternion.copy(hitQuaternion);
    highlightBox.scale.copy(hitScale).multiplyScalar(1.06);
    highlightBox.visible = true;

    if (target) {
      const chunk = chunkStore?.chunk(target.chunkId);
      const points = chunk ? chunk.meta.count[target.localVoxelId] : 0;
      const reprRowId = chunk ? chunk.meta.reprRowId[target.localVoxelId] : -1;
      hoveredRowId = reprRowId >= 0 ? reprRowId : null;
      const actionHint = miningController
        ? hoveredDrained
          ? " · hold to put it all back"
          : " · hold to extract"
        : "";
      const extractedHint =
        hoveredFraction > 0 ? ` · ${Math.round(hoveredFraction * 100)}% extracted` : "";
      hoverLabel =
        `chunk ${target.chunkId} voxel ${target.localVoxelId} · ${points} pts · row ${reprRowId} · ` +
        `${hitPosition.x.toFixed(1)}, ${hitPosition.y.toFixed(1)}, ${hitPosition.z.toFixed(1)}` +
        `${extractedHint}${actionHint}`;
    } else {
      hoverLabel = `instance #${hit.instanceId}`;
    }
  } else {
    highlightBox.visible = false;
  }

  minimap?.setHoveredRow(hoveredRowId);

  // --- hold-to-extract / hold-to-put-back progress ----------------------
  //
  // Phase 6.5: a hold no longer performs ONE action and end. While the button
  // is down on a voxel that still has points in it, this runs an
  // `EXTRACTION_CYCLE_MS` timer over and over, pulling exactly one point out
  // per cycle (`extractionBatchSize` is always 1 — see config.ts for why),
  // so the voxel drains continuously, one thumbnail at a time, for as long as
  // you keep holding.
  //
  // The ring shows THIS CYCLE's own fill-and-pop progress (resets every
  // ~533ms), not the voxel's overall drain fraction. It used to show overall
  // fraction back when batch size scaled with voxel size, which made the
  // ring advance at a size-independent visual rate — but with a fixed
  // one-point batch, overall fraction would be imperceptible for a
  // many-thousand-point voxel (1/7,098 of a ring per hold-cycle reads as a
  // ring that never moves). The voxel's own fade is what communicates
  // overall "how much is left" now; the ring's job is just per-pulse
  // tactile feedback, same in every voxel regardless of size.
  const holdTarget = pointerController.holdTarget;
  if (holdTarget) {
    const stillHovering =
      !!target && target.chunkId === holdTarget.chunkId && target.localVoxelId === holdTarget.localVoxelId;
    if (!stillHovering) {
      // Hover target changed out from under an armed hold (e.g. WASD flight
      // moved the world under an otherwise-still cursor) — cancel without
      // banking any progress, per the plan's explicit requirement.
      pointerController.cancelHold();
    } else {
      const restoring = miningController?.isFullyExtracted(holdTarget.chunkId, holdTarget.localVoxelId) ?? false;
      const durationSeconds = (restoring ? RESTORE_HOLD_DURATION_MS : EXTRACTION_CYCLE_MS) / 1000;
      holdElapsedSeconds += dt;

      const cycleFraction = Math.min(1, holdElapsedSeconds / durationSeconds);
      // Restoring and extracting both just show the current cycle's own
      // fill — see the comment above on why this no longer tracks the
      // voxel's overall fraction for extraction.
      holdRing.setProgress(cycleFraction);

      if (holdElapsedSeconds >= durationSeconds) {
        if (restoring) {
          miningController?.restoreAll(hit);
          // Consumed, not canceled — requires a fresh mousedown to arm the
          // next hold, so a completed put-back can't immediately auto-chain
          // into re-extracting the voxel while the button is still down.
          pointerController.consumeHold();
          holdElapsedSeconds = 0;
          holdRing.hide();
        } else {
          const cycle = miningController?.extract(hit) ?? null;
          if (cycle) launchExtractionFlight(cycle, hitPosition);
          holdElapsedSeconds = 0;
          if (!cycle || cycle.complete) {
            // Stop at the moment the voxel empties (or if extraction couldn't
            // run at all). Continuing would roll straight into the
            // put-it-all-back timer, and an uninterrupted hold would then
            // silently undo the drain the user just performed.
            pointerController.consumeHold();
            holdRing.hide();
          } else {
            holdRing.setProgress(cycle.fraction);
          }
        }
      }
    }
  }

  // --- cursor position/state feedback -----------------------------------
  if (holdTarget) {
    const xPx = (pointerController.ndc.x * 0.5 + 0.5) * window.innerWidth;
    const yPx = (1 - (pointerController.ndc.y * 0.5 + 0.5)) * window.innerHeight;
    holdRing.setPosition(xPx, yPx);
  }
  if (pointerController.isDragging) {
    setCursorStyle("grabbing");
  } else if (target) {
    setCursorStyle(hoveredDrained ? "pointer" : "crosshair");
  } else {
    setCursorStyle("default");
  }

  const instantFps = dt > 0 ? 1 / dt : fpsEma;
  fpsEma += (instantFps - fpsEma) * 0.1;

  let residentInstances = syntheticInstances;
  let visibleInstances = syntheticInstances;
  if (chunkStore) {
    const stats = chunkStore.stats();
    streamingState.chunksResident = stats.resident;
    streamingState.chunksLoading = stats.loading;
    streamingState.chunksFailed = stats.failed;
    streamingState.chunksTotal = manifest?.chunks.length ?? 0;
    streamingState.atlasBytes = stats.bytes;
    streamingState.proxyInstances = proxyCloud?.instanceCount ?? 0;
    residentInstances = stats.instances;
    visibleInstances = 0;
    for (const mesh of chunkStore.meshes) visibleInstances += mesh.count;
  }

  hud.update({
    fps: fpsEma,
    residentInstances,
    visibleInstances,
    cameraPosition: engine.camera.position,
    hoverLabel,
    dragging: pointerController.isDragging,
    streaming: useSynthetic ? undefined : streamingState,
    status,
  });
});

// Handy for poking at the world from the devtools console (and for the
// headless verification harness, which reads counters off it).
Object.assign(window as unknown as Record<string, unknown>, {
  lsv: {
    engine,
    get manifest() {
      return manifest;
    },
    get chunkStore() {
      return chunkStore;
    },
    get proxyCloud() {
      return proxyCloud;
    },
    get miningController() {
      return miningController;
    },
    get xrayController() {
      return xrayController;
    },
    get effectorField() {
      return effectorField;
    },
    get minimap() {
      return minimap;
    },
    get inventoryPanel() {
      return inventoryPanel;
    },
    extractionFlights,
    hotbar,
    get currentHit() {
      return currentHit;
    },
    raycaster,
    flightControls,
    pointerController,
    get holdElapsedSeconds() {
      return holdElapsedSeconds;
    },
    get status() {
      return status;
    },
  },
});
