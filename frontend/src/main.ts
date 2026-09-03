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
import { Hud, type HudStreamingState } from "./ui/Hud.ts";
import { createCrosshair } from "./ui/hud/Crosshair.ts";
import { InventoryPanel } from "./ui/InventoryPanel.ts";
import {
  DATASETS,
  DEFAULT_DATASET,
  WORLD_HALF_EXTENT,
  WORLD_SCALE,
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

const flightControls = new FlightControls(engine.camera, engine.renderer.domElement);
const raycaster = new VoxelRaycaster(engine.camera);

// Hover highlight: a separate wireframe box repositioned to match the
// hovered instance's transform each frame.
const highlightGeometry = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
const highlightMaterial = new THREE.LineBasicMaterial({ color: 0x7fffe0, transparent: true, opacity: 0.9 });
const highlightBox = new THREE.LineSegments(highlightGeometry, highlightMaterial);
highlightBox.visible = false;
engine.scene.add(highlightBox);

const hud = new Hud(app);
createCrosshair(app);

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
        // Re-hide anything mined in this chunk before it was evicted — see
        // MiningController.onChunkResident's doc comment for why this can't
        // live on the mesh itself.
        if (resident) miningController?.onChunkResident(chunkId);
      },
    });
    engine.scene.add(chunkStore.group);
    raycastTarget = chunkStore.group;
    raycastRecursive = true;

    // Constructed synchronously right after chunkStore, with no `await` in
    // between, so the `onResidencyChanged` closure above (which only ever
    // runs from a later microtask, once a chunk load resolves) never sees
    // `miningController` still null.
    miningController = new MiningController(chunkStore);
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
  engine.camera.lookAt(center);
  // PointerLockControls drives yaw/pitch off the camera's own quaternion, so
  // a plain lookAt here is picked up cleanly the moment the pointer locks.
}

// --- mining -------------------------------------------------------------

/** The raycast hit as of the most recent frame — read by the click listener
 * below rather than re-raycasting on click, since the crosshair already
 * raycasts every frame from the same screen center. */
let currentHit: VoxelHit | null = null;

// A click both (a) requests pointer lock, via FlightControls' own listener
// on the same element, and (b) — this listener — mines whatever's under the
// crosshair. `isLocked` is what keeps those from colliding: the very first
// click on a fresh page has `isLocked === false` right up until the browser
// grants the lock (an async step), so that click only locks and never mines;
// every click after that is a real mine attempt.
engine.renderer.domElement.addEventListener("click", () => {
  if (!flightControls.isLocked) return;
  miningController?.mine(currentHit);
});

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

engine.start((dt) => {
  flightControls.update(dt);
  chunkStore?.updateCamera(engine.camera);

  let hoverLabel = "none";
  const hit = raycastTarget ? raycaster.raycast(raycastTarget, raycastRecursive) : null;
  currentHit = hit;
  if (hit) {
    hit.mesh.getMatrixAt(hit.instanceId, hitMatrix);
    hitMatrix.decompose(hitPosition, hitQuaternion, hitScale);
    highlightBox.position.copy(hitPosition);
    highlightBox.quaternion.copy(hitQuaternion);
    highlightBox.scale.copy(hitScale).multiplyScalar(1.06);
    highlightBox.visible = true;

    const userData = hit.mesh.userData as Partial<ChunkMeshUserData>;
    if (userData.instanceToLocalVoxelId && userData.chunkId !== undefined) {
      const localVoxelId = userData.instanceToLocalVoxelId[hit.instanceId];
      const chunk = chunkStore?.chunk(userData.chunkId);
      const points = chunk ? chunk.meta.count[localVoxelId] : 0;
      const reprRowId = chunk ? chunk.meta.reprRowId[localVoxelId] : -1;
      const mineHint = miningController && flightControls.isLocked ? " · click to mine" : "";
      hoverLabel =
        `chunk ${userData.chunkId} voxel ${localVoxelId} · ${points} pts · row ${reprRowId} · ` +
        `${hitPosition.x.toFixed(1)}, ${hitPosition.y.toFixed(1)}, ${hitPosition.z.toFixed(1)}${mineHint}`;
    } else {
      hoverLabel = `instance #${hit.instanceId}`;
    }
  } else {
    highlightBox.visible = false;
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
    locked: flightControls.isLocked,
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
    get currentHit() {
      return currentHit;
    },
    raycaster,
    flightControls,
    get status() {
      return status;
    },
  },
});
