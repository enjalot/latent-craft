import * as THREE from "three";
import type { InstancedMesh2 } from "@three.ez/instanced-mesh";
import { Engine } from "./engine/Engine.ts";
import { FlightControls } from "./engine/FlightControls.ts";
import { VoxelRaycaster, type VoxelHit } from "./engine/Raycast.ts";
import { createSyntheticVoxelField } from "./voxels/VoxelField.ts";
import { AtlasCache } from "./voxels/AtlasCache.ts";
import { SharpBand } from "./interaction/SharpBand.ts";
import { VoxelProxyCloud } from "./voxels/VoxelProxyCloud.ts";
import { HierarchicalProxies } from "./voxels/HierarchicalProxies.ts";
import { loadManifest, type Manifest } from "./streaming/Manifest.ts";
import { loadVoxelProxy } from "./streaming/VoxelProxy.ts";
import { ChunkLoader, type ChunkMeshUserData } from "./streaming/ChunkLoader.ts";
import { ChunkStore } from "./streaming/ChunkStore.ts";
import { loadPointIndex, resolveThumbUrl, type PointIndex } from "./streaming/PointIndex.ts";
import { loadRowToVoxel } from "./streaming/RowToVoxel.ts";
import { loadMinimapPack } from "./minimap/Manifest.ts";
import { StreamingMinimap } from "./minimap/StreamingMinimap.ts";
import { rangeReader } from "./streaming/RangeReader.ts";
import { isAbortError } from "./net/fetchTyped.ts";
import { MinimapBridge } from "./interaction/MinimapBridge.ts";
import type { ProxyVoxel } from "./voxels/VoxelProxyCloud.ts";
import { MiningController, type ExtractionCycle } from "./interaction/MiningController.ts";
import { PointerController, type VoxelTarget } from "./interaction/PointerController.ts";
import { XRayController } from "./interaction/XRayController.ts";
import { EffectorFieldController } from "./interaction/EffectorField.ts";
import { GameSession } from "./interaction/GameSession.ts";
import { planVoxelFlight } from "./interaction/VoxelFlight.ts";
import { Hud, type HudStreamingState } from "./ui/Hud.ts";
import { DatasetPicker } from "./ui/DatasetPicker.ts";
import { SearchCompare } from "./ui/SearchCompare.ts";
import { SearchNavigation } from "./interaction/SearchNavigation.ts";
import { createHoldProgressRing } from "./ui/hud/Crosshair.ts";
import { InventoryPanel } from "./ui/InventoryPanel.ts";
import { ExtractionFlights } from "./ui/ExtractionFlight.ts";
import { Hotbar } from "./ui/Hotbar.ts";
import {
  DATASETS,
  DEFAULT_DATASET,
  EXTRACTION_CYCLE_MS,
  HEMISPHERE_GROUND_COLOR,
  HEMISPHERE_INTENSITY,
  HEMISPHERE_SKY_COLOR,
  RING_R0_CHUNKS,
  SUN_COLOR,
  SUN_DIRECTION,
  SUN_INTENSITY,
  WORLD_HALF_EXTENT,
  WORLD_SCALE,
  XRAY_OPACITY,
  resolveDatasetBaseUrl,
  resolveMinimapBaseUrl,
  resolvePointsId,
  resolveThumbsBaseUrl,
} from "./config.ts";

const app = document.getElementById("app");
if (!app) throw new Error("#app container missing from index.html");
const appLifetime = new AbortController();
let appDisposed = false;

const params = new URLSearchParams(window.location.search);
/** `?synthetic=1` brings back the Phase 1 procedural field — handy for
 * comparing engine feel against real data, and for working with the chunk
 * server down. */
const useSynthetic = params.get("synthetic") === "1";
/** `?dataset=bl-160` switches chunk-packs; the registry lives in config.ts. */
const datasetKey = params.get("dataset") ?? DEFAULT_DATASET;

// `?sky=0` / `?headlamp=0`: A/B switches for the two Phase 7 environment
// additions — the flat clear colour instead of the nebula cubemap, and the
// distance-independent rig alone without the camera-carried lamp.
const engine = new Engine(app, {
  sky: params.get("sky") !== "0",
  headlamp: params.get("headlamp") !== "0",
});

// The distance-independent half of the light rig — see "Light rig" in
// config.ts for the whole set and why these two sit below full brightness.
// MeshStandardMaterial needs something to shade against: a cool hemisphere
// fill + one directional "sun" gives the cubes enough form to read as blocks
// rather than flat colour swatches. The headlamp (the distance-DEPENDENT half)
// is Engine's, since it has to follow the camera every frame.
const hemiLight = new THREE.HemisphereLight(HEMISPHERE_SKY_COLOR, HEMISPHERE_GROUND_COLOR, HEMISPHERE_INTENSITY);
engine.scene.add(hemiLight);
const sunLight = new THREE.DirectionalLight(SUN_COLOR, SUN_INTENSITY);
sunLight.position.set(...SUN_DIRECTION);
engine.scene.add(sunLight);
// Cool edge separation against the warm key, without shadow-map passes.
const rimLight = new THREE.DirectionalLight(0x94cfff, .65);
rimLight.position.set(-2, .6, -1.5);
engine.scene.add(rimLight);

