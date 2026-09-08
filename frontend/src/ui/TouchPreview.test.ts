import { afterEach, expect, it, vi } from "vitest";
import { TouchPreview } from "./TouchPreview.ts";
const network = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("../streaming/ThumbnailSource.ts", () => ({ fetchThumbnailBlob: network.fetch }));

class Element extends EventTarget {
  hidden = false; children: Element[] = []; src = ""; style = {};
  decode() { return Promise.resolve(); }
  append(...elements: Element[]) { this.children.push(...elements); }
  removeAttribute(name: string) { if (name === "src") this.src = ""; }
  remove() {}
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("discards late held-image responses and revokes the one visible object URL", async () => {
  vi.stubGlobal("document", { createElement: () => new Element() });
  const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:new"), revoke = vi.spyOn(URL,"revokeObjectURL").mockImplementation(() => {});
  const pending: ((b: Blob) => void)[] = [];
  network.fetch.mockImplementation(() => new Promise<Blob>(resolve => pending.push(resolve)));
  const preview = new TouchPreview(new Element() as unknown as HTMLElement);
  preview.show("old",5,async()=>"/old"); await Promise.resolve();
  preview.show("new",5,async()=>"/new"); await Promise.resolve();
  pending[0](new Blob(["old"])); await Promise.resolve(); await Promise.resolve();
  expect(create).not.toHaveBeenCalled();
  pending[1](new Blob(["new"])); await new Promise(resolve => setTimeout(resolve,0));
  expect(create).toHaveBeenCalledTimes(1); expect(preview.root.hidden).toBe(false);
  preview.show("new",5,async()=>"/new"); expect(network.fetch).toHaveBeenCalledTimes(2);
  preview.hide(); expect(revoke).toHaveBeenCalledWith("blob:new"); expect(preview.root.hidden).toBe(true);
  preview.dispose(); expect(revoke).toHaveBeenCalledTimes(1);
});
