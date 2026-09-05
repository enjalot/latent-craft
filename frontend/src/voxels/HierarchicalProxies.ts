import * as THREE from "three";
import { InstancedMesh2 } from "@three.ez/instanced-mesh";
import { fetchJson } from "../net/fetchTyped.ts";
import { rangeReader } from "../streaming/RangeReader.ts";
import type { Manifest } from "../streaming/Manifest.ts";
import type { ProxyVoxel, VoxelProxyStats } from "./VoxelProxyCloud.ts";
import { VOXEL_FILL } from "../config.ts";

interface Level { offset: number; count: number; step: number }
interface Leaf { chunk: number; xyz: number[]; count: number; levels: Level[] }
interface Node { origin: number[]; span: number; count: number; leaf?: number; children: number[] }
interface Hierarchy { version: number; file: string; bytes: number; nodes: Leaf[]; tree: Node[] }
interface Brick { mesh: InstancedMesh2; ids: ProxyVoxel[]; colors: THREE.Color[]; lastUsed: number }

/** View-dependent octree cut + range-loaded 4/2/1 voxel bricks. Resident fine
 * geometry never scales with corpus size. A missing brick keeps its parent visible. */
export class HierarchicalProxies {
  readonly mesh = new THREE.Group();
  private readonly resident = new Set<number>();
  private readonly bricks = new Map<string, Brick>();
  private readonly pending = new Set<string>();
  private readonly failures = new Map<string, number>();
  private readonly coarse: InstancedMesh2;
  private readonly material = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0 });
  // Missing-detail regions are a faint spatial hint, not solid obstacles.
  private readonly coarseMaterial = new THREE.MeshBasicMaterial({
    transparent: true, opacity: 0.08, depthWrite: false,
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
  private readonly lastRotation = new THREE.Quaternion();
  private lastHeight = -1;

  private constructor(private readonly manifest: Manifest, private readonly hierarchy: Hierarchy,
    private readonly renderer: THREE.WebGLRenderer) {
    this.coarse = new InstancedMesh2(new THREE.BoxGeometry(1, 1, 1), this.coarseMaterial, { capacity: 512, renderer });
    this.coarse.addInstances(512);
    for (let i = 0; i < 512; i++) this.coarse.setVisibilityAt(i, false);
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
    const height = this.renderer.domElement.clientHeight;
    if (!this.dirty && this.lastPosition.distanceToSquared(camera.position) < 0.01 &&
      Math.abs(this.lastRotation.dot(camera.quaternion)) > 0.99999 && this.lastHeight === height) return;
    if (!this.dirty && now - this.lastUpdate < 150) return;
    this.lastUpdate = now;
    this.dirty = false;
    this.lastPosition.copy(camera.position); this.lastRotation.copy(camera.quaternion); this.lastHeight = height;
    this.tick++;
    const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    const box = new THREE.Box3();
    const center = new THREE.Vector3();
    const matrix = new THREE.Matrix4();
    const scale = new THREE.Vector3();
    const rotation = new THREE.Quaternion();
    const pixelScale = this.renderer.domElement.clientHeight / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
    const cut: Node[] = [];
    const stack = this.hierarchy.tree.length ? [0] : [];
    while (stack.length) {
      const node = this.hierarchy.tree[stack.pop()!];
      const size = node.span * this.manifest.chunkWorldSize;
      box.min.set(...node.origin as [number, number, number]).multiplyScalar(this.manifest.chunkWorldSize).addScalar(-this.manifest.worldScale);
      box.max.copy(box.min).addScalar(size);
      if (!frustum.intersectsBox(box)) continue;
      box.getCenter(center);
      const distance = Math.max(this.manifest.voxelWorldSize, box.distanceToPoint(camera.position));
      if (node.children.length && size * pixelScale / distance > 80 && cut.length + stack.length + node.children.length < 512) {
        stack.push(...node.children);
      } else cut.push(node);
    }
    cut.sort((a, b) => {
      const distance = (n: Node) => n.origin.reduce((sum, value, k) => sum +
        ((value + n.span / 2) * this.manifest.chunkWorldSize - this.manifest.worldScale - camera.position.getComponent(k)) ** 2, 0);
      return distance(a) - distance(b);
    });
    for (const brick of this.bricks.values()) brick.mesh.visible = false;
    this.handles.clear();
    let coarseCount = 0, fineCount = 0, brickCount = 0;
    for (const node of cut) {
      if (node.leaf !== undefined) {
        const leaf = this.hierarchy.nodes[node.leaf];
        if (this.resident.has(leaf.chunk)) continue;
        this.manifest.chunkCenterWorld(leaf.chunk, center);
        const pixels = this.manifest.voxelWorldSize * pixelScale / Math.max(1, camera.position.distanceTo(center) - this.manifest.chunkWorldSize);
        const lod = pixels >= 8 ? 2 : pixels >= 3 ? 1 : 0;
        const level = leaf.levels[lod];
        const key = `${leaf.chunk}:${lod}`;
        let brick = this.bricks.get(key);
        if (!brick && brickCount < 64) this.request(key, leaf, level);
        // A cached coarser brick is a better loading placeholder than a solid chunk.
        brick ??= this.bricks.get(`${leaf.chunk}:0`);
        if (brick && brickCount < 64 && fineCount + brick.ids.length <= 32768) {
          brick.mesh.visible = true;
          brick.lastUsed = this.tick;
          brickCount++;
          fineCount += brick.ids.length;
          for (let i = 0; i < brick.ids.length; i++) {
            const id = brick.ids[i];
            const handle = id.chunkId * 65536 + id.localVoxelId;
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
      this.coarseIds[coarseCount++] = { chunkId: node.leaf === undefined ? -1 : this.hierarchy.nodes[node.leaf].chunk, localVoxelId: -1, count: node.count };
    }
    for (let i = coarseCount; i < 512; i++) this.coarse.setVisibilityAt(i, false);
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
        const ids: ProxyVoxel[] = [], colors: THREE.Color[] = [];
        const vpc = this.manifest.voxelsPerChunk;
        mesh.addInstances(level.count, (instance, i) => {
          const offset = i * 16;
          const x = data.getUint16(offset, true), y = data.getUint16(offset + 2, true), z = data.getUint16(offset + 4, true);
          this.manifest.voxelCenterWorldById(leaf.chunk, x + y * vpc + z * vpc * vpc, instance.position);
          instance.position.addScalar((level.step - 1) * this.manifest.voxelWorldSize / 2);
          instance.scale.setScalar(this.manifest.voxelWorldSize * level.step * VOXEL_FILL);
          const color = new THREE.Color().setRGB(data.getUint8(offset + 12) / 255, data.getUint8(offset + 13) / 255, data.getUint8(offset + 14) / 255, THREE.SRGBColorSpace).multiplyScalar(0.65);
          instance.color = color;
          colors.push(color);
          ids.push({ chunkId: leaf.chunk, localVoxelId: data.getUint16(offset + 6, true), count: data.getUint32(offset + 8, true) });
        });
        mesh.computeBVH();
        const cast = mesh.raycast.bind(mesh);
        mesh.raycast = (ray, hits) => { if (mesh.visible) cast(ray, hits); };
        mesh.visible = false;
        const brick = { mesh, ids, colors, lastUsed: this.tick };
        mesh.userData.proxyBrick = brick;
        this.bricks.set(key, brick);
        this.mesh.add(mesh);
        this.dirty = true;
        this.trim();
      }).catch(() => this.failures.set(key, performance.now() + 5000))
      .finally(() => this.pending.delete(key));
  }

  private trim(): void {
    let count = [...this.bricks.values()].reduce((sum, brick) => sum + brick.ids.length, 0);
    for (const [key, brick] of [...this.bricks].sort((a, b) => a[1].lastUsed - b[1].lastUsed)) {
      if (count <= 65536 && this.bricks.size <= 96) break;
      if (brick.mesh.visible) continue;
      count -= brick.ids.length;
      brick.mesh.removeFromParent(); brick.mesh.dispose(); brick.mesh.geometry.dispose();
      this.bricks.delete(key);
    }
  }

  resolveHit(mesh: InstancedMesh2, id: number): ProxyVoxel | null {
    return mesh === this.coarse ? this.coarseIds[id] ?? null : (mesh.userData.proxyBrick as Brick | undefined)?.ids[id] ?? null;
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