const flightControls = new FlightControls(engine.camera);

/** Resolves an instance of a mesh back to its chunk/voxel identity, or
 * `null` if the mesh isn't a TEXTURED chunk-voxel mesh — the Phase 1
 * `?synthetic=1` field and the Phase 8 proxy mesh both carry no `chunkId` in
 * their userData and so resolve to nothing here. That is load-bearing for the
 * proxies: `PointerController` arms a hold on exactly what `resolveVoxelTarget`
 * returns, so a proxy voxel (no point ids to extract) can never arm one, and
 * `MiningController` can never be handed a proxy hit. A proxy hover is
 * resolved separately, by `resolveProxyVoxel`. */
function voxelIdentityOf(mesh: InstancedMesh2, instanceId: number): VoxelTarget | null {
  const userData = mesh.userData as Partial<ChunkMeshUserData>;
  if (userData.chunkId === undefined || !userData.instanceToLocalVoxelId) return null;
  const localVoxelId = userData.instanceToLocalVoxelId[instanceId];
  if (localVoxelId === undefined) return null;
  return { chunkId: userData.chunkId, localVoxelId };
}

/** `voxelIdentityOf` for a raycast hit. Shared by the per-frame hover logic
 * below and the mousedown-time hit test, so the two never disagree about what
 * counts as "a voxel." */
function resolveVoxelTarget(hit: VoxelHit | null): VoxelTarget | null {
  return hit ? voxelIdentityOf(hit.mesh, hit.instanceId) : null;
}

// The cursor looks THROUGH a fully drained voxel and lands on whatever is
// behind it ("empty cubes should not interact anymore, so that you can mine
// whats behind them") — see `VoxelRaycaster`'s class comment for why this is
// a predicate on the intersection list rather than a visibility flag. Only
// textured chunk voxels can be drained, so proxies and anything without a
// chunk identity are never pass-through; `miningController` is the
// module-scope `let` assigned once the world is up, and before then nothing
// is drained.
const raycaster = new VoxelRaycaster(engine.camera, (mesh, instanceId) => {
  const target = voxelIdentityOf(mesh, instanceId);
  return !!target && (miningController?.isFullyExtracted(target.chunkId, target.localVoxelId) ?? false);
});

/** The proxy voxel a hit landed on, or `null` if the hit is against anything
 * else. Identity is by mesh, not userData: there is exactly one proxy mesh. */
function resolveProxyVoxel(hit: VoxelHit | null): ProxyVoxel | null {
  if (hit && voxelProxy instanceof HierarchicalProxies) return voxelProxy.resolveHit(hit.mesh, hit.instanceId);
  if (!hit || !(voxelProxy instanceof VoxelProxyCloud) || hit.mesh !== voxelProxy.mesh) return null;
  return voxelProxy.voxelAt(hit.instanceId);
}

/** Raycasts from an arbitrary NDC position against whatever the world's
 * current raycast targets are (`raycastTargets`/`raycastRecursive`, set once
 * the streamed world or the synthetic field is up). */
function raycastAt(ndc: THREE.Vector2): VoxelHit | null {
  return raycastTargets ? raycaster.raycast(raycastTargets, raycastRecursive, ndc) : null;
}

// Hover highlight: a separate wireframe box repositioned to match the
// hovered instance's transform each frame.
const highlightGeometry = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
const highlightMaterial = new THREE.LineBasicMaterial({ color: 0x7fffe0, transparent: true, opacity: 0.9 });
const highlightBox = new THREE.LineSegments(highlightGeometry, highlightMaterial);
highlightBox.visible = false;
// Drawn after the container cages (renderOrder 1, see `VoxelContainers.ts`):
// the box sits just inside a cage's rails, so in submission order the rails
// would composite over the teal lines and the hover would vanish on exactly
// the faces you are looking at. The cages write no depth, so ordering alone
// puts the lines on top; they still depth-test against the cube itself, which
// is what hides the box's far edges as before.
highlightBox.renderOrder = 2;
engine.scene.add(highlightBox);

// One scrolling left dock: search results cannot overlap settings or hotbar.
const leftDock = document.createElement("div");
leftDock.className = "ls-left-dock";
Object.assign(leftDock.style, { position: "fixed", top: "14px", left: "14px", maxHeight: "calc(100vh - 104px)",
  width: "min(420px, calc(100vw - 28px))", display: "flex", flexDirection: "column",
  gap: "8px", overflowY: "auto", overflowX: "hidden", zIndex: "11", pointerEvents: "auto" });
