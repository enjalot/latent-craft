import * as THREE from "three";
import { fetchThumbnailBlob } from "../streaming/ThumbnailSource.ts";

export const PREVIEW_EDGE = 128;
export const PREVIEW_SLOTS = 128;
export const PREVIEW_CONCURRENCY = 4;
export interface PreviewTarget {
  key: string;
  matrix: THREE.Matrix4;
  opacity: number;
  focused?: boolean;
  valid: () => boolean;
  resolve: () => Promise<string | null>;
}
type Entry = { slot: number; state: "loading" | "decoded" | "ready" | "failed";
  pixels?: Uint8ClampedArray; request: AbortController; used: number; retry: number };

/** Upload only 128px, crop to match the square atlas convention, and release
 * the bitmap immediately. Source download stays full-size until a server
 * thumbnail variant exists; this optimization is upload/GPU-side. */
export async function previewPixels(target: PreviewTarget, signal: AbortSignal): Promise<Uint8ClampedArray> {
  const url = await target.resolve();
  signal.throwIfAborted();
  if (!url) throw new Error("Preview row not available");
  const blob = await fetchThumbnailBlob(url, signal);
  signal.throwIfAborted();
  const bitmap = await createImageBitmap(blob);
  try {
    signal.throwIfAborted();
    const canvas = new OffscreenCanvas(PREVIEW_EDGE, PREVIEW_EDGE);
    const ctx = canvas.getContext("2d")!;
    // Data-array rows upload bottom-first, unlike Canvas's top-first rows.
    ctx.translate(0, PREVIEW_EDGE); ctx.scale(1, -1);
    ctx.imageSmoothingQuality = "high";
    const side = Math.min(bitmap.width, bitmap.height);
    ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, PREVIEW_EDGE, PREVIEW_EDGE);
    return ctx.getImageData(0, 0, PREVIEW_EDGE, PREVIEW_EDGE).data;
  } finally { bitmap.close(); }
}

/** One draw call, fixed texture memory, four resolves/decodes in flight, and
 * at most two layer uploads per frame. Idle slots form a bounded warm LRU.
 * State changes invalidate old images immediately, including pending loads. */
export class PreviewPool {
  readonly mesh: THREE.InstancedMesh<THREE.BoxGeometry, THREE.MeshBasicMaterial>;
  readonly texture: THREE.DataArrayTexture;
  readonly focusMesh: THREE.InstancedMesh<THREE.BoxGeometry, THREE.MeshBasicMaterial>;
  private entries = new Map<string, Entry>();
  private active = 0;
  private frame = 0;
  private disposed = false;
  private readonly layers = new THREE.InstancedBufferAttribute(new Float32Array(PREVIEW_SLOTS), 1);
  private readonly alphas = new THREE.InstancedBufferAttribute(new Float32Array(PREVIEW_SLOTS), 1);
  private desired: PreviewTarget[] = [];
  readonly visibleKeys = new Set<string>();
  private readonly pixels = new Uint8Array(PREVIEW_EDGE ** 2 * 4 * PREVIEW_SLOTS);

