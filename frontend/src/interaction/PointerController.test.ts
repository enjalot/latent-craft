import { describe, expect, it, vi } from "vitest";
import { PointerController } from "./PointerController.ts";
import type { FlightControls } from "../engine/FlightControls.ts";

describe("world keyboard focus", () => {
  it("explicitly focuses the canvas before engaging a hold or look drag", () => {
    const listeners=new Map<string,(e:unknown)=>void>(),order:string[]=[];
    const element={tabIndex:0,addEventListener:(name:string,fn:(e:unknown)=>void)=>listeners.set(name,fn),
      removeEventListener:vi.fn(),focus:vi.fn(()=>order.push("focus")),setPointerCapture:vi.fn(),hasPointerCapture:()=>false,
      getBoundingClientRect:()=>({left:0,top:0,width:100,height:100})};
    const controller=new PointerController(element as unknown as HTMLElement,{} as FlightControls,{
      hitTestVoxel:()=>null,onPointerEngage:()=>order.push("engage"),onHoldStart:vi.fn(),onHoldCancel:vi.fn()});
    listeners.get("pointerdown")!({button:0,clientX:50,clientY:50,pointerId:1,preventDefault:vi.fn()});
    expect(element.tabIndex).toBe(-1);
    expect(element.focus).toHaveBeenCalledWith({preventScroll:true});expect(order).toEqual(["focus","engage"]);
    controller.dispose();
  });
});

it("owns one look/hold pointer, uses touch client deltas and cancels on capture loss", () => {
  const listeners = new Map<string, (e: unknown) => void>(), blur = new Map<string, () => void>();
  const element = { addEventListener: (n: string, f: (e: unknown) => void) => listeners.set(n, f), removeEventListener: vi.fn(),
    ownerDocument: { defaultView: { addEventListener: (n: string, f: () => void) => blur.set(n, f), removeEventListener: vi.fn() } },
    focus: vi.fn(), setPointerCapture: vi.fn(), hasPointerCapture: () => false, getBoundingClientRect: () => ({left:0,top:0,width:100,height:100}) };
  const look = vi.fn(), cancel = vi.fn(), engage = vi.fn();
  const controller = new PointerController(element as unknown as HTMLElement, { applyLookDelta: look } as unknown as FlightControls,
    { hitTestVoxel: () => ({chunkId:1,localVoxelId:2}), onPointerEngage: engage, onHoldStart: vi.fn(), onHoldCancel: cancel });
  const send = (type: string, id: number, x = 50) => listeners.get(type)!({ button:0, pointerId:id, pointerType:"touch", clientX:x, clientY:50, movementX:0, movementY:0, preventDefault:vi.fn() });
  send("pointerdown", 1); send("pointerdown", 2); send("pointermove", 2, 99); send("pointerup", 2);
  expect(engage).toHaveBeenCalledTimes(1); expect(controller.holdTarget).not.toBeNull(); expect(look).not.toHaveBeenCalled();
  send("pointermove", 1, 58); expect(controller.holdTarget).not.toBeNull();
  send("pointermove", 1, 70); expect(cancel).toHaveBeenCalledTimes(1); expect(look).toHaveBeenLastCalledWith(12,0);
  send("lostpointercapture", 1); expect(controller.isDragging).toBe(false);
  send("pointerdown", 2); blur.get("blur")!(); expect(controller.holdTarget).toBeNull();
  send("pointerdown", 3); expect(engage).toHaveBeenCalledTimes(3);
  controller.cancelHold(); send("pointermove", 3, 80);
  expect(controller.isDragging).toBe(true); expect(look).toHaveBeenLastCalledWith(30,0);
  controller.dispose();
});
