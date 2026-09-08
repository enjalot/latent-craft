import type { Manifest } from "../streaming/Manifest.ts";
import { rangeReader, type RangeReader } from "../streaming/RangeReader.ts";
import type { StackDescriptor } from "./Inventory.ts";
import { decodeVoxel, voxelRecordBytes, summaryOffset } from "../streaming/RecordLayouts.ts";

/** Verify a result against this map without loading a chunk or scanning postings. */
export async function searchCollectionDescriptor(manifest: Manifest, chunk: number, local: number, row: number,
  reader: RangeReader = rangeReader): Promise<StackDescriptor> {
  const entry = manifest.chunksById.get(chunk);
  if (!entry || !Number.isSafeInteger(row) || row < 0 || row >= manifest.totalPoints ||
    !Number.isSafeInteger(local) || local < 0 || local >= manifest.voxelsPerChunk ** 3) throw new Error("Invalid search image identity");
  const lookup = manifest.raw.row_to_voxel;
  const stride = voxelRecordBytes(lookup);
  const [identity, header, record] = await Promise.all([
    reader.read(manifest.url(lookup.path), row * stride, stride, lookup.bytes),
    reader.read(manifest.url(entry.meta_path), 0, 32, entry.meta_bytes),
    reader.read(manifest.url(entry.meta_path), entry.meta_version === 3 ? 0 : 32 + local * 16, entry.meta_version === 3 ? entry.meta_bytes : 16, entry.meta_bytes),
  ]);
  const id = decodeVoxel(new DataView(identity), stride === 4), head = new DataView(header);
  const voxel = new DataView(record, entry.meta_version === 3 ? summaryOffset(new DataView(record), local) : 0, 16);
  const version = head.getUint16(4, true);
  if (id.chunk !== chunk || id.local !== local ||
    head.getUint32(0, true) !== 0x3156534c || ![1, 2, 3].includes(version) ||
    head.getUint32(6, true) !== chunk || head.getUint32(10, true) !== manifest.voxelsPerChunk ** 3) throw new Error("Search image does not belong to this voxel");
  const totalPoints = version === 1 ? voxel.getUint16(0, true) : voxel.getUint32(0, true);
  const reprRowId = voxel.getUint32(version === 1 ? 10 : 12, true);
  const offset = voxel.getUint32(version === 1 ? 2 : 4, true);
  if (!totalPoints || offset + totalPoints > entry.n_points || reprRowId >= manifest.totalPoints) throw new Error("Invalid search voxel metadata");
  return { id: `${chunk}:${local}`, chunkId: chunk, localVoxelId: local, totalPoints, reprRowId };
}
