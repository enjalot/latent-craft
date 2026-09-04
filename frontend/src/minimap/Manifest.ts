import { fetchArrayBuffer, fetchJson } from "../net/fetchTyped.ts";
import type { MinimapDensityIndexJson, MinimapManifestJson } from "../types.ts";

/** `quantization.levels` from the pack — the u16 coordinate space is `[0, 65535]`. */
const QUANT_LEVELS = 65536;

const POINT_RECORD_BYTES = 8;

/** `packed = corpus << 28 | row_id` — 28 bits of row_id, 4 bits of corpus. */
const ROW_ID_MASK = 0x0fffffff;

/**
 * Bucket grid resolution for the spatial queries below: `bin = q >> 8`, i.e.
 * 256x256 buckets, each spanning 256 q units.
 *
 * This is the same "bin index is a right-shift of the stored u16" trick the
 * pack's own tile pyramid uses (`bin_z = q >> (16 - (8 + z))`), so a bucket
 * here is exactly one z0 density bin — convenient, and it makes the grid
 * derivable from nothing but the quantization contract.
 */
const BIN_SHIFT = 8;
const BIN_SIDE = 1 << (16 - BIN_SHIFT);
const BIN_SPAN_Q = 1 << BIN_SHIFT;

/**
 * The 2D minimap pack: its manifest, plus the row_id-indexed position lookup
 * built once from `points/xy_id.bin`.
 *
 * ## Why this is not a coordinate transform of the 3D world
 *
 * The minimap comes from an INDEPENDENT 2-component UMAP fit of the same
 * points table that the 3D voxel world's 3-component fit came from. It is not
 * that fit with an axis dropped, so **there is no linear (or any other closed
 * form) map between a 3D world position and a 2D minimap position.** Every
 * cross-reference between the two views has to go through the one thing they
 * genuinely share — `row_id`:
 *
 *   3D voxel → row_id      via that voxel's `repr_row_id` (already in meta.bin)
 *   row_id   → 2D position via `rowQx`/`rowQy` here
 *   2D click → row_id      via `nearestRow`/`collectRowsNear` here
 *   row_id   → 3D voxel    via `row_to_voxel.bin` (`streaming/RowToVoxel.ts`)
 *
 * ## Coordinate spaces in play
 *
 * - **raw**: the 2D fit's own UMAP units, bounded by `frame.extent`
 *   (`[x0, x1, y0, y1]`). Only surfaced for debug readouts.
 * - **quantized (`q`)**: u16 per axis, as stored in `xy_id.bin`, produced by
 *   the pipeline as `qx = floor((x - x0) / (x1 - x0) * 65536)` and — note the
 *   inversion — `qy = floor((y1 - y) / (y1 - y0) * 65536)`, both clamped to
 *   `[0, 65535]`. So `q` is already y-down, screen-style. This is the space
 *   all lookups/queries below work in.
 * - **unit**: `q / 65536` ∈ `[0, 1)`. The density tile pyramid tiles this
 *   space exactly at every zoom (bin index at zoom z is `q >> (16 - (8 + z))`,
 *   over `256 * 2^z` bins per side), which is what makes "panel pixel ↔ q" a
 *   plain linear scale with no per-zoom special-casing.
 */
export class MinimapPack {
  readonly raw: MinimapManifestJson;
  readonly baseUrl: string;

  /** `[x0, x1, y0, y1]` in the 2D fit's raw units. */
  readonly extent: [number, number, number, number];
  readonly nPoints: number;
  readonly maxZoom: number;
  readonly tileBins: number;

  /** qx[row_id] / qy[row_id] — the whole point of this class. */
  readonly qx: Uint16Array;
  readonly qy: Uint16Array;
  /** corpus[row_id] (BL: the subset code), unpacked from `packed`'s top bits. */
  readonly corpus: Uint8Array;
  /** corpus code → name, from `corpus_codes`. */
  readonly corpusNames: string[];

  /** How many distinct row_ids `xy_id.bin` actually filled in. */
  readonly rowsFilled: number;

