import * as THREE from "three";
import { runtimeProfile } from "../runtime/DeviceProfile.ts";
import { InstancedMesh2 } from "@three.ez/instanced-mesh";
import { fetchJson } from "../net/fetchTyped.ts";
import { rangeReader } from "../streaming/RangeReader.ts";
import type { Manifest } from "../streaming/Manifest.ts";
import type { ProxyVoxel, VoxelProxyStats } from "./VoxelProxyCloud.ts";
import { VOXEL_FILL, XRAY_OPACITY } from "../config.ts";
import { densityLevel, installDensityView, setDensityRendering } from "./DensityView.ts";
import { selectProxyCut, proxyBrickLod, allocateProxyBricks } from "./ProxyCut.ts";
import { proxyCellMaxCounts } from "./VoxelCountFilter.ts";
import type { MatchSnapshot } from "../metadata/MetadataClient.ts";

const CUT_CAPACITY = 1024;

interface Level { offset: number; count: number; step: number }
interface Leaf { chunk: number; xyz: number[]; count: number; levels: Level[] }
interface Node { origin: number[]; span: number; count: number; leaf?: number; children: number[] }
interface Hierarchy { version: number; file: string; bytes: number; nodes: Leaf[]; tree: Node[] }
interface Brick { mesh: InstancedMesh2; ids: ProxyVoxel[]; colors: THREE.Color[]; lastUsed: number;
  leaf: Leaf; level: Level; origins: Uint16Array; source?: DataView; filterCounts?: Uint32Array;
  matches?: { total: number; max: number; local: number }[] }

/** Distance-prioritized octree cut + range-loaded 4/2/1 voxel bricks. Resident fine
 * geometry never scales with corpus size. A missing brick keeps its parent visible. */
