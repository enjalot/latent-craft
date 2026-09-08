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

/** One-voxel shell just outside the suppressed sphere. Refresh changed candidates
 * at at most 10Hz, while validating residency/suppression/mining state every frame.
 * Hover is always first, including outside the shell. No global point scan. */
export class SharpBand {
  readonly pool: PreviewPool;
  readonly opaqueHover: OpaqueHover;
  private candidates: Voxel[] = [];
  private lastScan = -Infinity;
  private lastRadius = -1;
  private dirty = true;
  private lastCenter = new THREE.Vector3();
  private lastForward = new THREE.Vector3();
  private lastInventory: unknown;
  private lastFilterRevision: number | undefined;
  private scannedOwners = new Map<number, { owner: LoadedChunk; visible: boolean }>();
  private scans = 0;
  private center = new THREE.Vector3();
  private forward = new THREE.Vector3();
  private scratch = new THREE.Vector3();
  private matrix = new THREE.Matrix4();
  private covered: Voxel[] = [];
  private searchFocus: { chunkId: number; localVoxelId: number; rowId: number } | null = null;

  /** Count filters may reveal candidates while the camera is stationary. */
  invalidate(): void { this.dirty = true; }
  get candidateScans(): number { return this.scans; }

  setSearchFocus(focus: { chunkId: number; localVoxelId: number; rowId: number } | null): void {
    this.searchFocus = focus;
  }

  constructor(scene: THREE.Scene, renderer: THREE.WebGLRenderer,
    private readonly store: ChunkStore, private readonly manifest: Manifest,
    private readonly mining: MiningController, private readonly getIndex: () => Promise<PointIndex>) {
    this.pool = new PreviewPool(scene, renderer);
    this.opaqueHover = new OpaqueHover(scene);
  }

