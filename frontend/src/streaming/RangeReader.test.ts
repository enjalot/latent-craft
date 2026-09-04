import { afterEach, describe, expect, it, vi } from "vitest";
import { PagedRecords, RangeReader } from "./RangeReader.ts";

afterEach(() => vi.unstubAllGlobals());
describe("bounded byte ranges", () => {
  it("addresses row 99,999,999 beyond signed 32-bit offsets, coalescing one page", async () => {
    const reader = new RangeReader();
    const fetcher = vi.fn(async (_url: string, options: RequestInit) => {
      const [start, end] = (options.headers as Record<string, string>).Range.slice(6).split('-').map(Number);
      return new Response(new Uint8Array(end - start + 1), { status: 206, headers: {
        'Content-Range': `bytes ${start}-${end}/3200000000`, 'Content-Length': String(end - start + 1),
      } });
    });
    vi.stubGlobal('fetch', fetcher);
    const records = new PagedRecords('/huge.bin', 100_000_000, 32, reader);
    await Promise.all([records.record(99_999_999), records.record(99_999_998)]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(reader.transferred).toBeLessThanOrEqual(4096 * 32);
    expect(reader.cache.weight).toBe(reader.transferred);
    reader.dispose();
  });
  it("rejects servers ignoring Range without consuming the body", async () => {
    const cancel = vi.fn();
    const arrayBuffer = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 200, headers: new Headers(), body: { cancel }, arrayBuffer })));
    const reader = new RangeReader();
    await expect(reader.read('/whole-corpus.bin', 0, 16, 800_000_000)).rejects.toThrow('Invalid range');
    expect(cancel).toHaveBeenCalled(); expect(arrayBuffer).not.toHaveBeenCalled();
    reader.dispose();
  });
  it("rejects incorrect Content-Range and out-of-bounds requests", async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(4), { status: 206, headers: {
      'Content-Range': 'bytes 4-7/8', 'Content-Length': '4',
    } })));
    const reader = new RangeReader();
    await expect(reader.read('/bad.bin', 0, 4, 8)).rejects.toThrow('Invalid range');
    await expect(reader.read('/bad.bin', 7, 2, 8)).rejects.toThrow('Invalid byte range');
    reader.dispose();
  });
});