  /**
   * CSR bucket grid over quantized space: `binRows[binStart[b] … binStart[b+1])`
   * are the row_ids in bucket `b` (`b = binY * BIN_SIDE + binX`).
   *
   * This was NOT the first implementation. A plain linear scan of all 1.08M
   * positions is the obvious thing and is what the flashlight shipped with
   * first — but measured in Chromium it costs **10.6 ms per query**, and the
   * flashlight runs one query per frame while the cursor is over the panel,
   * which is most of a 60 Hz frame budget spent on a hover effect. The grid
   * brings the same query to well under a millisecond for a one-time ~4.5 MB
   * of index (a Uint32 per point plus a 65537-entry offset table) and ~20 ms
   * of build, both of which sit alongside the 8.6 MB of positions the pack
   * already loads.
   */
  private readonly binStart: Uint32Array;
  private readonly binRows: Uint32Array;

  constructor(raw: MinimapManifestJson, baseUrl: string, points: ArrayBuffer) {
    this.raw = raw;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.extent = raw.frame.extent;
    this.nPoints = raw.n_points;
    this.maxZoom = raw.tiles.max_zoom;
    this.tileBins = raw.tiles.tile_bins;

    if (raw.quantization.levels !== QUANT_LEVELS) {
      throw new Error(
        `minimap manifest: quantization.levels=${raw.quantization.levels}, expected ${QUANT_LEVELS}`,
      );
    }
    if (raw.points.record_bytes !== POINT_RECORD_BYTES) {
      throw new Error(
        `minimap manifest: points.record_bytes=${raw.points.record_bytes}, expected ${POINT_RECORD_BYTES}`,
      );
    }

    this.corpusNames = [];
    for (const [code, name] of Object.entries(raw.corpus_codes)) {
      this.corpusNames[Number(code)] = name;
    }

    // `xy_id.bin` is sorted by tile/Morton order, NOT by row_id, so it has to
    // be scattered into row_id-indexed arrays rather than read as-is. Field
    // alignment: the record is 8 bytes with x/y at offsets 0/2 and `packed` at
    // offset 4, so a Uint16Array view lands x/y exactly and a Uint32Array view
    // lands `packed` at odd words — both are naturally aligned, no DataView
    // needed (contrast `streaming/PointIndex.ts`, whose u32 sits at offset 2).
    if (points.byteLength % POINT_RECORD_BYTES !== 0) {
      throw new Error(
        `xy_id.bin: size ${points.byteLength}B isn't a multiple of ${POINT_RECORD_BYTES}B`,
      );
    }
    const records = points.byteLength / POINT_RECORD_BYTES;
    if (records !== this.nPoints) {
      throw new Error(`xy_id.bin has ${records} records, manifest says ${this.nPoints} points`);
    }

    const shorts = new Uint16Array(points);
    const words = new Uint32Array(points);
    this.qx = new Uint16Array(this.nPoints);
    this.qy = new Uint16Array(this.nPoints);
    this.corpus = new Uint8Array(this.nPoints);
    const seen = new Uint8Array(this.nPoints);
    let filled = 0;
    for (let i = 0; i < records; i++) {
      const packed = words[i * 2 + 1];
      const rowId = packed & ROW_ID_MASK;
      if (rowId >= this.nPoints) {
        throw new Error(`xy_id.bin: record ${i} has out-of-range row_id ${rowId}`);
      }
      if (seen[rowId] !== 0) {
        throw new Error(`xy_id.bin: duplicate row_id ${rowId} at record ${i}`);
      }
      this.qx[rowId] = shorts[i * 4];
      this.qy[rowId] = shorts[i * 4 + 1];
      this.corpus[rowId] = packed >>> 28;
      seen[rowId] = 1;
      filled++;
    }
    this.rowsFilled = filled;

    if (filled !== this.nPoints) {
      throw new Error(`xy_id.bin filled ${filled}/${this.nPoints} row_ids`);
    }

    // Counting sort into the bucket grid: one pass to count, a prefix sum, one
    // pass to scatter.
    const cells = BIN_SIDE * BIN_SIDE;
    const binStart = new Uint32Array(cells + 1);
    for (let row = 0; row < this.nPoints; row++) {
      binStart[binIndex(this.qx[row], this.qy[row]) + 1]++;
    }
    for (let b = 0; b < cells; b++) binStart[b + 1] += binStart[b];
    const cursor = binStart.slice(0, cells);
    const binRows = new Uint32Array(this.nPoints);
    for (let row = 0; row < this.nPoints; row++) {
      binRows[cursor[binIndex(this.qx[row], this.qy[row])]++] = row;
    }
    this.binStart = binStart;
    this.binRows = binRows;

  }

