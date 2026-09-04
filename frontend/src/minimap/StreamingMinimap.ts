import { MinimapPack } from "./Manifest.ts";
import { fetchJson } from "../net/fetchTyped.ts";
import { PagedRecords, rangeReader } from "../streaming/RangeReader.ts";
import type { Manifest } from "../streaming/Manifest.ts";
import type { MinimapManifestJson } from "../types.ts";
import { WeightedLruCache } from "../utils/WeightedLruCache.ts";

type Page = [number, number, number, number, number, number];
interface SpatialIndex { version: number; count: number; file: string; pages: Page[] }
interface Row { x: number; y: number; row: number; chunk: number; local: number; corpus: number }

export function pageDistanceSquared(page: Page, x: number, y: number): number {
  const dx = Math.max(page[2] - x, 0, x - page[4]);
  const dy = Math.max(page[3] - y, 0, y - page[5]);
  return dx * dx + dy * dy;
}

/** Exact nearest-point search by page bounds; capped flashlight sample. The
 * coordinate and voxel tables are never decoded into N-element JS arrays. */
export class StreamingMinimap extends MinimapPack {
  private readonly rows = new WeightedLruCache<number, Row>({ maxEntries: 16384, maxWeight: Infinity, weightOf: () => 1 });
  private query: { x: number; y: number; nearest: number; distance: number; rows: Row[] } | null = null;
  private readonly xy: PagedRecords;
  private readonly rv: PagedRecords;

  constructor(raw: MinimapManifestJson, private readonly manifest: Manifest, private readonly spatial: SpatialIndex) {
    super(raw, manifest.baseUrl);
    this.xy = new PagedRecords(manifest.url(manifest.raw.streaming!.row_xy!), this.nPoints, 4);
    this.rv = new PagedRecords(manifest.url(manifest.raw.row_to_voxel.path), this.nPoints, 8);
    if (spatial.version !== 1 || spatial.count !== this.nPoints) throw new Error("Spatial index mismatch");
    let end = 0;
    for (const page of spatial.pages) {
      if (page.length !== 6 || !page.every(Number.isSafeInteger) || page[0] !== end || page[1] < 1 || page[1] > 4096 ||
        page[2] < 0 || page[3] < 0 || page[4] > 65535 || page[5] > 65535 || page[2] > page[4] || page[3] > page[5])
        throw new Error("Invalid spatial page bounds");
      end += page[1];
    }
    if (end !== this.nPoints) throw new Error("Spatial pages do not cover the points table");
  }

  static async load(manifest: Manifest, signal?: AbortSignal) {
    const refs = manifest.raw.streaming!;
    const [raw, spatial] = await Promise.all([
      fetchJson<MinimapManifestJson>(manifest.url(refs.minimap_base!), signal),
      fetchJson<SpatialIndex>(manifest.url(refs.spatial!), signal),
    ]);
    return new StreamingMinimap(raw, manifest, spatial);
  }

  override ensureRow = async (row: number): Promise<void> => {
    if (this.rows.get(row)) return;
    const [xy, rv] = await Promise.all([this.xy.record(row), this.rv.record(row)]);
    this.rows.set(row, { row, x: xy.getUint16(0, true), y: xy.getUint16(2, true),
      chunk: rv.getUint32(0, true), local: rv.getUint16(4, true), corpus: -1 });
  };
  override rowVoxel = (row: number) => this.rows.get(row);
  override hasRow(row: number) { return this.rows.peek(row) !== undefined; }
  override rowQx(row: number) { return this.rows.peek(row)?.x ?? NaN; }
  override rowQy(row: number) { return this.rows.peek(row)?.y ?? NaN; }
  override rowCorpusName(row: number) { return this.corpusNames[this.rows.peek(row)?.corpus ?? -1]; }

  override prepareQ = async (x: number, y: number, radius: number, signal?: AbortSignal): Promise<void> => {
    const pages = this.spatial.pages.map(page => ({ page, bound: pageDistanceSquared(page, x, y) }))
      .sort((a, b) => a.bound - b.bound);
    let distance2 = Infinity, nearest = -1, sampledPages = 0;
    const sample: Row[] = [];
    let best: Row | null = null;
    // Fetch the small preview working set together; no sequential RTT per sample page.
    await Promise.all(pages.slice(0, radius > 0 ? 4 : 1).map(({ page }) =>
      rangeReader.read(this.manifest.url(this.spatial.file), page[0] * 16, page[1] * 16, this.spatial.count * 16)));
    for (const { page, bound } of pages) {
      signal?.throwIfAborted();
      const sampleNeeded = bound <= radius * radius && sample.length < 8192 && sampledPages < 4;
      if (bound >= distance2 && !sampleNeeded) break;
      const buffer = await rangeReader.read(this.manifest.url(this.spatial.file), page[0] * 16, page[1] * 16, this.spatial.count * 16);
      signal?.throwIfAborted();
      const view = new DataView(buffer);
      sampledPages++;
      for (let i = 0; i < page[1]; i++) {
        const off = i * 16;
        const px = view.getUint16(off, true), py = view.getUint16(off + 2, true);
        const d2 = (px - x) ** 2 + (py - y) ** 2;
        if (d2 >= distance2 && (!sampleNeeded || d2 > radius * radius || sample.length >= 8192)) continue;
        const row: Row = { x: px, y: py, row: view.getUint32(off + 4, true), chunk: view.getUint32(off + 8, true), local: view.getUint16(off + 12, true), corpus: view.getUint8(off + 14) };
        if (d2 < distance2) { best = row; nearest = row.row; distance2 = d2; }
        if (d2 <= radius * radius && sample.length < 8192) sample.push(row);
      }
    }
    signal?.throwIfAborted();
    for (const row of sample) this.rows.set(row.row, row);
    if (best) this.rows.set(best.row, best);
    this.query = { x, y, nearest, distance: Math.sqrt(distance2), rows: sample };
  };
  override nearestRow(x: number, y: number) {
    return this.query?.x === x && this.query.y === y
      ? { rowId: this.query.nearest, distanceQ: this.query.distance }
      : { rowId: -1, distanceQ: Infinity };
  }
  override collectRowsNear(x: number, y: number, _radius: number, out: Uint32Array) {
    if (this.query?.x !== x || this.query.y !== y) return 0;
    const count = Math.min(out.length, this.query.rows.length);
    for (let i = 0; i < count; i++) out[i] = this.query.rows[i].row;
    return count;
  }
}
