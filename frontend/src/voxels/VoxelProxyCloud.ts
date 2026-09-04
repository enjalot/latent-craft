import * as THREE from "three";
import { InstancedMesh2 } from "@three.ez/instanced-mesh";
import type { Manifest } from "../streaming/Manifest.ts";
import type { VoxelProxyData } from "../types.ts";
import {
  MINIMAP_FLASHLIGHT_COLOR_3D,
  VOXEL_FILL,
  VOXEL_PROXY_BRIGHTNESS,
  VOXEL_PROXY_LIT_BRIGHTNESS,
  VOXEL_PROXY_LIT_TINT,
  VOXEL_PROXY_SATURATION,
} from "../config.ts";

/** What a raycast hit on the proxy mesh resolves to. Deliberately NOT a
 * `VoxelTarget` (`interaction/PointerController.ts`): a proxy has no point
 * ids, so nothing that arms a hold may ever see one of these. */
export interface ProxyVoxel {
  chunkId: number;
  localVoxelId: number;
  /** Points in the voxel, from `voxel_proxy.bin` (== `meta.bin`'s count). */
  count: number;
}

export interface VoxelProxyStats {
  cachedInstances?: number;
  cachedBricks?: number;
  pendingBricks?: number;
  /** Occupied voxels in the dataset == instances in the mesh. */
  voxels: number;
  /** Instances currently drawn as proxies, i.e. in non-resident chunks. */
  shown: number;
  /** Instances hidden because their chunk is resident and textured. */
  hidden: number;
  /** Chunks whose run is hidden — should equal `ChunkStore.stats().resident`. */
  hiddenChunks: number;
  /** Instances currently flashlit (whether or not shown). */
  lit: number;
  /** Instances the last frame drew after per-instance frustum culling. */
  drawn: number;
}

/** Rec. 709 luma of a linear-light colour — the grey a colour desaturates toward. */
function luminance(color: THREE.Color): number {
  return 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b;
}

/**
 * The far-LOD layer (Phase 8): every occupied voxel of the dataset as a flat
 * cube of its mean thumbnail colour, in ONE `InstancedMesh2` (14.7K instances
 * on bl-160, ~24-29K on the MONET 160^3 arms — one draw call, one BVH), hidden
 * per chunk while that chunk's textured mesh is resident and shown again when
 * it evicts. It renders before a single chunk has streamed, so the world is
 * never blank, and it is what you see of everything outside the textured ring
 * (`RING_R0_CHUNKS` and friends): the map's colour structure as a fogged
 * silhouette, with thumbnails only near the camera.
 *
 * ## Same place, same size as the thumbnail it stands in for
 *
 * Instance positions come from `Manifest.voxelCenterWorldById` and the edge is
 * `voxelWorldSize * VOXEL_FILL` — the exact transform `ChunkLoader` gives the
 * textured cube — so when a chunk's run swaps for its mesh (or back) nothing
 * moves; only the surface changes. That is also what lets the hover box land
 * on a proxy and stay put across the swap. No container cage: the cage says
 * "this block has been fetched and counted", and it is the most legible
 * difference between the two layers at a glance.
 *
 * ## One run per chunk
 *
 * `voxel_proxy.bin` is sorted by `(chunk_id, local_voxel_id)`, so a chunk's
 * records are one contiguous index range (`data.runStart/runEnd`) and record i
 * of the run is instance i of that chunk's textured mesh. `setChunkResident`
 * is therefore a loop over one range with `setVisibilityAt`, which — per the
 * Phase 3 finding `MiningController` documents — makes an instance BOTH
 * invisible AND un-raycastable in one call: a hidden proxy can never be hit
 * through the textured cube occupying the same space.
 *
 * ## Lit by the same rig
 *
 * A stock `MeshStandardMaterial` with per-instance colour, so the hemisphere
 * fill, the sun, the camera-carried headlamp and the fog (whose curve
 * `engine/Fog.ts` installs before any material compiles) all apply exactly as
 * they do to the textured cubes; nothing about distance is tuned twice. The
 * "unloaded" look is in the colour alone — see `VOXEL_PROXY_SATURATION` /
 * `VOXEL_PROXY_BRIGHTNESS`.
 *
 * ## Flashlight
 *
 * `setLit` swaps an instance's colour for a brighter, amber-tinted one and
 * `clearLit` restores the base colour, from a shadow copy kept here —
 * `colorsTexture` is the only per-instance colour storage the mesh has, and
 * the base colour is not recoverable from a lit one. Lighting is independent
 * of residency on purpose: a voxel lit while its chunk is textured (hidden
 * proxy) shows up lit if that chunk evicts while the flashlight is still on,
 * and there is no residency bookkeeping to reconcile.
 */