  get datasetId(): string {
    return this.raw.dataset_id;
  }

  /** Absolute URL for a pack-relative path (`density/z1/0_0.png`, …). */
  url(path: string): string {
    return `${this.baseUrl}/${path.replace(/^\/+/, "")}`;
  }

  /** Fetches one zoom level's sparse tile index. */
  async densityIndex(zoom: number, signal?: AbortSignal): Promise<MinimapDensityIndexJson> {
    return await fetchJson<MinimapDensityIndexJson>(this.url(`density/z${zoom}/index.json`), signal);
  }

  // --- q ↔ unit ↔ raw --------------------------------------------------------

  /** Unit position (0..1) of a quantized coordinate, on either axis. */
  unitFromQ(q: number): number {
    return q / QUANT_LEVELS;
  }

  /** Quantized coordinate from a unit position, clamped like the pipeline's. */
  qFromUnit(u: number): number {
    const q = Math.floor(u * QUANT_LEVELS);
    return q < 0 ? 0 : q > QUANT_LEVELS - 1 ? QUANT_LEVELS - 1 : q;
  }

  /** Raw 2D-UMAP x for a quantized x — debug/readout only. */
  rawX(qx: number): number {
    const [x0, x1] = this.extent;
    return x0 + (qx / QUANT_LEVELS) * (x1 - x0);
  }

  /** Raw 2D-UMAP y for a quantized y. Note the inversion: q counts DOWN from
   * `extent[3]`, matching how the pipeline quantized it. */
  rawY(qy: number): number {
    const y0 = this.extent[2];
    const y1 = this.extent[3];
    return y1 - (qy / QUANT_LEVELS) * (y1 - y0);
  }

  // --- row_id → 2D ----------------------------------------------------------

  hasRow(rowId: number): boolean {
    return Number.isInteger(rowId) && rowId >= 0 && rowId < this.nPoints;
  }

  rowQx(rowId: number): number {
    return this.qx[rowId];
  }

  rowQy(rowId: number): number {
    return this.qy[rowId];
  }

  /** Corpus/subset name for a row, or `undefined` if the code is unmapped. */
  rowCorpusName(rowId: number): string | undefined {
    return this.corpusNames[this.corpus[rowId]];
  }

  // --- 2D → row_id ----------------------------------------------------------

  /**
   * Nearest point to a quantized position — the resolution behind
   * click-to-teleport.
   *
   * Expanding ring search over the bucket grid: scan the bucket the query
   * lands in, then each successive square ring around it, stopping as soon as
   * the best distance found beats the closest any unscanned bucket could
   * possibly be. After finishing ring `r`, an unscanned bucket is at Chebyshev
   * bucket-distance ≥ `r+1`, and the query point can sit at the far edge of
   * its own bucket, so `r * BIN_SPAN_Q` is a sound lower bound — which makes
   * this exact, not approximate. Returns `rowId: -1` for an empty pack.
   */
  nearestRow(qx: number, qy: number): { rowId: number; distanceQ: number } {
    const cx = qx >> BIN_SHIFT;
    const cy = qy >> BIN_SHIFT;
    let bestRow = -1;
    let bestD2 = Infinity;

    for (let r = 0; r < BIN_SIDE; r++) {
      const x0 = cx - r;
      const x1 = cx + r;
      const y0 = cy - r;
      const y1 = cy + r;
      for (let by = Math.max(0, y0); by <= Math.min(BIN_SIDE - 1, y1); by++) {
        // Only the ring's border: full rows at the top/bottom edges, just the
        // two end cells in between.
        const edgeRow = by === y0 || by === y1;
        for (let bx = Math.max(0, x0); bx <= Math.min(BIN_SIDE - 1, x1); bx++) {
          if (!edgeRow && bx !== x0 && bx !== x1) continue;
          const bin = by * BIN_SIDE + bx;
          const end = this.binStart[bin + 1];
          for (let i = this.binStart[bin]; i < end; i++) {
            const row = this.binRows[i];
            const dx = this.qx[row] - qx;
            const dy = this.qy[row] - qy;
            const d2 = dx * dx + dy * dy;
            if (d2 < bestD2) {
              bestD2 = d2;
              bestRow = row;
            }
          }
        }
      }
      if (bestRow >= 0) {
        const bound = r * BIN_SPAN_Q;
        if (bestD2 <= bound * bound) break;
      }
      // The ring has grown past every edge of the grid: nothing left to scan.
      if (x0 <= 0 && y0 <= 0 && x1 >= BIN_SIDE - 1 && y1 >= BIN_SIDE - 1) break;
    }

    return { rowId: bestRow, distanceQ: bestRow < 0 ? Infinity : Math.sqrt(bestD2) };
  }

