import type { Manifest } from "../streaming/Manifest.ts";

export type FilterQuery = { type?: string; minYear?: number; maxYear?: number; includeUnknown?: boolean; book?: string };
export interface ImageDetail {
  row: number; identity: string; title: string; provenance: string;
  fields: { label: string; value: string }[]; links: { label: string; url: string }[]; filter?: FilterQuery;
}
export interface MetadataSchema {
  identity: string; rows: number; note: string;
  fields: ({ key: string; label: string } & ({ kind: "category"; options: string[] } |
    { kind: "range"; min: number; max: number } | { kind: "lookup" }))[];
}

export class MetadataUnavailable extends Error {
  constructor(readonly status: number) {
    super(status === 429 ? "Metadata is busy. Please try again in a moment." : `Metadata unavailable (${status}). Map and inventory still work.`);
  }
}

function pause(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal!.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

/** Retry only temporary admission failures, never validation errors or forever. */
export async function fetchMetadata(url: string, options: RequestInit = {}): Promise<Response> {
  const signal = options.signal ?? undefined;
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    const response = await fetch(url, options);
    if (response.status !== 429 || attempt === 2) return response;
    const seconds = Number(response.headers.get("Retry-After"));
    await response.body?.cancel();
    await pause(seconds > 0 && Number.isFinite(seconds) ? Math.min(seconds * 1000, 2000) : 250 * 2 ** attempt, signal);
  }
}

/** Immutable exact match snapshot. No per-image strings or full point table. */
export class MatchSnapshot {
  readonly counts = new Map<number, Map<number, number>>();
  readonly chunkTotals = new Map<number, number>();
  readonly bits: Uint8Array;
  readonly total: number;
  readonly rows: number;
  constructor(buffer: ArrayBuffer, identity: string, rows: number, chunks: number, vpc: number) {
    const data = new DataView(buffer);
    if (buffer.byteLength < 64 || data.getUint32(0, true) !== 0x464d434c || data.getUint32(52, true) !== 1)
      throw new Error("Invalid metadata filter format");
    const hash = [...new Uint8Array(buffer, 16, 32)].map(n => n.toString(16).padStart(2, "0")).join("");
    this.rows = data.getUint32(4, true); this.total = data.getUint32(8, true);
    const occupied = data.getUint32(12, true), size = data.getUint32(48, true);
    if (hash !== identity || this.rows !== rows || this.total > rows || size !== Math.ceil(rows / 8) ||
      occupied > Math.min(rows, chunks * vpc ** 3) || buffer.byteLength !== 64 + size + occupied * 12)
      throw new Error("Metadata filter belongs to another map or is truncated");
    this.bits = new Uint8Array(buffer, 64, size);
    let sum = 0, previous = -1, popcount = 0;
    for (const byte of this.bits) { let n = byte; while (n) { n &= n - 1; popcount++; } }
    if (rows % 8 && (this.bits[size - 1] >> (rows % 8))) throw new Error("Invalid match mask padding");
    for (let i = 0; i < occupied; i++) {
      const offset = 64 + size + i * 12;
      const chunk = data.getUint32(offset, true), local = data.getUint32(offset + 4, true), count = data.getUint32(offset + 8, true);
      const key = chunk * vpc ** 3 + local;
      if (chunk >= chunks || local >= vpc ** 3 || count < 1 || key <= previous) throw new Error("Invalid matching voxel counts");
      previous = key; sum += count;
      if (!this.counts.has(chunk)) this.counts.set(chunk, new Map());
      this.counts.get(chunk)!.set(local, count);
      this.chunkTotals.set(chunk, (this.chunkTotals.get(chunk) ?? 0) + count);
    }
    if (sum !== this.total || popcount !== this.total) throw new Error("Match mask and counts disagree");
  }
  matches(row: number): boolean { return Number.isInteger(row) && row >= 0 && row < this.rows && !!(this.bits[row >> 3] & (1 << (row & 7))); }
  count(chunk: number, local: number): number { return this.counts.get(chunk)?.get(local) ?? 0; }
  cell(chunk: number, origin: number, step: number, vpc: number): { total: number; max: number; local: number } {
    let total = 0, max = 0, local = origin;
    for (let z = 0; z < step; z++) for (let y = 0; y < step; y++) for (let x = 0; x < step; x++) {
      const id = origin + x + y * vpc + z * vpc * vpc, count = this.count(chunk, id);
      total += count; if (count > max) { max = count; local = id; }
    }
    return { total, max, local };
  }
}

export class MetadataClient {
  private readonly details = new Map<number, ImageDetail>();
  constructor(readonly endpoint: string, private readonly manifest: Manifest) {}
  private async json(path: string, signal?: AbortSignal): Promise<unknown> {
    const response = await fetchMetadata(`${this.endpoint}${path}`, { signal });
    if (!response.ok) throw new MetadataUnavailable(response.status);
    return response.json();
  }
  async schema(signal?: AbortSignal): Promise<MetadataSchema> {
    const schema = await this.json("/schema", signal) as MetadataSchema;
    if (schema.identity !== this.manifest.raw.row_to_voxel.sha256 || schema.rows !== this.manifest.totalPoints)
      throw new Error("Metadata is for a different map release");
    return schema;
  }
  async detail(row: number, signal?: AbortSignal): Promise<ImageDetail> {
    signal?.throwIfAborted();
    const cached = this.details.get(row);
    if (cached) { this.details.delete(row); this.details.set(row, cached); return cached; }
    const detail = await this.json(`/rows/${row}`, signal) as ImageDetail;
    if (detail.row !== row || detail.identity !== this.manifest.raw.row_to_voxel.sha256 ||
      typeof detail.title !== "string" || !Array.isArray(detail.fields) || !Array.isArray(detail.links)) throw new Error("Invalid image metadata identity");
    this.details.set(row, detail);
    while (this.details.size > 128) this.details.delete(this.details.keys().next().value!);
    return detail;
  }
  async books(query: string, signal?: AbortSignal): Promise<{ id: string; title: string }[]> {
    return await this.json(`/books?q=${encodeURIComponent(query)}`, signal) as { id: string; title: string }[];
  }
  async filter(query: FilterQuery, signal?: AbortSignal): Promise<MatchSnapshot> {
    const response = await fetchMetadata(`${this.endpoint}/filter`, { method: "POST", signal,
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(query) });
    if (!response.ok) {
      if (response.status === 429 || response.status === 503) throw new MetadataUnavailable(response.status);
      const error = await response.json(); throw new Error(error.detail || error.error || "Filter failed");
    }
    const buffer = await response.arrayBuffer();
    return new MatchSnapshot(buffer, this.manifest.raw.row_to_voxel.sha256!, this.manifest.totalPoints,
      this.manifest.chunksPerAxis ** 3, this.manifest.voxelsPerChunk);
  }
}