  update(camera: THREE.Camera, radius: number, hover: { chunkId: number; localVoxelId: number } | null, xray: boolean): void {
    hover = this.searchFocus ?? hover;
    const previouslyCovered = this.covered;
    this.covered = [];
    this.opaqueHover.mesh.visible = false;
    this.center.copy(camera.position); camera.getWorldDirection(this.forward);
    const now = performance.now(), size = this.manifest.voxelWorldSize;
    if (!xray && (now - this.lastScan >= 100 || radius !== this.lastRadius)) {
      this.lastScan = now;
      const ids = [...this.store.residentChunkIds];
      const changed = this.dirty || radius !== this.lastRadius ||
        this.center.distanceToSquared(this.lastCenter) > (size * .01) ** 2 ||
        this.forward.distanceToSquared(this.lastForward) > 1e-6 ||
        this.lastInventory !== this.mining.inventory?.stacks || this.lastFilterRevision !== this.mining.filterRevision ||
        ids.length !== this.scannedOwners.size || ids.some(id => {
          const previous = this.scannedOwners.get(id), owner = this.store.chunk(id);
          return !previous || previous.owner !== owner || previous.visible !== owner?.mesh.visible;
        });
      if (changed) {
        this.dirty = false; this.scans++;
        this.lastRadius = radius; this.lastCenter.copy(this.center); this.lastForward.copy(this.forward);
        this.lastInventory = this.mining.inventory?.stacks; this.lastFilterRevision = this.mining.filterRevision;
        this.scannedOwners.clear();
        for (const id of ids) {
          const owner = this.store.chunk(id);
          if (owner) this.scannedOwners.set(id, { owner, visible: owner.mesh.visible });
        }
        const candidates: (Voxel & { priority: number })[] = [];
        const reach = radius + size + this.manifest.chunkWorldSize * Math.sqrt(3) / 2;
        for (const chunkId of this.store.residentChunkIds) {
          const owner = this.store.chunk(chunkId); if (!owner || !owner.mesh.visible) continue;
          this.manifest.chunkCenterWorld(chunkId, this.scratch);
          if (this.scratch.distanceToSquared(this.center) > reach * reach) continue;
          for (let instanceId = 0; instanceId < owner.meta.occupied.length; instanceId++) {
            if (!owner.mesh.getVisibilityAt(instanceId)) continue;
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
    }
    // X-ray is a count heatmap; only the focused voxel may show an image.
    const voxels = xray ? [] : [...this.candidates];
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
      if (targets.length >= PREVIEW_SLOTS || !v.owner.mesh.visible || !v.owner.mesh.getVisibilityAt(v.instanceId) || this.store.chunk(v.chunkId) !== v.owner ||
        this.mining.isFullyExtracted(v.chunkId, v.localVoxelId)) continue;
      this.manifest.voxelCenterWorld(v.owner.entry.cx, v.owner.entry.cy, v.owner.entry.cz, v.localVoxelId, this.scratch);
      const d2 = this.scratch.distanceToSquared(this.center);
      const focused = hover?.chunkId === v.chunkId && hover.localVoxelId === v.localVoxelId;
      if (d2 <= radius ** 2 || (!focused && !isSharpBandCell(d2, radius, size))) continue;
      const state = this.mining.extractionState(v.chunkId, v.localVoxelId);
      const searchRow = focused && this.searchFocus ? this.searchFocus.rowId : null;
      const revision = this.mining.filterRevision;
      const key = `${revision}:${v.chunkId}:${v.localVoxelId}:${state?.cursor ?? 0}:${state?.extracted.size ?? 0}:${state?.returned.values().next().value ?? ""}:search:${searchRow ?? ""}`;
      if (owners.has(key)) continue;
      owners.set(key, v);
      v.owner.mesh.getMatrixAt(v.instanceId, this.matrix);
      // The source's coverage is zero while replaced, so no enlarged overlay
      // or depth bias is needed. Preserve exact clearance from border cages.
      const matrix = this.matrix.clone();
      targets.push({ key, matrix, focused, opacity: combinedVoxelOpacity(this.mining.extractedFraction(v.chunkId, v.localVoxelId), xray),
        valid: () => revision === this.mining.filterRevision && this.store.chunk(v.chunkId) === v.owner && v.owner.mesh.getVisibilityAt(v.instanceId) && !this.mining.isFullyExtracted(v.chunkId, v.localVoxelId),
        resolve: async () => {
          const row = searchRow ?? await this.mining.previewRowId(v.chunkId, v.localVoxelId);
          if (row === null || !this.mining.matchesRow(row)) return null;
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
        if (material.map && this.mining.matchesRow(v.owner.meta.reprRowId[v.localVoxelId])) {
          this.opaqueHover.show(focused.matrix, material.map,
            this.manifest.compactAtlases ? v.instanceId : v.localVoxelId,
            v.owner.entry.atlas_tiles_per_side ?? this.manifest.tilesPerSide, this.manifest.tilePx);
          this.covered.push(v);
        }
      }
    }
    for (const key of this.pool.visibleKeys) {
      const v = owners.get(key);
      if (v) this.covered.push(v);
    }
    // Only touch opacity when coverage actually changes. Restoring and hiding
    // every source each frame enqueues two GPU texture writes even at rest.
    const coveredOwners = new Map<LoadedChunk, Set<number>>();
    for (const v of this.covered) {
      let instances = coveredOwners.get(v.owner);
      if (!instances) coveredOwners.set(v.owner, instances = new Set());
      instances.add(v.instanceId);
      // Mining/X-ray may have changed the source independently this frame.
      if (v.owner.mesh.getOpacityAt(v.instanceId) !== 0) v.owner.mesh.setOpacityAt(v.instanceId, 0);
    }
    for (const v of previouslyCovered) {
      if (this.store.chunk(v.chunkId) === v.owner && !coveredOwners.get(v.owner)?.has(v.instanceId))
        v.owner.mesh.setOpacityAt(v.instanceId, combinedVoxelOpacity(this.mining.extractedFraction(v.chunkId, v.localVoxelId), xray));
    }
  }

  dispose(): void {
    for (const v of this.covered) if (this.store.chunk(v.chunkId) === v.owner)
      v.owner.mesh.setOpacityAt(v.instanceId, combinedVoxelOpacity(this.mining.extractedFraction(v.chunkId, v.localVoxelId), false));
    this.covered = []; this.pool.dispose(); this.opaqueHover.dispose();
  }
}
