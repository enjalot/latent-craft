import { fetchArrayBuffer } from "../net/fetchTyped.ts";
import type { Manifest } from "./Manifest.ts";
import type { VoxelProxyData } from "../types.ts";

const VOXEL_PROXY_MAGIC = "LSVV";
const VOXEL_PROXY_HEADER_BYTES = 16;

/**
 * Decodes `voxel_proxy.bin` — the whole dataset's occupied voxels, each with
 * the count and mean thumbnail color its chunk's `meta.bin` carries, lifted
 * into one small always-resident file (bl-160: 14,688 records, 172 KiB) so the
 * client can draw every voxel of a chunk that is NOT streamed in as a flat
 * mean-colored block. See `pipeline/src/lsvoxel/chunkpack/voxel_proxy.py`.
 *
 * Layout (little-endian — `DataView` defaults to big-endian, so every
 * multi-byte read passes `true`):
 *
 *   header 16B: magic "LSVV" | version u16 | reserved u16 | n_voxels u32
 *               | num_voxels u16 | voxels_per_chunk u16
 *   VoxelProxyRecord[n_voxels], 12B each:
 *               chunk_id u32 | local_voxel_id u16 | count u16
 *               | color_rgb u8[3] | flags u8
 *
 * Records must be strictly ascending by `(chunk_id, local_voxel_id)`; the
 * per-chunk run table (`runStart`/`runEnd`) is built while checking that, and
 * everything downstream — hiding a chunk's run when it becomes resident,
 * resolving a raycast hit back to a voxel — leans on the order being exact.
 */
export function parseVoxelProxy(buffer: ArrayBuffer): VoxelProxyData {
  const view = new DataView(buffer);
  const magic = String.fromCharCode(
    view.getUint8(0),
    view.getUint8(1),
    view.getUint8(2),
    view.getUint8(3),
  );
  if (magic !== VOXEL_PROXY_MAGIC) {
    throw new Error(`voxel_proxy.bin: bad magic ${JSON.stringify(magic)}`);
  }
  const version = view.getUint16(4, true);
  if (version !== 1 && version !== 2) throw new Error(`voxel_proxy.bin: unsupported version ${version}`);
  const recordBytes = version === 1 ? 12 : 14;
  const nVoxels = view.getUint32(8, true);
  const numVoxels = view.getUint16(12, true);
  const voxelsPerChunk = view.getUint16(14, true);

  const expectedBytes = VOXEL_PROXY_HEADER_BYTES + nVoxels * recordBytes;
  if (buffer.byteLength !== expectedBytes) {
    throw new Error(
      `voxel_proxy.bin: size mismatch — got ${buffer.byteLength}B, header implies ${expectedBytes}B`,
    );
  }
  if (voxelsPerChunk === 0 || numVoxels % voxelsPerChunk !== 0) {
    throw new Error(
      `voxel_proxy.bin: num_voxels ${numVoxels} is not a multiple of voxels_per_chunk ${voxelsPerChunk}`,
    );
  }
  const chunksPerAxis = numVoxels / voxelsPerChunk;
  const chunkSlots = chunksPerAxis ** 3;
  const voxelsPerChunkTotal = voxelsPerChunk ** 3;

  const chunkId = new Uint32Array(nVoxels);
  const localVoxelId = new Uint16Array(nVoxels);
  const count = new Uint32Array(nVoxels);
  const colorRgb = new Uint8Array(nVoxels * 3);
  const flags = new Uint8Array(nVoxels);
  const runStart = new Int32Array(chunkSlots).fill(-1);
  const runEnd = new Int32Array(chunkSlots);

  let previousKey = -1;
  for (let i = 0; i < nVoxels; i++) {
    const base = VOXEL_PROXY_HEADER_BYTES + i * recordBytes;
    const c = view.getUint32(base, true);
    const v = view.getUint16(base + 4, true);
    if (c >= chunkSlots || v >= voxelsPerChunkTotal) {
      throw new Error(`voxel_proxy.bin: record ${i} (chunk ${c}, voxel ${v}) is out of range for the grid`);
    }
    // Composite key exact in float64: local_voxel_id < 2^16, chunk_id < 2^32.
    const key = c * 65536 + v;
    if (key <= previousKey) {
      throw new Error(`voxel_proxy.bin: record ${i} is out of (chunk_id, local_voxel_id) order or a duplicate`);
    }
    previousKey = key;

    chunkId[i] = c;
    localVoxelId[i] = v;
    count[i] = version === 1 ? view.getUint16(base + 6, true) : view.getUint32(base + 6, true);
    const colorOffset = version === 1 ? 8 : 10;
    for (let k = 0; k < 3; k++) colorRgb[i * 3 + k] = view.getUint8(base + colorOffset + k);
    flags[i] = view.getUint8(base + colorOffset + 3);

    if (runStart[c] < 0) runStart[c] = i;
    runEnd[c] = i + 1;
  }

  return { numVoxels, voxelsPerChunk, chunkId, localVoxelId, count, colorRgb, flags, runStart, runEnd };
}

/**
 * Fetches `voxel_proxy.bin` for a manifest and checks it describes exactly
 * this pack: the same grid, the record count the manifest advertises, and one
 * run per occupied chunk whose length is that chunk's `n_occupied_voxels` —
 * the property that makes "record i of the run == instance i of the chunk
 * mesh" true, which `VoxelProxyCloud` relies on to swap the two layers.
 */
export async function loadVoxelProxy(manifest: Manifest, signal?: AbortSignal): Promise<VoxelProxyData> {
  const entry = manifest.raw.voxel_proxy;
  const buffer = await fetchArrayBuffer(manifest.url(entry.path), signal);
  const data = parseVoxelProxy(buffer);

  if (data.numVoxels !== manifest.numVoxels || data.voxelsPerChunk !== manifest.voxelsPerChunk) {
    throw new Error(
      `voxel_proxy.bin grid ${data.numVoxels}/${data.voxelsPerChunk} disagrees with manifest ` +
        `${manifest.numVoxels}/${manifest.voxelsPerChunk}`,
    );
  }
  if (data.chunkId.length !== entry.n_voxels) {
    throw new Error(`voxel_proxy.bin has ${data.chunkId.length} records, manifest says ${entry.n_voxels}`);
  }
  let covered = 0;
  for (const chunk of manifest.chunks) {
    const start = data.runStart[chunk.chunk_id];
    const length = start < 0 ? 0 : data.runEnd[chunk.chunk_id] - start;
    if (length !== chunk.n_occupied_voxels) {
      throw new Error(
        `voxel_proxy.bin has ${length} records for chunk ${chunk.chunk_id}, ` +
          `manifest says ${chunk.n_occupied_voxels} occupied voxels`,
      );
    }
    covered += length;
  }
  if (covered !== data.chunkId.length) {
    throw new Error(
      `voxel_proxy.bin has ${data.chunkId.length - covered} records in chunks the manifest omits`,
    );
  }
  return data;
}
