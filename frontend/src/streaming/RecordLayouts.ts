import type { ManifestBlobRef } from "../types.ts";

export function pointRecordBytes(ref: ManifestBlobRef): number {
  if (ref.encoding && ref.encoding !== "point-u32-u8") throw Error("Unsupported point encoding");
  return ref.encoding ? 5 : 8;
}
export function voxelRecordBytes(ref: ManifestBlobRef): number {
  if (ref.encoding && ref.encoding !== "voxel-u32") throw Error("Unsupported voxel encoding");
  return ref.encoding ? 4 : 8;
}
export function decodePoint(view: DataView, compact: boolean) {
  return { subset: view.getUint8(compact ? 4 : 0), local: view.getUint32(compact ? 0 : 2, true) };
}
export function decodeVoxel(view: DataView, compact: boolean) {
  const word = view.getUint32(0, true);
  return { chunk: compact ? word >>> 12 : word, local: compact ? word & 4095 : view.getUint16(4, true) };
}

/** Find a v3 occupied record; v1/v2 keep the legacy dense addressing. */
export function summaryOffset(view: DataView, local: number): number {
  if (view.getUint16(4, true) !== 3) return 32 + local * 16;
  const count = view.getUint32(22, true);
  if (count > view.getUint32(10, true) || view.byteLength !== 32 + count * 18) throw Error("Invalid sparse summary size");
  let lo = 0, hi = count - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1, offset = 32 + mid * 18, id = view.getUint16(offset, true);
    if (id === local) return offset + 2;
    if (id < local) lo = mid + 1; else hi = mid - 1;
  }
  throw Error("Voxel absent from summary");
}
