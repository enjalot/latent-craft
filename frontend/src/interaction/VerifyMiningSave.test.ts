import { describe, expect, it, vi } from "vitest";
import { verifyMiningPostings } from "./VerifyMiningSave.ts";
import type { MiningSave } from "./MiningSave.ts";
import type { Manifest } from "../streaming/Manifest.ts";
import type { RangeReader } from "../streaming/RangeReader.ts";

function fixture(version: number) {
  const summaryBytes = 65568;
  const entry = {meta_path:"meta.bin",meta_bytes:summaryBytes+(version===1?1200000:0),n_points:300000,postings:{path:"postings.bin"}};
  const read = vi.fn(async (url:string, offset:number, length:number) => {
    const buffer = new ArrayBuffer(length), view = new DataView(buffer);
    if(url==='meta.bin' && offset===0) {
      view.setUint32(0,0x3156534c,true);view.setUint16(4,version,true);view.setUint32(6,7,true);view.setUint32(10,4096,true);
      if(version===1) view.setUint16(32,5,true);else view.setUint32(32,5,true);
      view.setUint32(32+(version===1?10:12),10,true);
    } else for(let i=0;i<length;i+=4) {
      const ordinal=(offset+i-(url==='meta.bin'?summaryBytes:0))/4;
      if(ordinal>=0)view.setUint32(i,10+ordinal,true);
    }
    return buffer;
  });
  const manifest = {voxelsPerChunk:16,chunksById:new Map([[7,entry]]),url:(s:string)=>s} as unknown as Manifest;
  const save = {stacks:[{chunkId:7,localVoxelId:0,totalPoints:5,reprRowId:10,cursor:4,rowIds:[10,12,13],returned:[11]}]} as MiningSave;
  return {read,manifest,save};
}
describe("bounded import verification", () => {
  it.each([1,2])("checks v%s posting prefixes without fetching an entire chunk", async version => {
    const {read,manifest,save}=fixture(version);
    await verifyMiningPostings(save,manifest,()=>false,{read} as unknown as RangeReader);
    expect(read.mock.calls.every(([, ,length])=>length<=65568)).toBe(true);
    save.stacks[0].rowIds[0]=14;
    await expect(verifyMiningPostings(save,manifest,()=>false,{read} as unknown as RangeReader)).rejects.toThrow("posting prefix");
  });
  it("stops verification when its dataset has been closed", async()=>{
    const {read,manifest,save}=fixture(2);
    await expect(verifyMiningPostings(save,manifest,()=>true,{read} as unknown as RangeReader)).rejects.toThrow("Map closed");
    expect(read).not.toHaveBeenCalled();
  });
});
