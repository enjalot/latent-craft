import { fetchArrayBuffer } from "../net/fetchTyped.ts";
import type { Manifest } from "./Manifest.ts";

const RECORD_BYTES = 8;

/**
 * Decoded `row_to_voxel.bin` — whole-dataset, dense by `row_id`, 8B/record:
 *
 *   chunk_id u32 | local_voxel_id u16 | reserved u16   (all little-endian)
 *
 * This is the ONLY bridge from a `row_id` to a place in the 3D world, and it
 * exists precisely because the 2D and 3D UMAP fits are independent
 * optimizations rather than one fit with an axis dropped — there is no
 * coordinate transform between the two spaces, so every 2D↔3D interaction
 * (minimap flashlight, click-to-teleport) has to route through this table.
 * See `pipeline/src/lsvoxel/chunkpack/row_to_voxel.py`, which writes it.
 */
export interface RowToVoxel {
  /** chunkId[row_id] — always an *occupied* chunk (every point lands in one). */
  chunkId: Uint32Array;
  /** localVoxelId[row_id] — 0..voxels_per_chunk^3-1, the atlas tile index too. */
  localVoxelId: Uint16Array;
}

/**
 * Every field in this table happens to be 4-byte-aligned relative to the
 * buffer start (the record is 8 bytes and `chunk_id` sits at offset 0), so
 * unlike `point_index.bin` — whose `local_idx` is at a 2-byte offset and
 * therefore needs a `DataView` — this can be read through a plain
 * `Uint32Array` view: word `2i` is the chunk_id, word `2i+1` packs
 * `local_voxel_id` in its low 16 bits and `reserved` in its high 16.
 */
export function parseRowToVoxel(buffer: ArrayBuffer): RowToVoxel {
  if (buffer.byteLength % RECORD_BYTES !== 0) {
    throw new Error(
      `row_to_voxel.bin: size ${buffer.byteLength}B isn't a multiple of ${RECORD_BYTES}B`,
    );
  }
  const words = new Uint32Array(buffer);
  const n = words.length / 2;
  const chunkId = new Uint32Array(n);
  const localVoxelId = new Uint16Array(n);
  for (let i = 0; i < n; i++) {
    chunkId[i] = words[i * 2];
    localVoxelId[i] = words[i * 2 + 1] & 0xffff;
  }
  return { chunkId, localVoxelId };
}

/** Fetches and parses `row_to_voxel.bin` for a loaded chunk-pack manifest. */
export async function loadRowToVoxel(
  manifest: Manifest,
  signal?: AbortSignal,
): Promise<RowToVoxel> {
  const buffer = await fetchArrayBuffer(manifest.url(manifest.raw.row_to_voxel.path), signal);
  const table = parseRowToVoxel(buffer);
  if (table.chunkId.length !== manifest.totalPoints) {
    throw new Error(
      `row_to_voxel.bin has ${table.chunkId.length} records, manifest says ${manifest.totalPoints} points`,
    );
  }
  return table;
}
