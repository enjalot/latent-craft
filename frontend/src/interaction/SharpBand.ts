import * as THREE from "three";
import type { ChunkStore } from "../streaming/ChunkStore.ts";
import type { Manifest } from "../streaming/Manifest.ts";
import type { LoadedChunk } from "../streaming/ChunkLoader.ts";
import { resolveThumbUrl, type PointIndex } from "../streaming/PointIndex.ts";
import type { MiningController } from "./MiningController.ts";
import { PreviewPool, PREVIEW_SLOTS, type PreviewTarget } from "../voxels/PreviewPool.ts";
import { combinedVoxelOpacity } from "../voxels/VoxelOpacity.ts";
import { OpaqueHover } from "../voxels/OpaqueHover.ts";

type Voxel = { chunkId: number; localVoxelId: number; instanceId: number; owner: LoadedChunk };

export function isSharpBandCell(distanceSquared: number, radius: number, voxelSize: number): boolean {
  return distanceSquared > radius ** 2 && distanceSquared <= (radius + voxelSize) ** 2;
}

/** One-voxel shell just outside the suppressed sphere. Refresh its candidate
 * scan at 10Hz, while validating residency/suppression/mining state every frame.
 * Hover is always first, including outside the shell. No global point scan. */
export class SharpBand {
  readonly pool: PreviewPool;
  readonly opaqueHover: OpaqueHover;
  private candidates: Voxel[] = [];
  private lastScan = -Infinity;
  private lastRadius = -1;
  private center = new THREE.Vector3();
  private forward = new THREE.Vector3();
  private scratch = new THREE.Vector3();
  private matrix = new THREE.Matrix4();
  private covered: Voxel[] = [];

  constructor(scene: THREE.Scene, renderer: THREE.WebGLRenderer,
    private readonly store: ChunkStore, private readonly manifest: Manifest,
    private readonly mining: MiningController, private readonly getIndex: () => Promise<PointIndex>) {
    this.pool = new PreviewPool(scene, renderer);
    this.opaqueHover = new OpaqueHover(scene);
  }

