import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const range = vi.hoisted(() => ({ read: vi.fn(), record: vi.fn() }));
vi.mock("./RangeReader.ts", () => ({ rangeReader: { read: range.read }, PagedRecords: class {
  record(id: number) { return range.record(id); }
} }));
beforeEach(() => {
  vi.resetModules(); vi.stubEnv("VITE_THUMB_PACK_URL", "https://cdn.test/thumbs/bl/manifest.json");
  vi.stubEnv("VITE_MONET_THUMB_PACK_URL", "");
  vi.stubGlobal("location", { href: "https://demo.test/" });
  range.read.mockReset(); range.record.mockReset();
});

describe("MONET source-shard CDN ranges", () => {
  function monet(start = 7n, end = 19n) {
    vi.stubEnv("VITE_MONET_THUMB_PACK_URL", "https://cdn.test/monet/manifest.json");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ version:1, encoding:"monet-u64-offsets", shards:[[2,100],[3,12345]] }))));
    const offsets = new DataView(new ArrayBuffer(16)); offsets.setBigUint64(0,start,true); offsets.setBigUint64(8,end,true);
    range.read.mockResolvedValueOnce(offsets.buffer).mockResolvedValue(new ArrayBuffer(Number(end - start)));
  }
  it("decodes packed source references without transferring a whole offset table or blob", async () => {
    monet(); const { fetchThumbnailBlob } = await import("./ThumbnailSource.ts");
    const image = await fetchThumbnailBlob("/thumbs/monet/65538.webp");
    expect(range.read.mock.calls).toEqual([
      ["https://cdn.test/monet/shards/0001.offsets.u64",16,16,32],
      ["https://cdn.test/monet/shards/0001.blob",7,12,12345],
    ]);
    expect(image.size).toBe(12); expect(image.type).toBe("image/webp");
    expect(range.record).not.toHaveBeenCalled();
  });
  it("rejects absent rows and failed source decodes before reading image bytes", async () => {
    monet(7n,7n); const { fetchThumbnailBlob } = await import("./ThumbnailSource.ts");
    await expect(fetchThumbnailBlob("/thumbs/monet/65539.webp")).rejects.toThrow("outside");
    expect(range.read).not.toHaveBeenCalled();
    await expect(fetchThumbnailBlob("/thumbs/monet/65538.webp")).rejects.toThrow("span");
    expect(range.read).toHaveBeenCalledTimes(1);
  });
  it("does not issue a blob request if the hold ends while resolving its extent", async () => {
    monet(); const abort = new AbortController();
    range.read.mockReset().mockImplementationOnce(async () => { abort.abort(); return new ArrayBuffer(16); });
    const { fetchThumbnailBlob } = await import("./ThumbnailSource.ts");
    await expect(fetchThumbnailBlob("/thumbs/monet/65538.webp", abort.signal)).rejects.toThrow();
    expect(range.read).toHaveBeenCalledTimes(1);
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
function manifest(count = 2049) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ version: 1, shard_rows: 2048,
    subsets: { plates: { count, sizes: [12345, 100] } } }))));
  const record = new DataView(new ArrayBuffer(8)); record.setUint32(0, 7, true); record.setUint32(4, 12, true);
  range.record.mockResolvedValue(record); range.read.mockResolvedValue(new ArrayBuffer(12));
}
describe("packed thumbnails", () => {
  it("fetches only the addressed image across a shard boundary", async () => {
    manifest(); const { fetchThumbnailBlob } = await import("./ThumbnailSource.ts");
    const blob = await fetchThumbnailBlob("/thumbs/bl/plates/00002048.webp");
    expect(range.record).toHaveBeenCalledWith(2048);
    expect(range.read).toHaveBeenCalledWith("https://cdn.test/thumbs/bl/plates/00001.blob", 7, 12, 100);
    expect(blob.size).toBe(12); expect(blob.type).toBe("image/webp");
  });
  it("rejects out-of-pack images before fetching a blob", async () => {
    manifest(); const { fetchThumbnailBlob } = await import("./ThumbnailSource.ts");
    await expect(fetchThumbnailBlob("/thumbs/bl/plates/00002049.webp")).rejects.toThrow();
    expect(range.read).not.toHaveBeenCalled();
  });
  it("does not start work for a cancelled request", async () => {
    manifest(); const { fetchThumbnailBlob } = await import("./ThumbnailSource.ts");
    const controller = new AbortController(); controller.abort();
    await expect(fetchThumbnailBlob("/thumbs/bl/plates/00000000.webp", controller.signal)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
