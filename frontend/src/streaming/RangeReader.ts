import { WeightedLruCache } from "../utils/WeightedLruCache.ts";

/** Bounded, shared page cache. No 200 fallback: ignoring Range must not download a corpus. */
export class RangeReader {
  readonly cache = new WeightedLruCache<string, ArrayBuffer>({
    maxEntries: 512, maxWeight: 16 * 1024 * 1024, weightOf: b => b.byteLength,
  });
  private readonly pending = new Map<string, Promise<ArrayBuffer>>();
  private active = 0;
  private readonly queue: (() => void)[] = [];
  private readonly lifetime = new AbortController();
  transferred = 0;

  async read(url: string, offset: number, length: number, size: number): Promise<ArrayBuffer> {
    if (![offset, length, size].every(Number.isSafeInteger) || offset < 0 || length <= 0 ||
        length > 1024 * 1024 || offset + length > size) throw new Error("Invalid byte range");
    const key = `${url}:${offset}:${length}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    const existing = this.pending.get(key);
    if (existing) return existing;
    if (this.pending.size >= 128) throw new Error("Range request queue full; retry when idle");
    const request = this.fetch(url, offset, length, size).then(buffer => {
      this.cache.set(key, buffer);
      return buffer;
    }).finally(() => this.pending.delete(key));
    this.pending.set(key, request);
    return request;
  }

  private async fetch(url: string, offset: number, length: number, size: number): Promise<ArrayBuffer> {
    if (this.active >= 6) await new Promise<void>(resolve => this.queue.push(resolve));
    else this.active++;
    try {
      this.lifetime.signal.throwIfAborted();
      const response = await fetch(url, {
        headers: { Range: `bytes=${offset}-${offset + length - 1}` }, signal: this.lifetime.signal,
      });
      if (response.status !== 206 || response.headers.get("Content-Range") !==
          `bytes ${offset}-${offset + length - 1}/${size}` ||
          Number(response.headers.get("Content-Length")) !== length) {
        await response.body?.cancel();
        throw new Error(`Invalid range response (${response.status}) for ${url}`);
      }
      const bytes = new Uint8Array(length);
      const stream = response.body?.getReader();
      if (!stream) throw new Error("Missing range body");
      let written = 0;
      try {
        while (true) {
          const { value, done } = await stream.read();
          if (done) break;
          if (written + value.byteLength > length) { await stream.cancel(); throw new Error("Oversized range response"); }
          bytes.set(value, written); written += value.byteLength;
        }
      } finally { stream.releaseLock(); }
      if (written !== length) throw new Error("Truncated range response");
      this.transferred += length;
      return bytes.buffer;
    } finally {
      const resume = this.queue.shift();
      if (resume) resume(); else this.active--;
    }
  }

  dispose(): void {
    this.lifetime.abort();
    for (const resume of this.queue.splice(0)) resume();
    this.cache.clear();
  }
}

export const rangeReader = new RangeReader();

/** Fixed-width records, addressed by row ordinal without O(N) client arrays. */
export class PagedRecords {
  constructor(readonly url: string, readonly count: number, readonly stride: number,
    readonly reader = rangeReader, readonly recordsPerPage = 4096) {}

  async record(row: number): Promise<DataView> {
    if (!Number.isInteger(row) || row < 0 || row >= this.count) throw new Error(`Row ${row} out of bounds`);
    const start = Math.floor(row / this.recordsPerPage) * this.recordsPerPage;
    const length = Math.min(this.recordsPerPage, this.count - start) * this.stride;
    const buffer = await this.reader.read(this.url, start * this.stride, length, this.count * this.stride);
    return new DataView(buffer, (row - start) * this.stride, this.stride);
  }
}
