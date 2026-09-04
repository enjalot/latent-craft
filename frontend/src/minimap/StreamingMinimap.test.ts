import { afterEach, expect, it, vi } from "vitest";
import { StreamingMinimap, pageDistanceSquared } from "./StreamingMinimap.ts";
import type { MinimapManifestJson } from "../types.ts";
import type { Manifest } from "../streaming/Manifest.ts";
import { rangeReader } from "../streaming/RangeReader.ts";

afterEach(() => { vi.unstubAllGlobals(); rangeReader.cache.clear(); });

it("finds an exact nearest row in a 100M logical pack without corpus-sized arrays", async () => {
  const raw = { n_points: 100_000_000, frame: { extent: [0, 1, 0, 1] }, tiles: { max_zoom: 5, tile_bins: 256 },
    quantization: { levels: 65536 }, points: { record_bytes: 8 }, corpus_codes: {} } as MinimapManifestJson;
  const manifest = { baseUrl: '/test100m', raw: { streaming: { row_xy: 'row_xy.bin' }, row_to_voxel: { path: 'rv.bin' } }, url: (path: string) => `/test100m/${path}` } as Manifest;
  const fetcher = vi.fn(async () => {
    const buffer = new ArrayBuffer(4096 * 16), view = new DataView(buffer);
    for (let i = 1; i < 4096; i++) {
      view.setUint16(i * 16, 1000, true); view.setUint16(i * 16 + 2, 1000, true);
      view.setUint32(i * 16 + 4, i, true);
    }
    view.setUint16(0, 101, true); view.setUint16(2, 100, true);
    view.setUint32(4, 99_999_999, true); view.setUint32(8, 999, true); view.setUint16(12, 4095, true);
    return new Response(buffer, { status: 206, headers: { 'Content-Range': 'bytes 0-65535/1600000000', 'Content-Length': '65536' } });
  });
  vi.stubGlobal('fetch', fetcher);
  const pages = Array.from({ length: Math.ceil(100_000_000 / 4096) }, (_, i): [number, number, number, number, number, number] =>
    [i * 4096, Math.min(4096, 100_000_000 - i * 4096), i === 0 ? 101 : 1000, i === 0 ? 100 : 1000, 1000, 1000]);
  const pack = new StreamingMinimap(raw, manifest, { version: 1, count: 100_000_000, file: 'spatial.bin', pages });
  await pack.prepareQ(100, 100, 0);
  expect(pack.nearestRow(100, 100)).toEqual({ rowId: 99_999_999, distanceQ: 1 });
  expect(pack.rowVoxel(99_999_999)).toMatchObject({ chunk: 999, local: 4095 });
  expect(pack.qx.length).toBe(0);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(pageDistanceSquared([0, 1, 0, 0, 10, 10], 20, 20)).toBe(200);
});
