import { expect, it } from "vitest";
import { decodePoint, decodeVoxel, pointRecordBytes, voxelRecordBytes, summaryOffset } from "./RecordLayouts.ts";
import { parseChunkMeta } from "./ChunkLoader.ts";
it("round trips the last 100M thumbnail and high packed voxel bits without signed overflow", () => {
  const point = new DataView(new ArrayBuffer(5)); point.setUint32(0, 712976143, true); point.setUint8(4, 8);
  expect(decodePoint(point, true)).toEqual({ subset: 8, local: 712976143 });
  const voxel = new DataView(new ArrayBuffer(4)); voxel.setUint32(0, 0xffffffff, true);
  expect(decodeVoxel(voxel, true)).toEqual({ chunk: 1048575, local: 4095 });
  expect(pointRecordBytes({ encoding: "point-u32-u8", path: "", bytes: 0, sha256: "" })).toBe(5);
  expect(voxelRecordBytes({ path: "", bytes: 0, sha256: "" })).toBe(8);
});
it("decodes sparse summaries into the same dense runtime arrays and rejects duplicate IDs", () => {
  const buffer = new ArrayBuffer(68), view = new DataView(buffer);
  new Uint8Array(buffer).set([76,83,86,49]); view.setUint16(4,3,true); view.setUint32(10,4096,true);
  view.setUint32(14,100002,true); view.setUint16(18,16,true); view.setUint32(22,2,true);
  view.setUint16(32,7,true); view.setUint32(34,100000,true); view.setUint32(46,99,true);
  view.setUint16(50,4095,true); view.setUint32(52,2,true); view.setUint32(56,100000,true); view.setUint32(64,100001,true);
  const meta = parseChunkMeta(buffer);
  expect([...meta.occupied]).toEqual([7,4095]); expect(meta.count[7]).toBe(100000); expect(meta.pointOffset[4095]).toBe(100000);
  expect(summaryOffset(view,4095)).toBe(52); expect(() => summaryOffset(view,8)).toThrow(/absent/);
  expect(meta.pointIds.length).toBe(0);
  view.setUint16(50,7,true); expect(() => parseChunkMeta(buffer)).toThrow(/IDs/);
});