app.append(leftDock);
const datasetPicker = new DatasetPicker(leftDock, datasetKey, DATASETS, useSynthetic, true);
const hud = new Hud(leftDock, true);
let searchNavigation: SearchNavigation | null = null;
const searchCompare = new SearchCompare(leftDock, useSynthetic ? "synthetic" : datasetKey, {
  project: response => {
    if (!searchNavigation) throw new Error("Map is still loading; try again shortly");
    searchNavigation.project(response);
  },
  hover: result => searchNavigation?.hover(result),
  select: result => searchNavigation?.select(result),
  clear: () => searchNavigation?.clear(),
});
engine.renderer.domElement.addEventListener("pointerdown", () => searchNavigation?.clear(), { signal: appLifetime.signal });
const holdRing = createHoldProgressRing(app);

// Hand / bulk extraction / glass view are separate slots; the field is always on.
const hotbar = new Hotbar(app, (tool) => {
  xrayController?.setActive(tool === "xray");
});

// Fly-to-inventory tiles (one per extraction cycle) — see ExtractionFlight.ts.
const extractionFlights = new ExtractionFlights(app);
let sharpBand: SharpBand | null = null;

// scratch objects reused every frame to avoid per-frame allocation
const hitMatrix = new THREE.Matrix4();
const hitPosition = new THREE.Vector3();
const hitQuaternion = new THREE.Quaternion();
const hitScale = new THREE.Vector3();
const projectScratch = new THREE.Vector3();

let fpsEma = 60;
let status: string | undefined = "loading manifest…";

// --- world, either synthetic (Phase 1) or streamed (Phase 2) ----------------

let raycastTargets: THREE.Object3D | THREE.Object3D[] | null = null;
let raycastRecursive = false;
let manifest: Manifest | null = null;
let chunkStore: ChunkStore | null = null;
let voxelProxy: VoxelProxyCloud | HierarchicalProxies | null = null;
let syntheticInstances = 0;
let miningController: MiningController | null = null;
let xrayController: XRayController | null = null;
let effectorField: EffectorFieldController | null = null;
let minimap: MinimapBridge | null = null;
let inventoryPanel: InventoryPanel | null = null;
let gameSession: GameSession | null = null;
let syntheticVoxelField: InstancedMesh2 | null = null;

// --- pointer: click-and-drag to look, click-and-HOLD to extract -------------
//
// `PointerController` owns the raw pointer stream and the drag-vs-hold
// ambiguity; this module only supplies the hit-test and reacts to hold
// lifecycle events. Hold *progress* is duration-based (needs `dt`), so it's
// driven from the per-frame loop below rather than from PointerController's
// event callbacks — see that class's doc comment.
let holdElapsedSeconds = 0;
let pointerOverWorld = false;
engine.renderer.domElement.addEventListener("pointerenter", () => { pointerOverWorld = true; },
  { signal: appLifetime.signal });
engine.renderer.domElement.addEventListener("pointerleave", () => { pointerOverWorld = false; },
  { signal: appLifetime.signal });
window.addEventListener("blur", () => { pointerOverWorld = false; }, { signal: appLifetime.signal });

const pointerController = new PointerController(engine.renderer.domElement, flightControls, {
  hitTestVoxel: (ndc) => resolveVoxelTarget(raycastAt(ndc)),
  // Taking hold of the 3D view (look-drag or a hold on a voxel) is the
  // player's, and it stops a minimap hover-look turn the instant it starts.
  // `minimap` is the module-scope `let` assigned once the 2D pack loads, and
  // this only ever runs from a real pointer event, so before then it is a
  // no-op.
  onPointerEngage: () => {
    minimap?.cancelHoverLook();
  },
  onHoldStart: () => {
    holdElapsedSeconds = 0;
    // A hold has exactly one meaning — keep extracting — because the only
    // voxels that can be held are ones with points still in them: a fully
    // drained voxel is pass-through to the cursor (see `raycaster` above), so
    // it can never be the target here.
    holdRing.show();
    // Starts the one shared row-id→thumbnail table early enough for the
    // focused high-resolution face to appear during this first mining cycle.
    void loadPointIndexOnce().catch(() => undefined);
  },
  onHoldCancel: () => {
    holdElapsedSeconds = 0;
    holdRing.hide();
  },
});

// Sharp previews and inventory share this row-to-thumbnail lookup. Streaming
// packs request bounded record pages; only legacy packs load the whole table.
let pointIndexPromise: Promise<PointIndex> | null = null;
/** The resolved table, once it lands — for the couple of call sites that are
 * synchronous by nature (the fly-to-inventory tile is created inside a frame
 * callback and can't await anything). Null before then, which those call sites
 * degrade around rather than block on. */
