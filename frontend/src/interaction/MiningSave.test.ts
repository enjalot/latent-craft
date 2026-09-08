import { describe, expect, it, vi } from "vitest";
import { miningSaveCsv, miningSaveFromCsv, parseCsv, validateMiningSave, type MiningSave } from "./MiningSave.ts";
import { MiningController } from "./MiningController.ts";
import type { Manifest } from "../streaming/Manifest.ts";
import type { ChunkStore } from "../streaming/ChunkStore.ts";
import type { VoxelHit } from "../engine/Raycast.ts";

const manifest = { baseUrl: "/chunks/release-a", totalPoints: 1000, voxelsPerChunk: 16, chunksById: new Map([[7, {}]]) } as Manifest;
const save = (): MiningSave => ({ version: 1, dataset: "test", pack: manifest.baseUrl, stacks: [{
  id: "7:0", chunkId: 7, localVoxelId: 0, rowIds: [10,12,13], totalPoints: 5, reprRowId: 10, cursor: 4, returned: [11], firstExtractedAt: 1000, lastExtractedAt: 2000,
}] });

describe("portable mining saves", () => {
  it("keeps save identity across a storage-only repack, without accepting a different projection", () => {
    const repacked = { ...manifest, baseUrl: "/chunks/release-a-compact", raw: { save_identity: manifest.baseUrl } } as Manifest;
    expect(validateMiningSave(save(), "test", repacked)).toEqual(save());
    const different = { ...repacked, raw: { save_identity: "/chunks/different-projection" } } as Manifest;
    expect(() => validateMiningSave(save(), "test", different)).toThrow();
  });
  it("round-trips CSV with URLs, commas, quotes, BOM and CRLF", async () => {
    const original = save();
    original.dataset = 'name, "quoted"';
    const csv = await miningSaveCsv(original, async row => `https://example.test/${row}?name="a,b"`);
    expect(miningSaveFromCsv("\uFEFF" + csv)).toEqual(original);
    expect(parseCsv(csv)[1][6]).toBe('https://example.test/10?name="a,b"');
    expect(parseCsv('a,"b\nc"\r\n')).toEqual([["a", "b\nc"]]);
  });

  it("bounds concurrent URL resolution instead of starting one fetch per mined image", async () => {
    const s = save(); s.stacks[0].rowIds = Array.from({length:10000}, (_,i)=>i);
    let active = 0, peak = 0;
    await miningSaveCsv(s, async row => { peak = Math.max(peak, ++active); await Promise.resolve(); active--; return `/${row}`; });
    expect(peak).toBe(32);
  });

  it("still imports the original 13-column CSV", async () => {
    const csv = await miningSaveCsv(save(), async row => `/${row}`);
    const legacy = parseCsv(csv).map(row => row.slice(0, 13).map(value => JSON.stringify(value)).join(",")).join("\r\n");
    expect(miningSaveFromCsv(legacy)).toEqual(save());
  });

  it("rejects wrong maps, duplicate rows, corrupt counts and malformed CSV", async () => {
    expect(validateMiningSave(save(), "test", manifest)).toEqual(save());
    for (const mutate of [
      (s:MiningSave)=>{s.pack="/chunks/release-b";},
      (s:MiningSave)=>{s.stacks[0].rowIds[0]=1000;},
      (s:MiningSave)=>{s.stacks[0].returned=[10];},
      (s:MiningSave)=>{s.stacks[0].cursor=1;},
      (s:MiningSave)=>{s.stacks.push(s.stacks[0]);},
      (s:MiningSave)=>{s.stacks[0].localVoxelId=4096;},
    ]) { const s=save(); mutate(s); expect(()=>validateMiningSave(s,"test",manifest)).toThrow(); }
    expect(()=>validateMiningSave(save(),"different",manifest)).toThrow();
    expect(()=>parseCsv('a,"unfinished')).toThrow();
    expect(()=>parseCsv('a,"done"extra')).toThrow();
    const csv = await miningSaveCsv(save(), async row => `/${row}`);
    expect(()=>miningSaveFromCsv(csv.replace('"4"', '"NaN"'))).toThrow();
  });

  it("restores cursor/returns/depletion atomically, then mines exactly the remaining images", () => {
    const mesh = { userData: { chunkId:7, instanceToLocalVoxelId:new Uint32Array([0]) }, setOpacityAt:vi.fn(), setUniformAt:vi.fn() };
    const chunk = { entry:{chunk_id:7}, mesh, meta:{count: new Uint32Array([5]), occupied:new Uint32Array([0]), pointOffset:new Uint32Array([0]),
      reprRowId:new Uint32Array([10]), pointIds:new Uint32Array([10,11,12,13,14])}, containers:{setExtractedFraction:vi.fn()} };
    const store = { chunk:()=>chunk, residentChunkIds:[7] } as unknown as ChunkStore;
    const mining = new MiningController(store,()=>false,()=>true,manifest);
    mining.restore(save(),"test");
    expect(mining.inventory.totalPoints).toBe(3);
    expect(mining.nextRowId(7,0)).toBe(11);
    expect(chunk.containers.setExtractedFraction).toHaveBeenLastCalledWith(0,.6);
    expect(mining.snapshot("test")).toEqual(save());
    const bad = save(); bad.stacks[0].cursor=-1;
    expect(()=>mining.restore(bad,"test")).toThrow();
    expect(mining.snapshot("test")).toEqual(save());
    expect(mining.extract({mesh,instanceId:0} as unknown as VoxelHit)?.rowIds).toEqual([11,14]);
    expect(mining.isFullyExtracted(7,0)).toBe(true);
    mining.returnStack("7:0");
    expect(mining.nextRowId(7,0)).toBe(10);
    mining.restore(save(),"test");
    mining.restore({...save(),stacks:[]},"test");
    expect(mining.inventory.totalPoints).toBe(0);
    expect(chunk.containers.setExtractedFraction).toHaveBeenLastCalledWith(0,0);
  });
});
