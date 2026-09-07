import { beforeEach, describe, expect, it, vi } from "vitest";
const data = vi.hoisted(() => ({ bytes: new Uint8Array(100), read: vi.fn() }));
vi.mock("../config.ts", () => ({ CHUNK_SERVER_ORIGIN: "https://cdn.test", POINT_META_CACHE_MAX_ROWS: 10,
  DATASETS: { bl: { pointsId: "bl", pointMetaFile: { path: "/meta.bin", rows: 2, bytes: 100 } } },
  resolvePointMetaUrl: () => "/legacy" }));
vi.mock("./RangeReader.ts", () => ({ rangeReader: { read: data.read } }));
beforeEach(() => {
  vi.resetModules(); data.bytes = new Uint8Array(100); data.read.mockReset();
  const header = new DataView(data.bytes.buffer);
  header.setUint32(0, 0x4d56534c, true); header.setUint16(4, 1, true); header.setUint32(8, 2, true);
  header.setUint32(12, 32, true); header.setBigUint64(16, 56n, true); header.setBigUint64(24, 44n, true);
  const url = new TextEncoder().encode("http://images.test/original.jpg");
  header.setUint16(36, url.length, true); header.setUint16(38, 640, true); header.setUint16(40, 480, true);
  data.bytes.set(url, 56);
  data.read.mockImplementation(async (_url: string, start: number, length: number) => {
    if (start < 0 || start + length > data.bytes.length) throw new Error("Out of bounds");
    return data.bytes.buffer.slice(start, start + length);
  });
});
describe("static point metadata", () => {
  it("reads only header, row, and original URL; caches definitive answers", async () => {
    const { fetchPointMeta } = await import("./PointMeta.ts");
    expect(await fetchPointMeta("bl", 0)).toEqual({ rowId: 0, url: "https://images.test/original.jpg", width: 640, height: 480 });
    expect(data.read).toHaveBeenCalledTimes(3);
    await fetchPointMeta("bl", 0); expect(data.read).toHaveBeenCalledTimes(3);
    expect(await fetchPointMeta("bl", 1)).toEqual({ rowId: 1, url: null, width: 0, height: 0 });
  });
  it("rejects out-of-range identities without reads", async () => {
    const { fetchPointMeta } = await import("./PointMeta.ts");
    for (const id of [-1, 2, NaN, 0.5]) expect(await fetchPointMeta("bl", id)).toBeNull();
    expect(data.read).not.toHaveBeenCalled();
  });
  it("does not cache corruption or cancelled reads as missing originals", async () => {
    const { fetchPointMeta } = await import("./PointMeta.ts");
    data.bytes[0] = 0;
    expect(await fetchPointMeta("bl", 0)).toBeUndefined();
    data.bytes[0] = 0x4c;
    const controller = new AbortController(); controller.abort();
    expect(await fetchPointMeta("bl", 0, controller.signal)).toBeUndefined();
    expect((await fetchPointMeta("bl", 0))?.url).toBe("https://images.test/original.jpg");
  });
});