let pointIndexReady: PointIndex | null = null;
function loadPointIndexOnce(): Promise<PointIndex> {
  if (!manifest) return Promise.reject(new Error("point_index: manifest not loaded yet"));
  if (!pointIndexPromise) {
    pointIndexPromise = loadPointIndex(
      manifest,
      resolveThumbsBaseUrl(datasetKey),
      appLifetime.signal,
    )
      .then((index) => {
        pointIndexReady = index;
        return index;
      })
      .catch((error: unknown) => {
        if (!isAbortError(error)) {
          console.error("[latent-scope-3d] point_index.bin load failed", error);
        }
        pointIndexPromise = null; // allow a later retry instead of caching the failure forever
        throw error;
      });
  }
  return pointIndexPromise;
}

if (useSynthetic) {
  syntheticVoxelField = createSyntheticVoxelField(engine.renderer);
  engine.scene.add(syntheticVoxelField);
  raycastTargets = syntheticVoxelField;
  syntheticInstances = syntheticVoxelField.instancesCount;
  engine.camera.position.set(0, 6, WORLD_HALF_EXTENT * 1.7);
  status = undefined;
} else {
  void bootstrapStreamedWorld();
}

/**
 * Phase 2 startup: manifest → voxel proxies (every occupied voxel, immediately
 * visible, so the world is never blank) → chunk streaming. Each step is
 * awaited in order because the later ones need the earlier ones' geometry
 * constants, but the render loop is already running throughout, so the page
 * is interactive the whole time.
 *
 * The order of the last two is also a correctness requirement, not just a
 * convenience: the proxy layer hides a chunk's run from `ChunkStore`'s
 * `onResidencyChanged` hook, and the store is constructed (and starts its
 * first loads) only AFTER the proxies are up, so there is no chunk that could
 * become resident before the layer exists to hear about it — every residency
 * change in the session flows through the hook.
 */
