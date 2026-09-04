import { fetchArrayBuffer } from "../net/fetchTyped.ts";
import type { Manifest } from "./Manifest.ts";
import { THUMBS_BASE_PATH } from "../config.ts";
import { PagedRecords } from "./RangeReader.ts";
import { WeightedLruCache } from "../utils/WeightedLruCache.ts";

/**
 * Placeholders a chunk-pack manifest's `thumb_url_template` may use:
 *
 *   `{subset_name}`      the point's subset, decoded from `subset_code`
 *   `{local_idx}`        the point's `local_idx`, as a plain decimal
 *   `{local_idx:08d}`    the same, zero-padded to N digits
 *
 * The pipeline writes this string per dataset because datasets store their
 * thumbnails differently — BL is one file per point under a per-subset,
 * 8-digit-padded tree (`{subset_name}/{local_idx:08d}.webp`), MONET is a byte
 * range in a packed blob addressed by a single packed id
 * (`monet/{local_idx}.webp`, served by the data server's dynamic route). Both
 * are just this template plus the dataset's thumbnail base path, so onboarding
 * a dataset with a third scheme needs no frontend change.
 */
const TEMPLATE_FIELD = /\{(subset_name|local_idx)(?::0(\d+)d)?\}/g;

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
  ensure?: (row: number) => Promise<void>;
  lookup?: (row: number) => { subset: number; local: number } | undefined;
  /** subsetCode[row_id]. */
  subsetCode: Uint8Array;
  /** localIdx[row_id] — the thumbs-manifest `global_idx` within that subset. */
  localIdx: Uint32Array;
  /** `manifest.subsets` ({name: code}) inverted once, code → name. */
  subsetNames: string[];
  /** The pack's `thumb_url_template`, applied by `resolveThumbUrl`. */
  thumbUrlTemplate: string;
  /** Base URL the template's result hangs off, per the active dataset config. */
  thumbsBaseUrl: string;
}

/**
 * `local_idx` sits at byte offset 2 within each 8-byte record, which is not
 * 4-byte aligned relative to the buffer start (2 % 4 != 0 for every other
 * record), so — unlike `pointIds` in `ChunkLoader.parseChunkMeta` — this
 * can't be exposed as a zero-copy strided typed-array view. Read field by
 * field through a `DataView` into two parallel dense arrays instead; at ~8.6
 * MB / 1.08M points for BL this is a one-time few-millisecond pass.
 */
export function parsePointIndex(
  buffer: ArrayBuffer,
  subsets: Record<string, number>,
  thumbUrlTemplate: string,
  thumbsBaseUrl: string = THUMBS_BASE_PATH,
  expectedRecords?: number,
): PointIndex {
  const n = Math.floor(buffer.byteLength / RECORD_BYTES);
  if (n * RECORD_BYTES !== buffer.byteLength) {
    throw new Error(
      `point_index.bin: size ${buffer.byteLength}B isn't a multiple of ${RECORD_BYTES}B`,
    );
  }
  if (expectedRecords !== undefined && n !== expectedRecords) {
    throw new Error(`point_index.bin has ${n} records, manifest says ${expectedRecords} points`);
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

  return { subsetCode, localIdx, subsetNames, thumbUrlTemplate, thumbsBaseUrl };
}

/** Fetches and parses `point_index.bin` for a loaded manifest. */
export async function loadPointIndex(
  manifest: Manifest,
  thumbsBaseUrl?: string,
  signal?: AbortSignal,
): Promise<PointIndex> {
  if (manifest.raw.streaming) {
    const records = new PagedRecords(manifest.url(manifest.raw.point_index.path), manifest.totalPoints, 8, undefined, 256);
    const cache = new WeightedLruCache<number, { subset: number; local: number }>({
      maxEntries: 8192, maxWeight: Infinity, weightOf: () => 1,
    });
    const failed = new WeightedLruCache<number, number>({ maxEntries: 128, maxWeight: Infinity, weightOf: () => 1 });
    const subsetNames: string[] = [];
    for (const [name, code] of Object.entries(manifest.raw.subsets)) subsetNames[code] = name;
    return {
      subsetCode: new Uint8Array(0), localIdx: new Uint32Array(0), subsetNames,
      thumbUrlTemplate: manifest.raw.thumb_url_template, thumbsBaseUrl: thumbsBaseUrl ?? THUMBS_BASE_PATH,
      lookup: row => cache.get(row),
      ensure: async row => {
        if (cache.get(row)) return;
        if ((failed.get(row) ?? 0) > Date.now()) return;
        try {
          const record = await records.record(row);
          cache.set(row, { subset: record.getUint8(0), local: record.getUint32(2, true) });
          failed.delete(row);
        } catch (error) { failed.set(row, Date.now() + 2000); throw error; }
      },
    };
  }
  const buffer = await fetchArrayBuffer(manifest.url(manifest.raw.point_index.path), signal);
  return parsePointIndex(
    buffer,
    manifest.raw.subsets,
    manifest.raw.thumb_url_template,
    thumbsBaseUrl,
    manifest.totalPoints,
  );
}

/**
 * Resolves one `row_id` to its full-resolution thumbnail URL by applying the
 * pack's own `thumb_url_template` (see `TEMPLATE_FIELD` above) under the
 * dataset's thumbnail base path — so which dataset is loaded, and how its
 * thumbnails happen to be stored, is entirely a pipeline-side fact.
 *
 * Returns `null` for an out-of-range or unmapped row_id rather than throwing,
 * since a caller may race a stack against a still-loading `PointIndex`. A
 * template referencing `{subset_name}` for a point whose subset code isn't in
 * the manifest's mapping is the "unmapped" case; a template that doesn't
 * reference it (MONET's) resolves fine regardless.
 */
/**
 * The subset a `row_id` belongs to (`covers`, `plates`, `laion`,
 * `synthetic-flux-klein`, …), or `null` for an out-of-range row or a subset
 * code the manifest doesn't name. The lightbox uses it to explain a missing
 * original (`SYNTHETIC_SUBSET_PREFIX` in `config.ts`).
 */
export function resolveSubsetName(index: PointIndex, rowId: number): string | null {
  if (index.lookup) {
    const record = index.lookup(rowId);
    return record ? index.subsetNames[record.subset] ?? null : null;
  }
  if (rowId < 0 || rowId >= index.subsetCode.length) return null;
  return index.subsetNames[index.subsetCode[rowId]] ?? null;
}

export function resolveThumbUrl(index: PointIndex, rowId: number): string | null {
  const record = index.lookup?.(rowId);
  if (index.lookup && !record) return null;
  if (!index.lookup && (rowId < 0 || rowId >= index.subsetCode.length)) return null;
  const subsetName = index.subsetNames[record?.subset ?? index.subsetCode[rowId]];
  const localIdx = record?.local ?? index.localIdx[rowId];
  let unresolved = false;
  const path = index.thumbUrlTemplate.replace(TEMPLATE_FIELD, (_match, field, pad) => {
    if (field === "subset_name") {
      if (!subsetName) unresolved = true;
      return subsetName ?? "";
    }
    const digits = pad ? Number(pad) : 0;
    return digits > 0 ? String(localIdx).padStart(digits, "0") : String(localIdx);
  });
  if (unresolved) return null;
  return `${index.thumbsBaseUrl}/${path.replace(/^\/+/, "")}`;
}