export class VoxelProxyCloud {
  readonly mesh: InstancedMesh2;
  readonly data: VoxelProxyData;

  /** Linear-light base colour per instance (3 floats each), after the
   * unloaded-look adjustment — what `clearLit` restores. */
  private readonly baseColors: Float32Array;
  private readonly hiddenChunks = new Set<number>();
  private hiddenInstances = 0;
  private readonly lit = new Set<number>();

  private readonly geometry: THREE.BoxGeometry;
  private readonly material: THREE.MeshStandardMaterial;
  private readonly litTint = new THREE.Color().setHex(MINIMAP_FLASHLIGHT_COLOR_3D, THREE.SRGBColorSpace);
  private readonly colorScratch = new THREE.Color();

  constructor(manifest: Manifest, data: VoxelProxyData, renderer: THREE.WebGLRenderer) {
    this.data = data;
    const n = data.chunkId.length;

    this.geometry = new THREE.BoxGeometry(1, 1, 1);
    // Fully matte: a proxy is a colour swatch, not a surface, and the textured
    // cubes' 0.9 roughness already reads as paper — the last step flatter is
    // one more cue that this block is a stand-in.
    this.material = new THREE.MeshStandardMaterial({ roughness: 1.0, metalness: 0.0 });

    this.mesh = new InstancedMesh2(this.geometry, this.material, {
      capacity: Math.max(1, n),
      renderer,
    });
    this.mesh.name = "voxel-proxies";

    this.baseColors = new Float32Array(n * 3);
    const edge = manifest.voxelWorldSize * VOXEL_FILL;
    const center = new THREE.Vector3();
    const color = this.colorScratch;
    const grey = new THREE.Color();

    this.mesh.addInstances(n, (instance, index) => {
      manifest.voxelCenterWorldById(data.chunkId[index], data.localVoxelId[index], center);
      instance.position.copy(center);
      instance.scale.setScalar(edge);

      // voxel_proxy.bin stores display-referred sRGB bytes; three's working
      // space is linear, so convert rather than assigning the raw bytes.
      color.setRGB(
        data.colorRgb[index * 3] / 255,
        data.colorRgb[index * 3 + 1] / 255,
        data.colorRgb[index * 3 + 2] / 255,
        THREE.SRGBColorSpace,
      );
      const l = luminance(color);
      grey.setRGB(l, l, l);
      color.lerp(grey, 1 - VOXEL_PROXY_SATURATION).multiplyScalar(VOXEL_PROXY_BRIGHTNESS);
      color.toArray(this.baseColors, index * 3);
      instance.color = color;
    });

    // Instances never move for the life of the dataset, so one BVH build is the
    // intended usage — it is what keeps raycasting and per-instance frustum
    // culling over the whole dataset cheap every frame.
    this.mesh.computeBVH();
  }

  get instanceCount(): number {
    return this.mesh.instancesCount;
  }

  /** Proxies currently drawn, i.e. voxels whose chunk is not resident. */
  get shownCount(): number {
    return this.mesh.instancesCount - this.hiddenInstances;
  }

