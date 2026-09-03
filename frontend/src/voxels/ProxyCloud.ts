import * as THREE from "three";
import { InstancedMesh2 } from "@three.ez/instanced-mesh";
import { fetchArrayBuffer } from "../net/fetchTyped.ts";
import type { Manifest } from "../streaming/Manifest.ts";
import type { ProxyData } from "../types.ts";
import {
  PROXY_DENSITY_LOG2_MAX,
  PROXY_MAX_FILL,
  PROXY_MIN_FILL,
  PROXY_OPACITY,
} from "../config.ts";

const PROXY_MAGIC = "LSVP";
const PROXY_HEADER_BYTES = 16;
const PROXY_RECORD_BYTES = 12;

/**
 * Decodes `proxy.bin` — one record per chunk *slot* across the full
 * `chunks_per_axis^3` grid, including the empty slots that `manifest.chunks`
 * omits. That density is the whole point: it is what lets the client draw the
 * world's silhouette before it knows anything about individual voxels.
 *
 *   header 16B: magic "LSVP" | version u16 | chunks_per_axis u16 | 8B reserved
 *   ProxyRecord[chunks_per_axis^3], 12B each, index == chunk_id:
 *     color_rgb u8[3] | density_log2 u8 | n_points u32
 *     | n_occupied_voxels u16 | reserved u16
 */
export function parseProxy(buffer: ArrayBuffer): ProxyData {
  const view = new DataView(buffer);
  const magic = String.fromCharCode(
    view.getUint8(0),
    view.getUint8(1),
    view.getUint8(2),
    view.getUint8(3),
  );
  if (magic !== PROXY_MAGIC) throw new Error(`proxy.bin: bad magic ${JSON.stringify(magic)}`);
  const version = view.getUint16(4, true);
  if (version !== 1) throw new Error(`proxy.bin: unsupported version ${version}`);
  const chunksPerAxis = view.getUint16(6, true);

  const total = chunksPerAxis ** 3;
  const expectedBytes = PROXY_HEADER_BYTES + total * PROXY_RECORD_BYTES;
  if (buffer.byteLength !== expectedBytes) {
    throw new Error(
      `proxy.bin: size mismatch — got ${buffer.byteLength}B, header implies ${expectedBytes}B`,
    );
  }

  const colorRgb = new Uint8Array(total * 3);
  const densityLog2 = new Uint8Array(total);
  const nPoints = new Uint32Array(total);
  const nOccupiedVoxels = new Uint16Array(total);

  for (let i = 0; i < total; i++) {
    const base = PROXY_HEADER_BYTES + i * PROXY_RECORD_BYTES;
    colorRgb[i * 3] = view.getUint8(base);
    colorRgb[i * 3 + 1] = view.getUint8(base + 1);
    colorRgb[i * 3 + 2] = view.getUint8(base + 2);
    densityLog2[i] = view.getUint8(base + 3);
    nPoints[i] = view.getUint32(base + 4, true);
    nOccupiedVoxels[i] = view.getUint16(base + 8, true);
  }

  return { chunksPerAxis, colorRgb, densityLog2, nPoints, nOccupiedVoxels };
}

/**
 * The always-resident coarse world: one translucent, density-scaled cube per
 * non-empty chunk slot, colored by that chunk's mean thumbnail color.
 *
 * This is what stops the world from ever being blank — it renders before a
 * single chunk has streamed, and each proxy cube switches itself off the
 * moment its real chunk becomes resident (and back on when that chunk is
 * evicted), so the coarse layer and the detailed layer never fight over the
 * same volume.
 *
 * Empty slots (`n_points == 0`) get no instance at all — not an invisible one
 * — so they cost nothing.
 */
export class ProxyCloud {
  readonly mesh: InstancedMesh2;
  readonly data: ProxyData;

  /** chunk_id → instance id, for the slots that actually got an instance. */
  private readonly instanceByChunkId = new Map<number, number>();
  private readonly geometry: THREE.BoxGeometry;
  private readonly material: THREE.MeshStandardMaterial;

  constructor(manifest: Manifest, data: ProxyData, renderer: THREE.WebGLRenderer) {
    this.data = data;

    const occupiedSlots: number[] = [];
    for (let chunkId = 0; chunkId < data.nPoints.length; chunkId++) {
      if (data.nPoints[chunkId] > 0) occupiedSlots.push(chunkId);
    }

    this.geometry = new THREE.BoxGeometry(1, 1, 1);
    this.material = new THREE.MeshStandardMaterial({
      roughness: 1.0,
      metalness: 0.0,
      transparent: true,
      opacity: PROXY_OPACITY,
      // Translucent hulls that also wrote depth would punch holes in the real
      // voxels streaming in behind them.
      depthWrite: false,
    });

    this.mesh = new InstancedMesh2(this.geometry, this.material, {
      capacity: Math.max(1, occupiedSlots.length),
      renderer,
    });
    this.mesh.name = "proxy-cloud";
    // Big translucent boxes, drawn after the opaque voxels.
    this.mesh.renderOrder = 1;

    const center = new THREE.Vector3();
    const color = new THREE.Color();
    const chunkSize = manifest.chunkWorldSize;

    this.mesh.addInstances(occupiedSlots.length, (instance, index) => {
      const chunkId = occupiedSlots[index];
      this.instanceByChunkId.set(chunkId, instance.id);

      manifest.chunkCenterWorld(chunkId, center);
      instance.position.copy(center);

      // Denser chunks get fatter cubes, so the coarse view already reads as
      // the shape of the embedding rather than a uniform lattice.
      const density = Math.min(1, data.densityLog2[chunkId] / PROXY_DENSITY_LOG2_MAX);
      instance.scale.setScalar(chunkSize * (PROXY_MIN_FILL + (PROXY_MAX_FILL - PROXY_MIN_FILL) * density));

      // proxy.bin stores display-referred sRGB bytes; three's working space is
      // linear, so convert rather than assigning the raw bytes.
      color.setRGB(
        data.colorRgb[chunkId * 3] / 255,
        data.colorRgb[chunkId * 3 + 1] / 255,
        data.colorRgb[chunkId * 3 + 2] / 255,
        THREE.SRGBColorSpace,
      );
      instance.color = color;
    });

    this.mesh.computeBVH();
  }

  get instanceCount(): number {
    return this.mesh.instancesCount;
  }

  /** Hides/reveals a slot's coarse cube as its real chunk streams in or out. */
  setChunkResident(chunkId: number, resident: boolean): void {
    const instanceId = this.instanceByChunkId.get(chunkId);
    if (instanceId === undefined) return;
    this.mesh.setVisibilityAt(instanceId, !resident);
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.dispose();
    this.geometry.dispose();
    this.material.dispose();
  }
}

/** Fetches and builds the proxy cloud for a manifest. */
export async function loadProxyCloud(
  manifest: Manifest,
  renderer: THREE.WebGLRenderer,
  signal?: AbortSignal,
): Promise<ProxyCloud> {
  const buffer = await fetchArrayBuffer(manifest.url(manifest.raw.proxy.path), signal);
  const data = parseProxy(buffer);
  if (data.chunksPerAxis !== manifest.chunksPerAxis) {
    throw new Error(
      `proxy.bin chunks_per_axis=${data.chunksPerAxis} disagrees with manifest ${manifest.chunksPerAxis}`,
    );
  }
  return new ProxyCloud(manifest, data, renderer);
}
