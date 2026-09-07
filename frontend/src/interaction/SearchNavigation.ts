import * as THREE from "three";
import type { Engine } from "../engine/Engine.ts";
import type { FlightControls } from "../engine/FlightControls.ts";
import type { Manifest } from "../streaming/Manifest.ts";
import type { ChunkStore } from "../streaming/ChunkStore.ts";
import type { MinimapBridge } from "./MinimapBridge.ts";
import type { SharpBand } from "./SharpBand.ts";
import type { CompareResponse, SearchResult } from "../search/CompareClient.ts";
import { planVoxelFlight } from "./VoxelFlight.ts";

/** Pure coordinate navigation: deliberately no nearest-image/occupied-cell snap. */
export function planProjectionFlight(position: number[], manifest: Manifest, camera: THREE.Vector3, radius: number) {
  if (position.length !== 3 || !position.every(Number.isFinite)) throw new Error("Invalid projected position");
  const target = new THREE.Vector3(...position).multiplyScalar(manifest.worldScale);
  const direction = camera.clone().sub(target);
  if (direction.lengthSq() < 1e-8) direction.set(0, 0, 1);
  const distance = Math.max(12 * manifest.voxelWorldSize, radius + 2 * manifest.voxelWorldSize);
  return { target, destination: target.clone().addScaledVector(direction.normalize(), distance) };
}

export class SearchNavigation {
  private readonly marker = new THREE.Group();
  private readonly material = new THREE.MeshStandardMaterial({ color: 0x7fffe0, emissive: 0x168c78, emissiveIntensity: .65, roughness: .3, metalness: .45 });
  private readonly ring: THREE.TorusGeometry;
  private readonly sphere: THREE.SphereGeometry;
  private selected: SearchResult | null = null;

  constructor(private readonly manifest: Manifest, private readonly engine: Engine,
    private readonly controls: FlightControls, private readonly store: ChunkStore,
    private readonly sharp: SharpBand, private readonly minimap: () => MinimapBridge | null,
    private readonly radius: () => number, private readonly cancelHold: () => void) {
    const size = manifest.voxelWorldSize;
    this.ring = new THREE.TorusGeometry(.7 * size, .035 * size, 6, 32);
    this.sphere = new THREE.SphereGeometry(.16 * size, 12, 8);
    this.marker.add(new THREE.Mesh(this.sphere, this.material));
    for (let axis = 0; axis < 3; axis++) {
      const mesh = new THREE.Mesh(this.ring, this.material);
      if (axis === 1) mesh.rotation.x = Math.PI/2;
      if (axis === 2) mesh.rotation.y = Math.PI/2;
      this.marker.add(mesh);
    }
    this.marker.visible = false; engine.scene.add(this.marker);
  }

  project(response: CompareResponse): void {
    this.clear();
    const plan = planProjectionFlight(response.projection.position, this.manifest, this.engine.camera.position, this.radius());
    this.marker.position.copy(plan.target); this.marker.visible = true;
    const map = this.minimap();
    if (map) {
      const [x0, x1, y0, y1] = map.pack.extent;
      const [x, y] = response.projection.raw2;
      // Off-frame predictions are not clamped onto a misleading minimap edge.
      if (x >= x0 && x <= x1 && y >= y0 && y <= y1)
        map.panel.setFlashlight({ qx: Math.min(65535, Math.floor((x-x0)/(x1-x0)*65536)), qy: Math.min(65535, Math.floor((y1-y)/(y1-y0)*65536)), radiusQ: 1200 });
      map.panel.setCaption("Text projection · independent 2D / 3D heads\nNo nearest-image search or snapping");
    }
    this.fly(plan);
  }

  hover(result: SearchResult | null): void {
    const focus = result ?? this.selected;
    this.sharp.setSearchFocus(focus ? { chunkId: focus.chunk, localVoxelId: focus.local, rowId: focus.row } : null);
    if (!focus) { this.minimap()?.clearVoxelHighlight(); this.controls.cancelLookTransition(); return; }
    const plan = planVoxelFlight(this.manifest, focus.chunk, focus.local, this.engine.camera.position, this.radius());
    if (!plan) return;
    this.minimap()?.cancelHoverLook();
    this.minimap()?.highlightVoxel(focus.chunk, focus.local, focus.row, "search");
    this.minimap()?.panel.setCaption(`Search result · row ${focus.row}\n${focus.model ?? "CLIP"} cosine ${focus.score.toFixed(3)}`);
    if (result) this.controls.lookTransitionTo(plan.target, 280);
  }

  select(result: SearchResult): void {
    this.marker.visible = false; this.selected = result;
    this.hover(result);
    const plan = planVoxelFlight(this.manifest, result.chunk, result.local, this.engine.camera.position, this.radius());
    if (plan) this.fly(plan);
  }

  private fly(plan: { target: THREE.Vector3; destination: THREE.Vector3 }): void {
    this.cancelHold(); this.minimap()?.cancelHoverLook(); this.controls.cancelLookTransition();
    this.store.prioritizeTeleport(plan.target, this.engine.camera);
    this.engine.teleportTo(plan.destination, { lookAt: plan.target, onArrive: () => {
      this.controls.lookAt(plan.target); this.store.clearTeleportTarget();
    } });
  }

  clear(): void {
    this.selected = null; this.marker.visible = false; this.sharp.setSearchFocus(null);
    this.minimap()?.clearVoxelHighlight(); this.minimap()?.cancelHoverLook(); this.controls.cancelLookTransition();
  }

  dispose(): void {
    this.clear(); this.marker.removeFromParent(); this.ring.dispose(); this.sphere.dispose(); this.material.dispose();
  }
}