export class HierarchicalProxies {
  readonly mesh = new THREE.Group();
  private readonly resident = new Set<number>();
  private readonly bricks = new Map<string, Brick>();
  private readonly pending = new Set<string>();
  private readonly failures = new Map<string, number>();
  private readonly protectedBases = new Set<string>();
  private lastLods = new Map<number, number>();
  private readonly coarse: InstancedMesh2;
  private readonly material = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0, emissive: 0x18242a, emissiveIntensity: .3 });
  // Missing-detail regions are a faint spatial hint, not solid obstacles.
  private readonly coarseMaterial = new THREE.MeshBasicMaterial({
    transparent: true, opacity: 0.22, depthWrite: false,
  });
  private readonly coarseIds: ProxyVoxel[] = [];
  private readonly handles = new Map<number, { brick: Brick; instance: number }>();
  private lit = new Set<number>();
  private lastUpdate = -Infinity;
  private dirty = true;
  private disposed = false;
  private tick = 0;
  private shown = 0;
  private readonly lastPosition = new THREE.Vector3(Infinity, 0, 0);
  private lastHeight = -1;
  private lastFov = -1;
  private countFilter = 0;
  private retryAt = Infinity;
  private xrayActive = false;
  private metadataFilter: MatchSnapshot | null = null;
  private nodeCounts = new Map<Node, number>();

  setMetadataFilter(filter: MatchSnapshot | null): void {
    this.metadataFilter = filter; this.nodeCounts.clear();
    if (filter) for (let i = this.hierarchy.tree.length - 1; i >= 0; i--) {
      const node = this.hierarchy.tree[i];
      this.nodeCounts.set(node, node.leaf !== undefined ? filter.chunkTotals.get(this.hierarchy.nodes[node.leaf].chunk) ?? 0 :
        node.children.reduce((sum, child) => sum + (this.nodeCounts.get(this.hierarchy.tree[child]) ?? 0), 0));
    }
    for (const brick of this.bricks.values()) this.applyMetadata(brick);
    this.dirty = true;
  }
  private applyMetadata(brick: Brick): void {
    brick.matches = this.metadataFilter ? [...brick.origins].map(origin => this.metadataFilter!.cell(brick.leaf.chunk, origin, brick.level.step, this.manifest.voxelsPerChunk)) : undefined;
    for (let i = 0; i < brick.ids.length; i++) brick.mesh.setUniformAt(i, "densityLevel",
      densityLevel(brick.matches?.[i].max ?? brick.filterCounts?.[i] ?? brick.ids[i].count / brick.level.step ** 3));
  }

  setXrayActive(active: boolean): void {
    this.xrayActive = active;
    for (const brick of this.bricks.values()) setDensityRendering(brick.mesh, active);
    this.material.opacity = active ? XRAY_OPACITY : 1;
    this.dirty = true;
  }

  setCountFilter(threshold: number): void {
    if (threshold === this.countFilter) return;
    this.countFilter = threshold; this.dirty = true;
  }

  private constructor(private readonly manifest: Manifest, private readonly hierarchy: Hierarchy,
    private readonly renderer: THREE.WebGLRenderer) {
    installDensityView(this.material);
    this.coarse = new InstancedMesh2(new THREE.BoxGeometry(1, 1, 1), this.coarseMaterial, { capacity: CUT_CAPACITY, renderer });
    this.coarse.addInstances(CUT_CAPACITY);
    for (let i = 0; i < CUT_CAPACITY; i++) this.coarse.setVisibilityAt(i, false);
    this.mesh.add(this.coarse);
  }

  static async load(manifest: Manifest, renderer: THREE.WebGLRenderer, signal?: AbortSignal) {
    const hierarchy = await fetchJson<Hierarchy>(manifest.url(manifest.raw.streaming!.hierarchy), signal);
    if (hierarchy.version !== 1 || hierarchy.tree.length > 1000000) throw new Error("Invalid proxy hierarchy");
    const parented = new Set<number>();
    for (let i = 0; i < hierarchy.tree.length; i++) {
      const node = hierarchy.tree[i];
      if (node.children.some(child => child <= i || child >= hierarchy.tree.length || parented.has(child)))
        throw new Error("Proxy hierarchy must be an acyclic tree");
      for (const child of node.children) parented.add(child);
      if (node.leaf !== undefined && !hierarchy.nodes[node.leaf]) throw new Error("Invalid proxy leaf");
    }
    for (const leaf of hierarchy.nodes) {
      if (!manifest.chunksById.has(leaf.chunk) || leaf.levels.length !== 3) throw new Error("Invalid proxy chunk");
      for (const level of leaf.levels) {
        if (![1, 2, 4].includes(level.step) || !Number.isInteger(level.count) || level.count < 1 ||
          level.count > (manifest.voxelsPerChunk / level.step) ** 3 || !Number.isSafeInteger(level.offset) ||
          level.offset < 0 || level.offset + level.count * 16 > hierarchy.bytes) throw new Error("Invalid proxy brick span");
      }
    }
    return new HierarchicalProxies(manifest, hierarchy, renderer);
  }

  update(camera: THREE.PerspectiveCamera): void {
    const now = performance.now();
    if (now >= this.retryAt) { this.dirty = true; this.retryAt = Infinity; }
    const height = this.renderer.domElement.clientHeight;
    if (!this.dirty && this.lastPosition.distanceToSquared(camera.position) < 0.01 &&
      this.lastHeight === height && this.lastFov === camera.fov) return;
    if (!this.dirty && now - this.lastUpdate < 150) return;
    this.lastUpdate = now;
    this.dirty = false;
    this.lastPosition.copy(camera.position); this.lastHeight = height; this.lastFov = camera.fov;
    this.tick++;
    const box = new THREE.Box3();
    const center = new THREE.Vector3();
    const matrix = new THREE.Matrix4();
    const scale = new THREE.Vector3();
    const rotation = new THREE.Quaternion();
    const pixelScale = this.renderer.domElement.clientHeight / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
    const cut = selectProxyCut(this.hierarchy.tree, index => {
      const node = this.hierarchy.tree[index];
      const size = node.span * this.manifest.chunkWorldSize;
      box.min.set(...node.origin as [number, number, number]).multiplyScalar(this.manifest.chunkWorldSize).addScalar(-this.manifest.worldScale);
      box.max.copy(box.min).addScalar(size);
      // A camera-centered 360-degree detail cut: turning does not evict or
      // replace gray bricks. Instanced GPU culling still rejects offscreen cubes.
      const distance = Math.max(this.manifest.voxelWorldSize, box.distanceToPoint(camera.position));
      // Distance to the nearest surface, not projected node size: a large far
      // branch must not displace a small nearby one as the camera translates.
      return 1 / (distance / this.manifest.chunkWorldSize + .01);
    }, CUT_CAPACITY, 1 / 12).map(index => this.hierarchy.tree[index]);
    cut.sort((a, b) => {
      const distance = (n: Node) => n.origin.reduce((sum, value, k) => sum +
        ((value + n.span / 2) * this.manifest.chunkWorldSize - this.manifest.worldScale - camera.position.getComponent(k)) ** 2, 0);
      return distance(a) - distance(b) || (a.leaf ?? -1) - (b.leaf ?? -1);
    });
    const leaves = cut.filter(node => node.leaf !== undefined && !this.resident.has(this.hierarchy.nodes[node.leaf].chunk));
    const nextLods = new Map<number, number>();
    const levels = allocateProxyBricks(leaves.map(node => {
      const leaf = this.hierarchy.nodes[node.leaf!];
      this.manifest.chunkCenterWorld(leaf.chunk, center);
      const distance = camera.position.distanceTo(center);
      const pixels = this.manifest.voxelWorldSize * pixelScale / Math.max(1, distance - this.manifest.chunkWorldSize);
      const lod = proxyBrickLod(distance / this.manifest.chunkWorldSize, pixels, this.lastLods.get(leaf.chunk));
      nextLods.set(leaf.chunk, lod);
      return { counts: leaf.levels.map(level => level.count), lod };
    }), runtimeProfile.mobile ? 48 : 128, runtimeProfile.mobile ? 16384 : 65536);
    this.lastLods = nextLods;
    const selected = new Map(leaves.slice(0, levels.length).map((node, i) => [node.leaf!, levels[i]]));
    this.protectedBases.clear();
    for (const leaf of selected.keys()) this.protectedBases.add(`${this.hierarchy.nodes[leaf].chunk}:0`);
    for (const brick of this.bricks.values()) brick.mesh.visible = false;
    this.handles.clear();
    let coarseCount = 0, fineCount = 0;
    for (const node of cut) {
      const nodeCount = this.metadataFilter ? this.nodeCounts.get(node) ?? 0 : node.count;
      if (nodeCount <= this.countFilter) continue;
      if (node.leaf !== undefined) {
        const leaf = this.hierarchy.nodes[node.leaf];
        if (this.resident.has(leaf.chunk)) continue;
        const lod = selected.get(node.leaf) ?? 0;
        const level = leaf.levels[lod];
        const key = `${leaf.chunk}:${lod}`;
        let brick = this.bricks.get(key);
        if (!brick && selected.has(node.leaf)) {
          // Establish cheap gray coverage before spending range/instance
          // budgets on a dense fine brick. Both are bounded by the same cache.
          const baseKey = `${leaf.chunk}:0`;
          if (!this.bricks.has(baseKey)) this.request(baseKey, leaf, leaf.levels[0]);
          else this.request(key, leaf, level);
        }
        // A cached coarser brick is a better loading placeholder than a solid chunk.
        for (let fallback = lod - 1; !brick && fallback >= 0; fallback--)
          brick = this.bricks.get(`${leaf.chunk}:${fallback}`);
        if (brick && selected.has(node.leaf)) {
          brick.mesh.visible = true;
          brick.lastUsed = this.tick;
          if (this.countFilter && !brick.filterCounts && !this.metadataFilter) this.requestFilterCounts(brick);
          for (let i = 0; i < brick.ids.length; i++) {
            // Until exact child counts arrive, don't misrepresent a sum as an
            // individual voxel's occupancy. Regional bounds remain context.
            const visible = brick.matches ? brick.matches[i].max > this.countFilter : !this.countFilter || (brick.filterCounts?.[i] ?? 0) > this.countFilter;
            brick.mesh.setVisibilityAt(i, visible);
            if (!visible) continue;
            fineCount++;
            const id = brick.ids[i];
            const handle = id.chunkId * 65536 + (brick.matches?.[i].local ?? id.localVoxelId);
            this.handles.set(handle, { brick, instance: i });
            brick.mesh.setColorAt(i, this.lit.has(handle) ? new THREE.Color(0xffcf6a) : brick.colors[i]);
          }
          continue;
        }
      }
      center.set(...node.origin as [number, number, number]).addScalar(node.span / 2)
        .multiplyScalar(this.manifest.chunkWorldSize).addScalar(-this.manifest.worldScale);
      scale.setScalar(node.span * this.manifest.chunkWorldSize * VOXEL_FILL);
      matrix.compose(center, rotation, scale);
      this.coarse.setMatrixAt(coarseCount, matrix);
      this.coarse.setColorAt(coarseCount, new THREE.Color(0x3b5861));
      this.coarse.setVisibilityAt(coarseCount, true);
      this.coarseIds[coarseCount++] = { chunkId: node.leaf === undefined ? -1 : this.hierarchy.nodes[node.leaf].chunk, localVoxelId: -1, count: nodeCount };
    }
    for (let i = coarseCount; i < CUT_CAPACITY; i++) this.coarse.setVisibilityAt(i, false);
    this.coarse.computeBoundingSphere();
    this.shown = fineCount + coarseCount;
    this.trim();
  }

  private request(key: string, leaf: Leaf, level: Level): void {
    if (this.pending.has(key) || this.pending.size >= 4 || (this.failures.get(key) ?? 0) > performance.now()) return;
    this.pending.add(key);
    void rangeReader.read(this.manifest.url(this.hierarchy.file), level.offset, level.count * 16, this.hierarchy.bytes)
      .then(buffer => {
        if (this.disposed) return;
        const data = new DataView(buffer);
        const mesh = new InstancedMesh2(new THREE.BoxGeometry(1, 1, 1), this.material, { capacity: level.count, renderer: this.renderer });
        mesh.initUniformsPerInstance({ fragment: { densityLevel: "float" } });
        setDensityRendering(mesh, this.xrayActive);
        this.material.opacity = this.xrayActive ? XRAY_OPACITY : 1;
        const ids: ProxyVoxel[] = [], colors: THREE.Color[] = [];
        const origins = new Uint16Array(level.count);
        const vpc = this.manifest.voxelsPerChunk;
        mesh.addInstances(level.count, (instance, i) => {
          const offset = i * 16;
          const x = data.getUint16(offset, true), y = data.getUint16(offset + 2, true), z = data.getUint16(offset + 4, true);
          origins[i] = x + y * vpc + z * vpc * vpc;
          this.manifest.voxelCenterWorldById(leaf.chunk, x + y * vpc + z * vpc * vpc, instance.position);
          instance.position.addScalar((level.step - 1) * this.manifest.voxelWorldSize / 2);
          instance.scale.setScalar(this.manifest.voxelWorldSize * level.step * VOXEL_FILL);
          const color = new THREE.Color().setRGB(data.getUint8(offset + 12) / 255, data.getUint8(offset + 13) / 255, data.getUint8(offset + 14) / 255, THREE.SRGBColorSpace)
            .lerp(new THREE.Color(0x82949a), .65).multiplyScalar(.8);
          instance.color = color;
          // Coarse cells initially show the mean per unit voxel, never their
          // larger aggregate as though it were one densely occupied voxel.
          instance.setUniform("densityLevel", densityLevel(data.getUint32(offset + 8, true) / level.step ** 3));
          colors.push(color);
          ids.push({ chunkId: leaf.chunk, localVoxelId: data.getUint16(offset + 6, true), count: data.getUint32(offset + 8, true) });
        });
        mesh.computeBVH();
        const cast = mesh.raycast.bind(mesh);
        mesh.raycast = (ray, hits) => { if (mesh.visible) cast(ray, hits); };
        mesh.visible = false;
        const brick: Brick = { mesh, ids, colors, origins, lastUsed: this.tick, leaf, level,
          source: level.step === 1 ? undefined : data,
          filterCounts: level.step === 1 ? Uint32Array.from(ids, id => id.count) : undefined };
        mesh.userData.proxyBrick = brick;
        this.applyMetadata(brick);
        this.bricks.set(key, brick);
        this.mesh.add(mesh);
        this.dirty = true;
        this.trim();
      }).catch(() => this.recordFailure(key))
      .finally(() => this.pending.delete(key));
  }

  private requestFilterCounts(brick: Brick): void {
    const key = `${brick.leaf.chunk}:${brick.level.step}:filter`;
    if (!brick.source || this.pending.has(key) || this.pending.size >= 4 ||
      (this.failures.get(key) ?? 0) > performance.now()) return;
    this.pending.add(key);
    const fine = brick.leaf.levels.find(level => level.step === 1)!;
    void rangeReader.read(this.manifest.url(this.hierarchy.file), fine.offset, fine.count * 16, this.hierarchy.bytes)
      .then(buffer => {
        if (this.disposed || brick.mesh.parent !== this.mesh) return;
        brick.filterCounts = proxyCellMaxCounts(new DataView(buffer), brick.source!, brick.level.step, this.manifest.voxelsPerChunk);
        // If exact child counts were fetched for filtering, show the peak
        // child density. No additional request is made just for X-ray.
        this.applyMetadata(brick);
        brick.source = undefined;
        this.dirty = true;
      }).catch(() => this.recordFailure(key))
      .finally(() => this.pending.delete(key));
  }

  private recordFailure(key: string): void {
    const retry = performance.now() + 5000;
    this.failures.set(key, retry);
    // Retry even if the camera stays still after a failed range request.
    this.retryAt = Math.min(this.retryAt, retry);
  }

  private trim(): void {
    let count = [...this.bricks.values()].reduce((sum, brick) => sum + brick.ids.length, 0);
    for (const [key, brick] of [...this.bricks].sort((a, b) => a[1].lastUsed - b[1].lastUsed)) {
      if (count <= (runtimeProfile.mobile ? 32768 : 131072) && this.bricks.size <= (runtimeProfile.mobile ? 96 : 256)) break;
      if (brick.mesh.visible || this.protectedBases.has(key)) continue;
      count -= brick.ids.length;
      brick.mesh.removeFromParent(); brick.mesh.dispose(); brick.mesh.geometry.dispose();
      this.bricks.delete(key);
    }
  }

  resolveHit(mesh: InstancedMesh2, id: number): ProxyVoxel | null {
    if (mesh === this.coarse) return this.coarseIds[id] ?? null;
    const brick = mesh.userData.proxyBrick as Brick | undefined;
    const original = brick?.ids[id], match = brick?.matches?.[id];
    return original ? match ? { chunkId: original.chunkId, localVoxelId: match.local, count: match.total } : original : null;
  }
  get instanceCount() { return this.shown; }
  get shownCount() { return this.shown; }
  setChunkResident(id: number, resident: boolean) {
    if (resident) this.resident.add(id); else this.resident.delete(id);
    this.dirty = true;
  }
  isChunkHidden(id: number) { return this.resident.has(id); }
  instanceIdOf(chunk: number, local: number) {
    const handle = chunk * 65536 + local;
    return this.handles.has(handle) ? handle : -1;
  }
  setLit(ids: Iterable<number>) { this.lit = new Set(ids); this.dirty = true; }
  clearLit() { this.lit.clear(); this.dirty = true; }
  stats(): VoxelProxyStats {
    return { voxels: this.shown, shown: this.shown, hidden: 0, hiddenChunks: this.resident.size, lit: this.lit.size, drawn: this.shown,
      cachedInstances: [...this.bricks.values()].reduce((sum, brick) => sum + brick.ids.length, 0),
      cachedBricks: this.bricks.size, pendingBricks: this.pending.size };
  }
  dispose() {
    this.disposed = true;
    this.mesh.removeFromParent();
    for (const brick of this.bricks.values()) { brick.mesh.dispose(); brick.mesh.geometry.dispose(); }
    this.bricks.clear(); this.coarse.dispose(); this.coarse.geometry.dispose(); this.material.dispose();
    this.coarseMaterial.dispose();
  }
}
