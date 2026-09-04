import * as THREE from "three";

/**
 * One high-resolution texture overlay for the voxel currently being mined.
 *
 * Chunk atlases use 32px tiles because every resident voxel needs one at the
 * same time. Rebuilding those atlases at 64px would multiply their texel and
 * transfer cost by four. This mesh instead reuses the normal per-point
 * thumbnail (typically 256px+) for exactly one block, so the focused face can
 * be crisp without changing chunk memory or draw-call count with world size.
 * It is not included in `main.ts`'s raycast targets.
 */
export class MiningPreview {
  readonly mesh: THREE.Mesh<THREE.BoxGeometry, THREE.MeshBasicMaterial>;

  private request: AbortController | null = null;
  private bitmap: ImageBitmap | null = null;
  private readonly position = new THREE.Vector3();
  private readonly quaternion = new THREE.Quaternion();
  private readonly scale = new THREE.Vector3();
  private texture: THREE.Texture | null = null;
  private selectedRowId: number | null = null;
  private selectedUrl: string | null = null;
  private loadGeneration = 0;
  private disposed = false;

  constructor(scene: THREE.Scene, private readonly renderer: THREE.WebGLRenderer) {
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const material = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.name = "active-mining-high-res-preview";
    this.mesh.visible = false;
    this.mesh.renderOrder = 1;
    scene.add(this.mesh);
  }

  get currentRowId(): number | null {
    return this.selectedRowId;
  }

  /** Selects the next row that will be extracted and positions the overlay on
   * its source block. Repeated frame calls for the same row are allocation-
   * and network-free; only a changed row starts a new image decode. */
  show(rowId: number, url: string, instanceMatrix: THREE.Matrix4): void {
    if (this.disposed) return;
    instanceMatrix.decompose(this.position, this.quaternion, this.scale);
    this.mesh.position.copy(this.position);
    this.mesh.quaternion.copy(this.quaternion);
    // Just outside the atlas cube to avoid z-fighting, still inside its cage.
    this.mesh.scale.copy(this.scale).multiplyScalar(1.012);

    if (rowId === this.selectedRowId && url === this.selectedUrl) return;
    this.selectedRowId = rowId;
    this.selectedUrl = url;
    this.mesh.visible = false;
    const generation = ++this.loadGeneration;
    this.request?.abort();
    const request = new AbortController();
    this.request = request;
    void fetch(url, { signal: request.signal }).then(async response => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bitmap = await createImageBitmap(await response.blob(), { imageOrientation: "flipY" });
      if (this.disposed || generation !== this.loadGeneration) { bitmap.close(); return; }
      const texture = new THREE.Texture(bitmap);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.flipY = false;
      texture.anisotropy = Math.min(4, this.renderer.capabilities.getMaxAnisotropy());
      texture.needsUpdate = true;
      this.texture?.dispose();
      this.bitmap?.close();
      this.bitmap = bitmap;
      this.texture = texture;
      this.mesh.material.map = texture;
      this.mesh.material.needsUpdate = true;
      this.mesh.visible = true;
    }).catch(error => {
      if (!request.signal.aborted && generation === this.loadGeneration)
        console.warn(`[MiningPreview] thumbnail ${rowId} failed to load`, error);
    });
  }

  hide(): void {
    if (this.selectedRowId === null && !this.mesh.visible) return;
    this.selectedRowId = null;
    this.selectedUrl = null;
    this.loadGeneration++;
    this.request?.abort();
    this.mesh.visible = false;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.hide();
    this.mesh.removeFromParent();
    this.texture?.dispose();
    this.bitmap?.close();
    this.texture = null;
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