  /**
   * Collects row_ids within `radiusQ` (circular, q units) of a position into
   * `out`, returning how many were written. Stops at `out.length`.
   *
   * Visits only the buckets the query circle's bounding box touches, then
   * tests the exact circle per point. Truncation at `out.length` is
   * deliberately silent: callers dedupe these down to a much smaller set of
   * distinct voxels anyway (see `interaction/MinimapBridge.ts`), which is also
   * why callers should still coalesce this to at most once per frame.
   */
  collectRowsNear(qx: number, qy: number, radiusQ: number, out: Uint32Array): number {
    const r2 = radiusQ * radiusQ;
    const capacity = out.length;
    const bx0 = Math.max(0, (qx - radiusQ) >> BIN_SHIFT);
    const bx1 = Math.min(BIN_SIDE - 1, (qx + radiusQ) >> BIN_SHIFT);
    const by0 = Math.max(0, (qy - radiusQ) >> BIN_SHIFT);
    const by1 = Math.min(BIN_SIDE - 1, (qy + radiusQ) >> BIN_SHIFT);
    let written = 0;
    for (let by = by0; by <= by1 && written < capacity; by++) {
      for (let bx = bx0; bx <= bx1 && written < capacity; bx++) {
        const bin = by * BIN_SIDE + bx;
        const end = this.binStart[bin + 1];
        for (let i = this.binStart[bin]; i < end && written < capacity; i++) {
          const row = this.binRows[i];
          const dx = this.qx[row] - qx;
          const dy = this.qy[row] - qy;
          if (dx * dx + dy * dy <= r2) out[written++] = row;
        }
      }
    }
    return written;
  }
}

/** Bucket index for a quantized position. */
function binIndex(qx: number, qy: number): number {
  return (qy >> BIN_SHIFT) * BIN_SIDE + (qx >> BIN_SHIFT);
}

/**
 * Fetches `manifest.json` + `points/xy_id.bin` from a minimap pack base URL
 * and builds the row_id-indexed position lookup.
 *
 * `xy_id.bin` is every point, not a sample — 8.6 MB for BL, which is the same
 * order as `point_index.bin`/`row_to_voxel.bin` that the app already loads
 * whole, so it's fetched in one shot rather than tile-streamed. The pack's
 * `points/lod.bin` (a density-stratified sample with a reveal-at-this-zoom
 * field) and `points/tile_index.u64` exist for a pannable/zoomable map's
 * progressive point rendering and are deliberately unused here: this minimap
 * is a small fixed-extent overview that never pans or zooms.
 */
export async function loadMinimapPack(
  baseUrl: string,
  signal?: AbortSignal,
): Promise<MinimapPack> {
  const normalized = baseUrl.replace(/\/+$/, "");
  const raw = await fetchJson<MinimapManifestJson>(`${normalized}/manifest.json`, signal);
  const points = await fetchArrayBuffer(`${normalized}/points/xy_id.bin`, signal);
  return new MinimapPack(raw, normalized, points);
}