  update(camera: THREE.Camera, radius: number, hover: { chunkId: number; localVoxelId: number } | null, xray: boolean): void {
    // Restore only opacity, never visibility: the latter also controls picking
    // and is owned by the effector. Restore old owners only while still resident.
    for (const c of this.covered) if (this.store.chunk(c.chunkId) === c.owner)
      c.owner.mesh.setOpacityAt(c.instanceId, combinedVoxelOpacity(this.mining.extractedFraction(c.chunkId, c.localVoxelId), xray));
    this.covered = [];
    this.opaqueHover.mesh.visible = false;
    this.center.copy(camera.position); camera.getWorldDirection(this.forward);
    const now = performance.now(), size = this.manifest.voxelWorldSize;
    if (now - this.lastScan >= 100 || radius !== this.lastRadius) {
      this.lastScan = now; this.lastRadius = radius;
      const candidates: (Voxel & { priority: number })[] = [];
      const reach = radius + size + this.manifest.chunkWorldSize * Math.sqrt(3) / 2;
      for (const chunkId of this.store.residentChunkIds) {
        const owner = this.store.chunk(chunkId); if (!owner || !owner.mesh.visible) continue;
        this.manifest.chunkCenterWorld(chunkId, this.scratch);
        if (this.scratch.distanceToSquared(this.center) > reach * reach) continue;
        for (let instanceId = 0; instanceId < owner.meta.occupied.length; instanceId++) {
          const localVoxelId = owner.meta.occupied[instanceId];
          this.manifest.voxelCenterWorld(owner.entry.cx, owner.entry.cy, owner.entry.cz, localVoxelId, this.scratch);
          const d2 = this.scratch.distanceToSquared(this.center);
          if (!isSharpBandCell(d2, radius, size) || this.mining.isFullyExtracted(chunkId, localVoxelId)) continue;
          const facing = this.scratch.sub(this.center).normalize().dot(this.forward);
          candidates.push({ chunkId, localVoxelId, instanceId, owner, priority: Math.sqrt(d2) * (1 - .5 * facing) });
        }
      }
      candidates.sort((a,b) => a.priority - b.priority);
      this.candidates = candidates.slice(0, PREVIEW_SLOTS);
    }
    const voxels = [...this.candidates];
    if (hover) {
      const owner = this.store.chunk(hover.chunkId);
      if (owner) {
        const instanceId = owner.meta.occupied.indexOf(hover.localVoxelId);
        if (instanceId >= 0) voxels.unshift({ ...hover, instanceId, owner });
      }
    }
    const targets: PreviewTarget[] = [];
    const owners = new Map<string, Voxel>();
    for (const v of voxels) {
      if (targets.length >= PREVIEW_SLOTS || !v.owner.mesh.visible || this.store.chunk(v.chunkId) !== v.owner ||
        this.mining.isFullyExtracted(v.chunkId, v.localVoxelId)) continue;
      this.manifest.voxelCenterWorld(v.owner.entry.cx, v.owner.entry.cy, v.owner.entry.cz, v.localVoxelId, this.scratch);
      const d2 = this.scratch.distanceToSquared(this.center);
      const focused = hover?.chunkId === v.chunkId && hover.localVoxelId === v.localVoxelId;
      if (d2 <= radius ** 2 || (!focused && !isSharpBandCell(d2, radius, size))) continue;
      const state = this.mining.extractionState(v.chunkId, v.localVoxelId);
      const key = `${v.chunkId}:${v.localVoxelId}:${state?.cursor ?? 0}:${state?.returned.values().next().value ?? ""}`;
      if (owners.has(key)) continue;
      owners.set(key, v);
      v.owner.mesh.getMatrixAt(v.instanceId, this.matrix);
      // The source's coverage is zero while replaced, so no enlarged overlay
      // or depth bias is needed. Preserve exact clearance from border cages.
      const matrix = this.matrix.clone();
      targets.push({ key, matrix, focused, opacity: combinedVoxelOpacity(this.mining.extractedFraction(v.chunkId, v.localVoxelId), xray),
        valid: () => this.store.chunk(v.chunkId) === v.owner && !this.mining.isFullyExtracted(v.chunkId, v.localVoxelId),
        resolve: async () => {
          const row = await this.mining.previewRowId(v.chunkId, v.localVoxelId);
          if (row === null) return null;
          const index = await this.getIndex(); await index.ensure?.(row);
          return resolveThumbUrl(index, row);
        } });
    }
    this.pool.update(targets, xray, camera);
    if (xray) {
      const focused = targets.find(t => t.focused);
      if (focused && !this.pool.visibleKeys.has(focused.key)) {
        const v = owners.get(focused.key)!;
        const material = (Array.isArray(v.owner.mesh.material) ? v.owner.mesh.material[0] : v.owner.mesh.material) as THREE.MeshStandardMaterial;
        if (material.map) {
          this.opaqueHover.show(focused.matrix, material.map,
            this.manifest.compactAtlases ? v.instanceId : v.localVoxelId,
            v.owner.entry.atlas_tiles_per_side ?? this.manifest.tilesPerSide, this.manifest.tilePx);
          v.owner.mesh.setOpacityAt(v.instanceId, 0); this.covered.push(v);
        }
      }
    }
    for (const key of this.pool.visibleKeys) {
      const v = owners.get(key);
      if (v) { v.owner.mesh.setOpacityAt(v.instanceId, 0); this.covered.push(v); }
    }
  }

  dispose(): void {
    for (const v of this.covered) if (this.store.chunk(v.chunkId) === v.owner)
      v.owner.mesh.setOpacityAt(v.instanceId, combinedVoxelOpacity(this.mining.extractedFraction(v.chunkId, v.localVoxelId), false));
    this.covered = []; this.pool.dispose(); this.opaqueHover.dispose();
  }
}
