import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChunkStore } from "../streaming/ChunkStore.ts";
import type { Manifest } from "../streaming/Manifest.ts";
import type { VoxelHit } from "../engine/Raycast.ts";
import { rangeReader } from "../streaming/RangeReader.ts";
import { MiningController } from "./MiningController.ts";
import { miningSaveCsv, miningSaveFromCsv, validateMiningSave } from "./MiningSave.ts";
import { verifyMiningPostings } from "./VerifyMiningSave.ts";
afterEach(() => vi.restoreAllMocks());
function fixture(resident = true) {
  const meta = new DataView(new ArrayBuffer(65568));
  meta.setUint32(0,0x3156534c,true); meta.setUint16(4,2,true); meta.setUint32(6,7,true); meta.setUint32(10,4096,true);
  meta.setUint32(32,5,true); meta.setUint32(44,10,true);
  const read = vi.spyOn(rangeReader,"read").mockImplementation(async (url,start,length) => {
    if (url === "meta.bin") return meta.buffer.slice(start,start+length);
    const view = new DataView(new ArrayBuffer(length));
    if (url === "rows.bin") { view.setUint32(0, start/8 >=10 && start/8 <15 ? 7 : 8,true); view.setUint16(4,0,true); }
    else for(let i=0;i<length;i+=4) view.setUint32(i,10+(start+i)/4,true);
    return view.buffer;
  });
  const mesh = {userData:{chunkId:7,instanceToLocalVoxelId:new Uint32Array([0])},setOpacityAt:vi.fn(),setUniformAt:vi.fn()};
  const entry = {meta_path:"meta.bin",meta_bytes:65568,n_points:5,postings:{path:"postings.bin"}};
  const chunk = {entry:{chunk_id:7},mesh,meta:{count:new Uint32Array([5]),reprRowId:new Uint32Array([10]),pointOffset:new Uint32Array([0]),occupied:new Uint32Array([0]),pointIds:new Uint32Array([10,11,12,13,14])},containers:{setExtractedFraction:vi.fn()}};
  const store = {chunk:()=>resident ? chunk : undefined,residentChunkIds:resident?[7]:[]} as unknown as ChunkStore;
  const manifest = {baseUrl:"/test",totalPoints:100,voxelsPerChunk:16,chunksById:new Map([[7,entry]]),url:(s:string)=>s,raw:{row_to_voxel:{path:"rows.bin",bytes:800}}} as unknown as Manifest;
  const mining = new MiningController(store,()=>false,()=>true,manifest);
  return {mining,manifest,read,hit:{mesh,instanceId:0} as unknown as VoxelHit};
}
describe("collecting exact search rows", () => {
  it("collects only the chosen row in a distant voxel using 56 bytes, deduplicating simultaneous clicks", async () => {
    const {mining,read}=fixture(false);
    await Promise.all([mining.collectSearchResult(7,0,14),mining.collectSearchResult(7,0,14)]);
    expect([...mining.inventory.stacks[0].rowIds]).toEqual([14]);
    expect(mining.extractionState(7,0)).toMatchObject({cursor:0,selected:new Set([14])});
    expect(read.mock.calls.slice(0,3).reduce((sum,c)=>sum+c[2],0)).toBe(56);
    await expect(mining.collectSearchResult(7,0,50)).rejects.toThrow("does not belong");
    expect(mining.inventory.totalPoints).toBe(1);
  });
  it("round-trips selected rows and skips them when ordinary mining reaches their position", async () => {
    const {mining,manifest,hit}=fixture();
    await mining.collectSearchResult(7,0,12);
    const save = mining.snapshot("test");
    const imported = miningSaveFromCsv(await miningSaveCsv(save,async row=>`https://example.test/${row}`));
    expect(validateMiningSave(imported,"test",manifest)).toEqual(save);
    await verifyMiningPostings(imported,manifest);
    mining.restore(imported,"test");
    expect(mining.extract(hit)?.rowIds).toEqual([10,11,13,14]);
    expect(mining.inventory.totalPoints).toBe(5);
    expect(mining.snapshot("test").stacks[0].selected).toBeUndefined();
    expect(mining.returnRow("7:0",12)).toBe(true);
    expect(mining.extract(hit)?.rowIds).toEqual([12]);
  });
  it("returns an ahead-of-cursor selection without inventing a consumed prefix", async () => {
    const {mining,hit}=fixture();
    await mining.collectSearchResult(7,0,14); await mining.collectSearchResult(7,0,12);
    mining.returnRow("7:0",12);
    expect(mining.snapshot("test").stacks[0]).toMatchObject({cursor:0,returned:[],selected:[14]});
    expect(mining.extract(hit)?.rowIds).toEqual([10,11,12,13]);
  });
  it("rejects corrupt selected imports, cancellations, and stale completions across restore", async () => {
    const {mining,manifest}=fixture();
    await expect(mining.collectSearchResult(7,0,12,()=>true)).rejects.toThrow();
    const pending = mining.collectSearchResult(7,0,12);
    mining.restore({version:1,dataset:"test",pack:"/test",stacks:[]},"test");
    await expect(pending).rejects.toThrow("cancelled");
    await mining.collectSearchResult(7,0,12);
    const save=mining.snapshot("test"); save.stacks[0].rowIds=[50]; save.stacks[0].selected=[50];
    await expect(verifyMiningPostings(save,manifest)).rejects.toThrow("does not belong");
    save.stacks[0].selected=[51];
    expect(()=>validateMiningSave(save,"test",manifest)).toThrow("selected");
  });
  it("updates sharp previews when the atlas representative is collected", async () => {
    const {mining}=fixture();
    await mining.collectSearchResult(7,0,10);
    expect(await mining.previewRowId(7,0)).toBe(11);
    expect(mining.nextRowId(7,0)).toBe(11);
  });
});
