import { expect, it } from "vitest";
import { parseChunkMeta } from "./ChunkLoader.ts";

it("decodes a 100M-point voxel from a 48-byte v2 summary without point IDs", () => {
  const buffer = new ArrayBuffer(48), view = new DataView(buffer);
  new Uint8Array(buffer).set([76, 83, 86, 49]);
  view.setUint16(4, 2, true); view.setUint32(10, 1, true);
  view.setUint32(14, 100_000_000, true); view.setUint16(18, 1, true);
  view.setUint32(32, 100_000_000, true); view.setUint32(44, 99_999_999, true);
  const meta = parseChunkMeta(buffer);
  expect(meta.count[0]).toBe(100_000_000);
  expect(meta.reprRowId[0]).toBe(99_999_999);
  expect(meta.pointIds.byteLength).toBe(0);
});
