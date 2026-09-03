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
import { loadPointIndex, type PointIndex } from "./streaming/PointIndex.ts";
import { MiningController } from "./interaction/MiningController.ts";
import { PointerController, type VoxelTarget } from "./interaction/PointerController.ts";
import { XRayController } from "./interaction/XRayController.ts";
import { EffectorFieldController } from "./interaction/EffectorField.ts";
import { Hud, type HudStreamingState } from "./ui/Hud.ts";
import { createHoldProgressRing } from "./ui/hud/Crosshair.ts";
import { InventoryPanel } from "./ui/InventoryPanel.ts";
import { Hotbar } from "./ui/Hotbar.ts";
import {
  DATASETS,
  DEFAULT_DATASET,
  MINE_HOLD_DURATION_MS,
  WORLD_HALF_EXTENT,
  WORLD_SCALE,
  XRAY_OPACITY,
  resolveDatasetBaseUrl,
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

// scratch objects reused every frame to avoid per-frame allocation
const hitMatrix = new THREE.Matrix4();
const hitPosition = new THREE.Vector3();
const hitQuaternion = new THREE.Quaternion();
const hitScale = new THREE.Vector3();

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
    const restoring = miningController?.isMined(target.chunkId, target.localVoxelId) ?? false;
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
function loadPointIndexOnce(): Promise<PointIndex> {
  if (!manifest) return Promise.reject(new Error("point_index: manifest not loaded yet"));
  if (!pointIndexPromise) {
    pointIndexPromise = loadPointIndex(manifest).catch((error: unknown) => {
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
      miningController?.isMined(chunkId, localVoxelId) ?? false,
    );
    effectorField = new EffectorFieldController(chunkStore, manifest, engine.scene);
    // Non-null assertion: `app`'s null-check `throw` above is at module scope,
    // but TS doesn't carry that narrowing into a separate nested function
    // (this one) even though `app` is a never-reassigned `const`.
    new InventoryPanel(app!, miningController.inventory, loadPointIndexOnce);

    // Spawn just outside the densest chunk looking straight into it, so the
    // first thing on screen is the most interesting part of the embedding
    // rather than an arbitrary corner of empty space.
    frameDensestChunk(manifest);

    status = undefined;
    chunkStore.updateCamera(engine.camera, true);
  } catch (error) {
    console.error("[latent-scope-3d] failed to load dataset", error);
    status = `ERROR: ${(error as Error).message}`;
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
      `hover/mine/restore work exactly as normal`
    );
  }
  if (tool === "effector") {
    if (!effectorField) return "Effector Field equipped — waiting for world to load…";
    return (
      `Effector Field — radius ${effectorField.currentRadius.toFixed(2)} · ` +
      `distance ${effectorField.currentDistance.toFixed(2)} · suppressing ${effectorField.suppressedCount} voxels\n` +
      `scroll = move · shift+scroll = resize · [ / ] = move · - / = = resize`
    );
  }
  return "";
}

engine.start((dt) => {
  flightControls.update(dt);
  chunkStore?.updateCamera(engine.camera);
  effectorField?.update(engine.camera);
  hotbar.setStatusLine(computeHotbarStatus());

  let hoverLabel = "none";
  const hit = raycastAt(pointerController.ndc);
  currentHit = hit;
  const target = resolveVoxelTarget(hit);
  const hoveredMined = target ? (miningController?.isMined(target.chunkId, target.localVoxelId) ?? false) : false;

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
      const actionHint = miningController ? (hoveredMined ? " · hold to restore" : " · hold to mine") : "";
      hoverLabel =
        `chunk ${target.chunkId} voxel ${target.localVoxelId} · ${points} pts · row ${reprRowId} · ` +
        `${hitPosition.x.toFixed(1)}, ${hitPosition.y.toFixed(1)}, ${hitPosition.z.toFixed(1)}${actionHint}`;
    } else {
      hoverLabel = `instance #${hit.instanceId}`;
    }
  } else {
    highlightBox.visible = false;
  }

  // --- hold-to-mine / hold-to-restore progress -------------------------
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
      holdElapsedSeconds += dt;
      const durationSeconds = MINE_HOLD_DURATION_MS / 1000;
      holdRing.setProgress(holdElapsedSeconds / durationSeconds);
      if (holdElapsedSeconds >= durationSeconds) {
        const restoring = miningController?.isMined(holdTarget.chunkId, holdTarget.localVoxelId) ?? false;
        if (restoring) miningController?.restore(hit);
        else miningController?.mine(hit);
        // Consumed, not canceled — requires a fresh mousedown to arm the
        // next hold, so a completed mine can't auto-chain into a restore
        // while the button is still physically down.
        pointerController.consumeHold();
        holdElapsedSeconds = 0;
        holdRing.hide();
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
    setCursorStyle(hoveredMined ? "pointer" : "crosshair");
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
