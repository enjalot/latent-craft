import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const range = vi.hoisted(() => ({ read: vi.fn(), record: vi.fn() }));
vi.mock("./RangeReader.ts", () => ({ rangeReader: { read: range.read }, PagedRecords: class {
  record(id: number) { return range.record(id); }
} }));
beforeEach(() => {
  vi.resetModules(); vi.stubEnv("VITE_THUMB_PACK_URL", "https://cdn.test/thumbs/bl/manifest.json");
  vi.stubGlobal("location", { href: "https://demo.test/" });
  range.read.mockReset(); range.record.mockReset();
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