  /** Hides a chunk's run when its textured mesh becomes resident and reveals
   * it again when that mesh is evicted. Idempotent per chunk, so a repeated
   * residency event costs one Set lookup. */
  setChunkResident(chunkId: number, resident: boolean): void {
    const start = this.data.runStart[chunkId];
    if (start === undefined || start < 0) return;
    if (resident === this.hiddenChunks.has(chunkId)) return;
    const end = this.data.runEnd[chunkId];
    for (let i = start; i < end; i++) this.mesh.setVisibilityAt(i, !resident);
    if (resident) {
      this.hiddenChunks.add(chunkId);
      this.hiddenInstances += end - start;
    } else {
      this.hiddenChunks.delete(chunkId);
      this.hiddenInstances -= end - start;
    }
  }

  /** Whether `chunkId`'s run is currently hidden (its chunk is resident). */
  isChunkHidden(chunkId: number): boolean {
    return this.hiddenChunks.has(chunkId);
  }

  /** Resolves a raycast hit's instance id back to the voxel it stands for. */
  voxelAt(instanceId: number): ProxyVoxel {
    return {
      chunkId: this.data.chunkId[instanceId],
      localVoxelId: this.data.localVoxelId[instanceId],
      count: this.data.count[instanceId],
    };
  }

  /**
   * Instance id of `(chunkId, localVoxelId)`, or -1 if the dataset has no
   * such occupied voxel. A binary search within the chunk's run —
   * `localVoxelId` is ascending inside every run by the file's contract, so
   * this is exact, and it is what the minimap flashlight calls once per lit
   * voxel.
   */
  instanceIdOf(chunkId: number, localVoxelId: number): number {
    const start = this.data.runStart[chunkId];
    if (start === undefined || start < 0) return -1;
    const ids = this.data.localVoxelId;
    let lo = start;
    let hi = this.data.runEnd[chunkId] - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const value = ids[mid];
      if (value === localVoxelId) return mid;
      if (value < localVoxelId) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }

  /**
   * Replaces the set of flashlit instances: whatever was lit and is not in
   * `instanceIds` goes back to its base colour, whatever is new gets the lit
   * colour. Instances already lit are left alone, so a flashlight resting on
   * the same voxels costs nothing per frame.
   */
  setLit(instanceIds: Iterable<number>): void {
    const next = new Set(instanceIds);
    for (const id of this.lit) {
      if (!next.has(id)) this.applyBaseColor(id);
    }
    for (const id of next) {
      if (!this.lit.has(id)) this.applyLitColor(id);
    }
    this.lit.clear();
    for (const id of next) this.lit.add(id);
  }

  /** Restores every flashlit instance to its base colour. */
  clearLit(): void {
    for (const id of this.lit) this.applyBaseColor(id);
    this.lit.clear();
  }

  /** Counters for the HUD, the console and the headless verification harness
   * — the same role `ChunkStore.stats()` plays for the textured layer. */
  stats(): VoxelProxyStats {
    return {
      voxels: this.mesh.instancesCount,
      shown: this.shownCount,
      hidden: this.hiddenInstances,
      hiddenChunks: this.hiddenChunks.size,
      lit: this.lit.size,
      drawn: this.mesh.count,
    };
  }

  private applyBaseColor(instanceId: number): void {
    this.colorScratch.fromArray(this.baseColors, instanceId * 3);
    this.mesh.setColorAt(instanceId, this.colorScratch);
  }

  private applyLitColor(instanceId: number): void {
    this.colorScratch
      .fromArray(this.baseColors, instanceId * 3)
      .lerp(this.litTint, VOXEL_PROXY_LIT_TINT)
      .multiplyScalar(VOXEL_PROXY_LIT_BRIGHTNESS);
    this.mesh.setColorAt(instanceId, this.colorScratch);
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.dispose();
    this.geometry.dispose();
    this.material.dispose();
  }
}