  constructor(scene: THREE.Scene, renderer: THREE.WebGLRenderer,
    private readonly load = previewPixels) {
    this.texture = new THREE.DataArrayTexture(this.pixels, PREVIEW_EDGE, PREVIEW_EDGE, PREVIEW_SLOTS);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.minFilter = THREE.LinearMipmapLinearFilter;
    this.texture.generateMipmaps = true;
    this.texture.needsUpdate = true;
    // Allocate once. Later updates use texSubImage3D for named layers only.
    renderer.initTexture(this.texture);
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    geometry.setAttribute("previewLayer", this.layers);
    geometry.setAttribute("previewAlpha", this.alphas);
    const material = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false, alphaToCoverage: true });
    material.onBeforeCompile = shader => {
      shader.uniforms.previewMap = { value: this.texture };
      shader.vertexShader = `attribute float previewLayer, previewAlpha; varying vec3 previewUv; varying float previewOpacity;\n${shader.vertexShader}`
        .replace("#include <begin_vertex>", "#include <begin_vertex>\npreviewUv = vec3(uv, previewLayer); previewOpacity = previewAlpha;");
      shader.fragmentShader = `uniform highp sampler2DArray previewMap; varying vec3 previewUv; varying float previewOpacity;\n${shader.fragmentShader}`
        .replace("#include <map_fragment>", "diffuseColor *= texture(previewMap, previewUv); diffuseColor.a *= previewOpacity;");
    };
    material.customProgramCacheKey = () => "sharp-preview-array-v2";
    this.mesh = new THREE.InstancedMesh(geometry, material, PREVIEW_SLOTS);
    this.mesh.name = "sharp-band-128px";
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 0;
    // No overlay ever participates in interaction raycasts.
    this.mesh.raycast = () => {};
    scene.add(this.mesh);
    const focusGeometry = new THREE.BoxGeometry(1, 1, 1);
    focusGeometry.setAttribute("previewLayer", new THREE.InstancedBufferAttribute(new Float32Array(1), 1));
    focusGeometry.setAttribute("previewAlpha", new THREE.InstancedBufferAttribute(new Float32Array([1]), 1));
    const focusMaterial = material.clone();
    focusMaterial.onBeforeCompile = material.onBeforeCompile;
    focusMaterial.customProgramCacheKey = material.customProgramCacheKey;
    this.focusMesh = new THREE.InstancedMesh(focusGeometry, focusMaterial, 1);
    this.focusMesh.name = "xray-opaque-sharp-hover";
    this.focusMesh.count = 0; this.focusMesh.frustumCulled = false; this.focusMesh.raycast = () => {};
    scene.add(this.focusMesh);
  }

  update(targets: PreviewTarget[], xray: boolean, camera: THREE.Camera): void {
    if (this.disposed) return;
    this.frame++;
    const keys = new Set<string>();
    this.desired = targets.filter(t => {
      if (keys.size >= PREVIEW_SLOTS || keys.has(t.key) || !t.valid()) return false;
      keys.add(t.key); return true;
    });
    for (const [key, entry] of this.entries) {
      if (!keys.has(key) && entry.state === "loading") {
        entry.request.abort(); this.entries.delete(key);
      }
    }
    let uploads = 0;
    for (const target of this.desired) {
      const entry = this.entries.get(target.key);
      if (!entry) continue;
      entry.used = this.frame;
      if (entry.state === "decoded" && uploads < 2) {
        this.pixels.set(entry.pixels!, entry.slot * PREVIEW_EDGE ** 2 * 4);
        entry.pixels = undefined; entry.state = "ready";
        this.texture.addLayerUpdate(entry.slot); uploads++;
      }
    }
    if (uploads) this.texture.needsUpdate = true;
    for (const target of this.desired) {
      if (this.active >= PREVIEW_CONCURRENCY) break;
      let entry = this.entries.get(target.key);
      if (entry && (entry.state !== "failed" || performance.now() < entry.retry)) continue;
      if (!entry) {
        if (this.entries.size >= PREVIEW_SLOTS) {
          const victim = [...this.entries].filter(([key]) => !keys.has(key)).sort((a,b) => a[1].used - b[1].used)[0];
          if (!victim) continue;
          victim[1].request.abort(); this.entries.delete(victim[0]);
        }
        const used = new Set([...this.entries.values()].map(e => e.slot));
        let slot = 0; while (used.has(slot)) slot++;
        entry = { slot, state: "loading", request: new AbortController(), used: this.frame, retry: 0 };
        this.entries.set(target.key, entry);
      } else { entry.state = "loading"; entry.request = new AbortController(); }
      const current = entry;
      this.active++;
      void this.load(target, current.request.signal).then(pixels => {
        if (this.disposed || current.request.signal.aborted || this.entries.get(target.key) !== current) return;
        if (pixels.byteLength !== PREVIEW_EDGE ** 2 * 4) throw new Error("Invalid preview pixel dimensions");
        current.pixels = pixels; current.state = "decoded";
      }).catch(() => {
        if (!this.disposed && this.entries.get(target.key) === current) {
          current.state = "failed"; current.retry = performance.now() + 2000;
        }
      }).finally(() => { this.active--; });
    }
    // Glass previews sort far-to-near. The explicitly focused X-ray image is
    // the exception: one opaque depth-writing draw sharing the same array.
    const visible = this.desired.filter(t => this.entries.get(t.key)?.state === "ready");
    // Mining must NOT move the entire pool into the transparent queue: one
    // fading image would then overpaint neighbouring depth-write-free cages.
    // Normal mining uses the same MSAA coverage path as the base cubes;
    // only explicit X-ray switches queues (and X-ray hides cages).
    const transparent = xray;
    if (transparent) visible.sort((a,b) => distance2(b.matrix, camera.position) - distance2(a.matrix, camera.position));
    let count = 0;
    this.focusMesh.count = 0;
    this.visibleKeys.clear();
    for (const target of visible) {
      this.visibleKeys.add(target.key);
      if (xray && target.focused && !this.focusMesh.count) {
        this.focusMesh.setMatrixAt(0, target.matrix);
        this.focusMesh.instanceMatrix.needsUpdate = true;
        const layer = this.focusMesh.geometry.getAttribute("previewLayer") as THREE.InstancedBufferAttribute;
        layer.setX(0, this.entries.get(target.key)!.slot); layer.needsUpdate = true;
        this.focusMesh.count = 1;
        continue;
      }
      this.mesh.setMatrixAt(count, target.matrix);
      this.layers.setX(count, this.entries.get(target.key)!.slot);
      this.alphas.setX(count, target.opacity);
      count++;
    }
    this.mesh.count = count;
    this.mesh.instanceMatrix.needsUpdate = true; this.layers.needsUpdate = true; this.alphas.needsUpdate = true;
    if (this.mesh.material.transparent !== transparent) {
      this.mesh.material.transparent = transparent; this.mesh.material.depthWrite = !transparent;
      this.mesh.material.alphaToCoverage = !transparent;
      this.mesh.material.needsUpdate = true;
    }
  }

  get stats() { return { slots: this.entries.size, visible: this.mesh.count + this.focusMesh.count, pending: this.active,
    gpuBytes: PREVIEW_SLOTS * (PREVIEW_EDGE ** 2 * 4 - 1) / 3 * 4, cpuPixelBytes: this.pixels.byteLength }; }

  dispose(): void {
    this.disposed = true;
    for (const entry of this.entries.values()) entry.request.abort();
    this.entries.clear(); this.desired = [];
    this.mesh.removeFromParent(); this.mesh.geometry.dispose(); this.mesh.material.dispose(); this.texture.dispose();
    this.focusMesh.removeFromParent(); this.focusMesh.geometry.dispose(); this.focusMesh.material.dispose(); this.focusMesh.dispose();
    this.mesh.dispose();
  }
}

function distance2(matrix: THREE.Matrix4, camera: THREE.Vector3): number {
  const e = matrix.elements;
  return (e[12] - camera.x) ** 2 + (e[13] - camera.y) ** 2 + (e[14] - camera.z) ** 2;
}
