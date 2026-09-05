import { afterEach, describe, expect, it, vi } from "vitest";
import { MiningController } from "./MiningController.ts";
import { PagedRecords } from "../streaming/RangeReader.ts";
import type { ChunkStore } from "../streaming/ChunkStore.ts";
import type { Manifest } from "../streaming/Manifest.ts";

afterEach(() => vi.restoreAllMocks());
function setup() {
  const chunk = { entry: { postings: { path: "postings.bin" }, n_points: 4 },
    meta: { count: new Uint32Array([2,2]), pointOffset: new Uint32Array([0,2]), reprRowId: new Uint32Array([101,103]) } };
  const lookup = vi.fn(() => chunk);
  const mining = new MiningController({ chunk: lookup } as unknown as ChunkStore,
    () => false, () => false, { url: (s:string)=>s, totalPoints: 1000 } as Manifest);
  return { mining, lookup };
}
const record = (row: number) => { const view=new DataView(new ArrayBuffer(4));view.setUint32(0,row,true);return view; };
describe("independent sharp-band row lookup", () => {
  it("does not replace the hovered mining page when another voxel requests a preview", async () => {
    vi.spyOn(PagedRecords.prototype,"record").mockImplementation(async i => record(100+i));
    const { mining }=setup();
    mining.prepare(0,0); await new Promise(resolve=>setTimeout(resolve,0));
    expect(mining.nextRowId(0,0)).toBe(100);
    expect(await mining.previewRowId(0,1)).toBe(103);
    expect(mining.nextRowId(0,0)).toBe(100);
    expect(await mining.previewRowId(0,2)).toBeNull();
  });
  it("rejects a row whose chunk was evicted during the lookup", async () => {
    let complete!: (v:DataView)=>void;
    vi.spyOn(PagedRecords.prototype,"record").mockImplementation(()=>new Promise(resolve=>{complete=resolve;}));
    const { mining,lookup }=setup();
    vi.spyOn(mining,"extractionState").mockReturnValue({cursor:1,returned:new Set()} as never);
    const pending=mining.previewRowId(0,0);
    lookup.mockReturnValue(undefined as never); complete(record(100));
    expect(await pending).toBeNull();
  });
  it("does not let an invalid posting address a different point table", async () => {
    vi.spyOn(PagedRecords.prototype,"record").mockResolvedValue(record(1000));
    const {mining}=setup();
    vi.spyOn(mining,"extractionState").mockReturnValue({cursor:1,returned:new Set()} as never);
    expect(await mining.previewRowId(0,0)).toBeNull();
  });
  it("sharpens the atlas representative without fetching postings until mining begins", async () => {
    const fetch=vi.spyOn(PagedRecords.prototype,"record").mockResolvedValue(record(102));
    const {mining}=setup();
    expect(await mining.previewRowId(0,0)).toBe(101); expect(fetch).not.toHaveBeenCalled();
    vi.spyOn(mining,"extractionState").mockReturnValue({cursor:1,returned:new Set()} as never);
    expect(await mining.previewRowId(0,0)).toBe(102); expect(fetch).toHaveBeenCalledOnce();
  });
});