async function bootstrapStreamedWorld(): Promise<void> {
  try {
    const baseUrl = resolveDatasetBaseUrl(datasetKey);
    manifest = await loadManifest(baseUrl, WORLD_SCALE, appLifetime.signal);
    console.info(
      `[latent-scope-3d] ${manifest.datasetId}: ${manifest.chunks.length} occupied chunks / ` +
        `${manifest.chunksPerAxis ** 3} slots, ${manifest.totalPoints.toLocaleString()} points, ` +
        `num_voxels=${manifest.numVoxels}`,
    );
    status = "loading proxy…";
    voxelProxy = manifest.raw.streaming ? await HierarchicalProxies.load(manifest, engine.renderer, appLifetime.signal) : new VoxelProxyCloud(
      manifest,
      await loadVoxelProxy(manifest, appLifetime.signal),
      engine.renderer,
    );
    engine.scene.add(voxelProxy.mesh);

    const atlasCache = new AtlasCache(engine.renderer);
    const chunkLoader = new ChunkLoader(manifest, atlasCache, engine.renderer);
    chunkStore = new ChunkStore(manifest, chunkLoader, {
      onDisplayChanged: (chunkId, shown) => {
        voxelProxy?.setChunkResident(chunkId, shown);
        effectorField?.onChunkDisplayChanged();
      },
      onResidencyChanged: (chunkId, resident) => {
        // Re-apply whatever this chunk's voxels should look like/be visible
        // as before it was evicted — mined-but-not-restored opacity
        // (MiningController), Pickaxe's glass toggle (XRayController), and
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
    // Both layers are hover targets. The raycaster returns the nearest hit
    // across all of them, and a chunk's proxy run is un-raycastable while its
    // textured mesh is displayed (`VoxelProxyCloud.setChunkResident`), so the
    // two can never both be hit at one voxel's position.
    raycastTargets = [chunkStore.group, voxelProxy.mesh];
    raycastRecursive = true;

    // All four constructed synchronously right after chunkStore, with no
    // `await` in between, so the `onResidencyChanged` closure above (which
    // only ever runs from a later microtask, once a chunk load resolves)
    // never sees any of them still null.
    //
    // Ordering note: `MiningController` and `XRayController` each need to
    // query the OTHER's current state (a mined voxel under glass view must
    // combine both, see `voxels/VoxelOpacity.ts`), which would be a
    // constructor cycle if either held a direct reference to the other.
    // Both instead take a plain callback — `miningController` closes over
    // the `xrayController` *module-scope `let`* (declared `null` above,
    // same pattern already used for `miningController` itself pre-Phase-4),
    // which is only ever CALLED later from user interaction, by which point
    // `xrayController` is assigned; `xrayController` itself is constructed
    // one line later and can reference the by-then-real `miningController`
    // directly.
    miningController = new MiningController(
      chunkStore,
      () => xrayController?.isActive ?? false,
      () => hotbar.equippedTool === "pickaxe",
      manifest,
    );
    xrayController = new XRayController(chunkStore, (chunkId, localVoxelId) =>
      miningController?.extractedFraction(chunkId, localVoxelId) ?? 0,
    );
    // Respect a keypress made while the world was still loading.
    xrayController.setActive(hotbar.equippedTool === "xray");
    effectorField = new EffectorFieldController(
      chunkStore,
      manifest,
      engine.scene,
      engine.renderer.domElement,
    );
    sharpBand = new SharpBand(engine.scene, engine.renderer, chunkStore, manifest, miningController, loadPointIndexOnce);
    searchNavigation = new SearchNavigation(manifest, engine, flightControls, chunkStore, sharpBand,
      () => minimap, () => effectorField?.currentRadius ?? 0, () => pointerController.cancelHold());
    // Non-null assertion: `app`'s null-check `throw` above is at module scope,
    // but TS doesn't carry that narrowing into a separate nested function
    // (this one) even though `app` is a never-reassigned `const`.
    inventoryPanel = new InventoryPanel(app!, miningController.inventory, {
      getPointIndex: loadPointIndexOnce,
      onReturnRow: (stackId, rowId) => miningController?.returnRow(stackId, rowId) ?? false,
      onReturnStack: (stackId) => miningController?.returnStack(stackId) ?? false,
      onTeleportStack: (stack) => {
        if (!manifest || !chunkStore) return;
        const plan = planVoxelFlight(manifest, stack.chunkId, stack.localVoxelId,
          engine.camera.position, effectorField?.currentRadius ?? 0);
        if (!plan) return;
        pointerController.cancelHold();
        minimap?.cancelHoverLook();
        flightControls.cancelLookTransition();
        chunkStore.prioritizeTeleport(plan.target, engine.camera);
        engine.teleportTo(plan.destination, {
          lookAt: plan.target,
          onArrive: () => {
            flightControls.lookAt(plan.target);
            chunkStore?.clearTeleportTarget();
          },
        });
      },
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
      // The lightbox's `/meta/<points_id>/<row_id>` original-image lookup —
      // the POINTS TABLE id, shared by every voxel resolution of a dataset
      // (see `DatasetConfig.pointsId`).
      pointsId: resolvePointsId(datasetKey),
    });

    // Spawn just outside the densest chunk looking straight into it, so the
    // first thing on screen is the most interesting part of the embedding
    // rather than an arbitrary corner of empty space.
    frameDensestChunk(manifest);
    gameSession = new GameSession(datasetKey, manifest, miningController, inventoryPanel, loadPointIndexOnce);
    const settings = gameSession.settings;
    flightControls.setSpeed(settings.speed * manifest.voxelWorldSize);
    effectorField.setRadiusVoxels(settings.radius, false);
    if (settings.position) engine.camera.position.fromArray(settings.position);
    if (settings.quaternion) {
      engine.camera.quaternion.fromArray(settings.quaternion).normalize();
      const forward = engine.camera.getWorldDirection(new THREE.Vector3());
      flightControls.lookAt(engine.camera.position.clone().add(forward));
    }
    hud.configure({ speed: settings.speed, radius: settings.radius, maxRadius: 48,
      onSpeed: value => { settings.speed = value; flightControls.setSpeed(value * manifest!.voxelWorldSize); },
      onRadius: value => effectorField?.setRadiusVoxels(value) });
    // Places the always-on field at the post-frame spawn before the first
    // chunk residency callback can apply suppression.
    effectorField.update(engine.camera);

    status = undefined;
    chunkStore.updateCamera(engine.camera, true);

    // Phase 5's minimap comes up last and in the background: it needs ~17 MB
    // of lookup tables (the 2D pack's xy_id.bin + the chunk pack's
    // row_to_voxel.bin) that nothing else in the app depends on, so awaiting
    // it here would delay the world for a panel. A dataset with no minimap
    // pack configured simply runs without one.
    void bootstrapMinimap(manifest, chunkStore, voxelProxy);
  } catch (error) {
    if (appLifetime.signal.aborted || isAbortError(error)) return;
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
async function bootstrapMinimap(m: Manifest, store: ChunkStore, proxies: VoxelProxyCloud | HierarchicalProxies): Promise<void> {
  const minimapBaseUrl = resolveMinimapBaseUrl(datasetKey);
  if (!minimapBaseUrl) {
    console.info(`[latent-scope-3d] dataset ${datasetKey} has no minimap pack — panel disabled`);
    return;
  }
  let bridge: MinimapBridge | null = null;
  try {
    const [pack, rowToVoxel] = await Promise.all([
      m.raw.streaming?.spatial ? StreamingMinimap.load(m, appLifetime.signal) : loadMinimapPack(minimapBaseUrl, appLifetime.signal),
      m.raw.streaming?.spatial ? Promise.resolve({ chunkId: new Uint32Array(0), localVoxelId: new Uint16Array(0) }) : loadRowToVoxel(m, appLifetime.signal),
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
    bridge = new MinimapBridge({
      // Non-null assertion: same module-scope `throw` narrowing limitation as
      // the InventoryPanel construction above.
      container: inventoryPanel!.minimapDock,
      pack,
      manifest: m,
      chunkStore: store,
      voxelProxy: proxies,
      rowToVoxel,
      engine,
      flightControls,
    });
    minimap = bridge;
    await bridge.loadBase(appLifetime.signal);
    console.info(
      `[latent-scope-3d] minimap ready: ${pack.datasetId}, ${pack.nPoints.toLocaleString()} 2D points, ` +
        `base z${bridge.panel.densityBase?.zoom} ` +
        `(${bridge.panel.densityBase?.tilesDrawn}/${bridge.panel.densityBase?.tilesExpected} tiles)`,
    );
  } catch (error) {
    // A density-tile failure happens after the panel and GPU highlight mesh
    // exist. Tear that partial bridge down unless page teardown already did.
    if (bridge && minimap === bridge) {
      bridge.dispose();
      minimap = null;
    }
    if (appLifetime.signal.aborted || isAbortError(error)) return;
    console.error("[latent-scope-3d] minimap failed to load", error);
  }
}

function frameDensestChunk(m: Manifest): void {
  const densest = m.densestChunk();
  if (!densest) return;
  const center = m.chunkCenterWorld(densest.chunk_id, new THREE.Vector3());
  // Stand-off is tied to the R0 streaming ring, not to the world size: the
  // whole point of framing the densest chunk is that the first thing on
  // screen is TEXTURED, and with the Phase 7 rings (R0 = 1.5 chunk edges) a
  // spawn any farther out than that shows the densest cluster as grey proxy
  // blocks at screen centre while its atlas is still outside the load ring
  // (measured: the old `max(1.6 chunks, 0.5 * worldScale)` put the camera
  // 30.7 u out on bl-160, against an R0 of 15 u). 0.8 of R0 along the
  // (0.55, 0.45, 1) approach lands the camera at ~0.97 R0 from the chunk
  // centre — inside the ring with a little margin, and still well clear of
  // the chunk's own faces (its half-edge is 0.5 chunk).
  const back = RING_R0_CHUNKS * m.chunkWorldSize * 0.8;
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
    url: pointIndexReady ? resolveThumbUrl(pointIndexReady, cycle.lastRowId) : null,
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
  proxyVoxelsShown: 0,
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
  const fieldStatus = effectorField
    ? `Effector ${effectorField.currentRadiusVoxels.toFixed(2)} vox · ` +
      `${effectorField.suppressedCount} ghosted · scroll over world to resize`
    : useSynthetic
      ? ""
      : "Effector loading…";
  if (tool === "pickaxe") return `Pickaxe · up to 100 points/cycle\n${fieldStatus}`;
  if (tool === "xray") return `X-ray · glass opacity ${XRAY_OPACITY} · 1 point/cycle\n${fieldStatus}`;
  return fieldStatus;
}

engine.start((dt) => {
  // A click-teleport makes flight input stand down: `Engine.stepTeleport`
  // (which already ran this frame, before this callback) interpolates the
  // camera from a fixed start snapshot, so anything WASD added here would be
  // silently discarded next frame rather than composed. A minimap hover-look
  // turn is the opposite — it lives INSIDE `flightControls.update`, so WASD
  // and the turn compose, and a movement key never cancels it (only the
  // pointer does, synchronously in `onPointerEngage` above). `minimap.update`
  // runs after the controls so the frame a turn ends is the frame the next
  // queued one starts.
  if (!engine.isTeleporting) flightControls.update(dt);
  chunkStore?.updateCamera(engine.camera);
  if (voxelProxy instanceof HierarchicalProxies) voxelProxy.update(engine.camera);
  effectorField?.update(engine.camera, pointerController.ndc);
  if (effectorField) {
    hud.updateRadius(effectorField.currentRadiusVoxels);
    gameSession?.saveSettings(engine.camera.position.toArray(), engine.camera.quaternion.toArray(), effectorField.currentRadiusVoxels);
  }
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
  const proxyVoxel = target ? null : resolveProxyVoxel(hit);
  // Never 1: a fully drained voxel is pass-through to the raycast, so the
  // hovered target always has at least one point left in it.
  const hoveredFraction = target
    ? (miningController?.extractedFraction(target.chunkId, target.localVoxelId) ?? 0)
    : 0;

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
      const actionHint = miningController ? " · hold to extract" : "";
      const extractedHint =
        hoveredFraction > 0 ? ` · ${Math.round(hoveredFraction * 100)}% extracted` : "";
      hoverLabel =
        `chunk ${target.chunkId} voxel ${target.localVoxelId} · ${points} pts · row ${reprRowId} · ` +
        `${hitPosition.x.toFixed(1)}, ${hitPosition.y.toFixed(1)}, ${hitPosition.z.toFixed(1)}` +
        `${extractedHint}${actionHint}`;
    } else if (proxyVoxel) {
      // A flat stand-in for a chunk that hasn't streamed in: same teal box
      // (it is the same voxel, just not fetched yet), but no action hint, no
      // representative row (the proxy file carries none, so the minimap
      // crosshair stays off) and — see `resolveVoxelTarget` — no hold.
      hoverLabel =
        proxyVoxel.chunkId < 0 || proxyVoxel.localVoxelId < 0
          ? `${proxyVoxel.count.toLocaleString()} pts · overview region — fly closer to refine`
          : `chunk ${proxyVoxel.chunkId} voxel ${proxyVoxel.localVoxelId} · ${proxyVoxel.count} pts · not loaded — fly closer`;
    } else {
      hoverLabel = `instance #${hit.instanceId}`;
    }
  } else {
    highlightBox.visible = false;
  }

  minimap?.setHoveredRow(hoveredRowId);
  if (target && pointerOverWorld && !pointerController.isDragging)
    miningController?.prepare(target.chunkId, target.localVoxelId);

  // --- hold-to-extract progress -------------------------------------------
  //
  // Phase 6.5: a hold no longer performs ONE action and end. While the button
  // is down on a voxel that still has points in it, this runs an
  // `EXTRACTION_CYCLE_MS` timer over and over. Empty hand pulls one point;
  // Pickaxe pulls up to 100, for as long as you keep holding.
  //
  // The ring shows the voxel's OVERALL drain — `(extracted + this cycle's
  // partial) / total` — per user feedback ("the spinner while mining should be
  // relative to the total count, not a spinner for each mining"). For a
  // 1-point voxel that's identical to a per-cycle fill; for a many-thousand-
  // point voxel it advances slowly and honestly, which is the point: the ring
  // is a gauge of how much of THIS block is left, and the block's own fade
  // agrees with it.
  const holdTarget = pointerController.holdTarget;
  if (holdTarget) {
    const stillHovering =
      !!target && target.chunkId === holdTarget.chunkId && target.localVoxelId === holdTarget.localVoxelId;
    if (!stillHovering) {
      // Hover target changed out from under an armed hold (e.g. WASD flight
      // moved the world under an otherwise-still cursor, or the voxel just
      // emptied and the cursor now sees through it) — cancel without banking
      // any progress, per the plan's explicit requirement.
      pointerController.cancelHold();
    } else {
      const durationSeconds = EXTRACTION_CYCLE_MS / 1000;
      holdElapsedSeconds += dt;

      // Overall fraction incl. the in-progress cycle — see the comment above.
      // An untouched voxel has no extraction record yet, so its total comes
      // straight from the chunk's per-voxel counts.
      const cycleFraction = Math.min(1, holdElapsedSeconds / durationSeconds);
      const state = miningController?.extractionState(holdTarget.chunkId, holdTarget.localVoxelId);
      const extracted = state?.extracted.size ?? 0;
      const total = state?.total ?? chunkStore?.chunk(holdTarget.chunkId)?.meta.count[holdTarget.localVoxelId] ?? 1;
      const pendingBatch = miningController?.batchSizeFor(total, extracted) ?? 1;
      holdRing.setProgress(
        Math.min(1, (extracted + pendingBatch * cycleFraction) / Math.max(1, total)),
      );

      if (holdElapsedSeconds >= durationSeconds) {
        const cycle = miningController?.extract(hit) ?? null;
        if (cycle) {
          inventoryPanel?.focusMined(cycle.stackId, cycle.lastRowId);
          launchExtractionFlight(cycle, hitPosition);
        }
        holdElapsedSeconds = 0;
        if (cycle?.complete) {
          // Stop at the moment the voxel empties (or if extraction couldn't
          // run at all). The emptied voxel is pass-through from the next
          // raycast on, so the cursor is about to land on whatever is behind
          // it; consuming the hold (rather than letting it ride) means the
          // button still being down cannot start draining THAT voxel — a
          // fresh mousedown is required.
          pointerController.consumeHold();
          holdRing.hide();
        } else if (cycle) {
          holdRing.setProgress(cycle.fraction);
        }
      }
    }
  }

  // Refresh after extraction so the next image replaces the just-mined one
  // this frame. This never takes over the focused mining-page preparation.
  sharpBand?.update(engine.camera, effectorField?.currentRadius ?? 0,
    pointerOverWorld && !pointerController.isDragging ? target : null, xrayController?.isActive ?? false);

  // --- cursor position/state feedback -----------------------------------
  const showReticle = pointerOverWorld && !pointerController.isDragging && !!(target || proxyVoxel);
  if (showReticle) {
    const xPx = (pointerController.ndc.x * 0.5 + 0.5) * window.innerWidth;
    const yPx = (1 - (pointerController.ndc.y * 0.5 + 0.5)) * window.innerHeight;
    holdRing.setPosition(xPx, yPx);
  }
  const hoverState = target ? miningController?.extractionState(target.chunkId, target.localVoxelId) : null;
  const hoverTotal = target
    ? chunkStore?.chunk(target.chunkId)?.meta.count[target.localVoxelId] ?? 0
    : proxyVoxel?.count ?? 0;
  holdRing.setHover(showReticle ? hoverTotal - (hoverState?.extracted.size ?? 0) : null,
    hoverTotal, !!proxyVoxel);
  if (pointerController.isDragging) {
    setCursorStyle("grabbing");
  } else if (showReticle) {
    setCursorStyle("none");
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
    streamingState.proxyVoxelsShown = voxelProxy?.shownCount ?? 0;
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
    sharpPreviews: sharpBand?.pool.stats,
    status,
  });
});

/**
 * Resident container totals (Phase 6.8) — how many cages exist across the
 * streamed world right now, how many the Effector Field isn't hiding, and how
 * many the last frame actually drew after per-instance culling. Not on the
 * HUD; it exists for the headless verification harness and for console
 * spelunking, the same role `ChunkStore.stats()` plays.
 */
function containerStats(): { chunks: number; instances: number; visible: number; drawn: number } {
  let chunks = 0;
  let instances = 0;
  let visible = 0;
  let drawn = 0;
  if (chunkStore) {
    for (const chunkId of chunkStore.residentChunkIds) {
      const containers = chunkStore.chunk(chunkId)?.containers;
      if (!containers) continue;
      chunks++;
      instances += containers.instanceCount;
      visible += containers.visibleInstanceCount;
      drawn += containers.drawnInstanceCount;
    }
  }
  return { chunks, instances, visible, drawn };
}

// Handy for poking at the world from the devtools console (and for the
// headless verification harness, which reads counters off it).
Object.assign(window as unknown as Record<string, unknown>, {
  lsv: {
    rangeReader,
    engine,
    // Environment handles: `sky.regenerate(seed)` re-rolls the nebulae,
    // `sky.material.uniforms` / `sky.target` are there for tuning; `lights`
    // is the distance-independent rig (the headlamp is `engine.headlamp`).
    sky: engine.sky,
    lights: { hemi: hemiLight, sun: sunLight },
    containerStats,
    get manifest() {
      return manifest;
    },
    get chunkStore() {
      return chunkStore;
    },
    get voxelProxy() {
      return voxelProxy;
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
    get gameSession() { return gameSession; },
    get rangeStats() { return { cacheBytes: rangeReader.cache.weight, transferredBytes: rangeReader.transferred }; },
    // The inventory's lightbox: `currentRowId`, `status` (the rendered
    // status line), `state` (`LightboxOriginalState`), `originalSrc` (the
    // original on screen, or null) — what the harness reads to prove an
    // original was swapped in for the right row.
    get lightbox() {
      return inventoryPanel?.lightbox ?? null;
    },
    extractionFlights,
    get sharpBand() { return sharpBand; },
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

/** Complete ownership teardown for navigation, page caching, and Vite HMR.
 * Keeping this centralized also makes async startup abortable: a dataset
 * switch cannot finish constructing an old world behind the new page. */
function disposeApp(): void {
  if (appDisposed) return;
  appDisposed = true;
  window.removeEventListener("pagehide", disposeApp);
  appLifetime.abort();
  engine.stop();
  searchCompare.dispose(); searchNavigation?.dispose(); searchNavigation = null;
  leftDock.remove();
  if (effectorField) gameSession?.saveSettings(engine.camera.position.toArray(), engine.camera.quaternion.toArray(), effectorField.currentRadiusVoxels, true);
  gameSession?.dispose(); gameSession = null;

  pointerController.dispose();
  flightControls.dispose();
  minimap?.dispose();
  minimap = null;
  inventoryPanel?.dispose();
  inventoryPanel = null;
  effectorField?.dispose();
  effectorField = null;
  sharpBand?.dispose();
  sharpBand = null;
  extractionFlights.clear();
  hotbar.dispose();
  holdRing.dispose();
  hud.dispose();
  datasetPicker.dispose();

  chunkStore?.dispose();
  chunkStore = null;
  voxelProxy?.dispose();
  rangeReader.dispose();
  voxelProxy = null;
  if (syntheticVoxelField) {
    syntheticVoxelField.removeFromParent();
    syntheticVoxelField.dispose();
    syntheticVoxelField.geometry.dispose();
    const materials = Array.isArray(syntheticVoxelField.material)
      ? syntheticVoxelField.material
      : [syntheticVoxelField.material];
    for (const material of materials) material.dispose();
    syntheticVoxelField = null;
  }

  highlightBox.removeFromParent();
  highlightGeometry.dispose();
  highlightMaterial.dispose();
  hemiLight.removeFromParent();
  sunLight.removeFromParent();
  raycastTargets = null;
  miningController = null;
  xrayController = null;
  engine.dispose();
  delete (window as unknown as Record<string, unknown>).lsv;
}

window.addEventListener("pagehide", disposeApp, { once: true });
import.meta.hot?.dispose(disposeApp);
