import { fetchArrayBuffer } from "../net/fetchTyped.ts";
import type { Manifest } from "./Manifest.ts";
import { THUMBS_BASE_PATH } from "../config.ts";

const RECORD_BYTES = 8;

/**
 * Decoded `point_index.bin` — whole-dataset, dense by `row_id`, 8B/record:
 *
 *   subset_code u8 | reserved u8 | local_idx u32 (LE) | reserved2 u16
 *
 * Lets the client resolve any `row_id` to a full-res thumbnail URL with zero
 * extra round-trip, which is what makes "mining reveals the full stack"
 * possible — a mined voxel's `point_ids` are already in memory (from
 * `meta.bin`), so the only network need per point is this table plus the
 * image itself.
 */
export interface PointIndex {
  /** subsetCode[row_id]. */
  subsetCode: Uint8Array;
  /** localIdx[row_id] — the thumbs-manifest `global_idx` within that subset. */
  localIdx: Uint32Array;
  /** `manifest.subsets` ({name: code}) inverted once, code → name. */
  subsetNames: string[];
}

/**
 * `local_idx` sits at byte offset 2 within each 8-byte record, which is not
 * 4-byte aligned relative to the buffer start (2 % 4 != 0 for every other
 * record), so — unlike `pointIds` in `ChunkLoader.parseChunkMeta` — this
 * can't be exposed as a zero-copy strided typed-array view. Read field by
 * field through a `DataView` into two parallel dense arrays instead; at ~8.6
 * MB / 1.08M points for BL this is a one-time few-millisecond pass.
 */
export function parsePointIndex(buffer: ArrayBuffer, subsets: Record<string, number>): PointIndex {
  const n = Math.floor(buffer.byteLength / RECORD_BYTES);
  if (n * RECORD_BYTES !== buffer.byteLength) {
    throw new Error(
      `point_index.bin: size ${buffer.byteLength}B isn't a multiple of ${RECORD_BYTES}B`,
    );
  }
  const view = new DataView(buffer);
  const subsetCode = new Uint8Array(n);
  const localIdx = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    const base = i * RECORD_BYTES;
    subsetCode[i] = view.getUint8(base);
    localIdx[i] = view.getUint32(base + 2, true);
  }

  const subsetNames: string[] = [];
  for (const [name, code] of Object.entries(subsets)) subsetNames[code] = name;

  return { subsetCode, localIdx, subsetNames };
}

/** Fetches and parses `point_index.bin` for a loaded manifest. */
export async function loadPointIndex(manifest: Manifest, signal?: AbortSignal): Promise<PointIndex> {
  const buffer = await fetchArrayBuffer(manifest.url(manifest.raw.point_index.path), signal);
  return parsePointIndex(buffer, manifest.raw.subsets);
}

/**
 * Resolves one `row_id` to its full-resolution thumbnail URL, matching
 * `manifest.thumb_url_template` (`{subset_name}/{local_idx:08d}.webp`) but
 * with the `/thumbs/bl/` prefix hardcoded per `config.ts#THUMBS_BASE_PATH`
 * rather than derived from the active dataset key — see that constant's
 * doc comment for why. Returns `null` for an out-of-range or unmapped
 * row_id rather than throwing, since a caller may race a stack against a
 * still-loading `PointIndex`.
 */
export function resolveThumbUrl(index: PointIndex, rowId: number): string | null {
  if (rowId < 0 || rowId >= index.subsetCode.length) return null;
  const subsetName = index.subsetNames[index.subsetCode[rowId]];
  if (!subsetName) return null;
  const localIdx = index.localIdx[rowId];
  return `${THUMBS_BASE_PATH}/${subsetName}/${String(localIdx).padStart(8, "0")}.webp`;
}
