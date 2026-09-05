import { describe, expect, it, vi } from "vitest";
import { PointerController } from "./PointerController.ts";
import type { FlightControls } from "../engine/FlightControls.ts";

describe("world keyboard focus", () => {
  it("explicitly focuses the canvas before engaging a hold or look drag", () => {
    const listeners=new Map<string,(e:unknown)=>void>(),order:string[]=[];
    const element={tabIndex:0,addEventListener:(name:string,fn:(e:unknown)=>void)=>listeners.set(name,fn),
      removeEventListener:vi.fn(),focus:vi.fn(()=>order.push("focus")),setPointerCapture:vi.fn(),
      getBoundingClientRect:()=>({left:0,top:0,width:100,height:100})};
    const controller=new PointerController(element as unknown as HTMLElement,{} as FlightControls,{
      hitTestVoxel:()=>null,onPointerEngage:()=>order.push("engage"),onHoldStart:vi.fn(),onHoldCancel:vi.fn()});
    listeners.get("pointerdown")!({button:0,clientX:50,clientY:50,pointerId:1,preventDefault:vi.fn()});
    expect(element.tabIndex).toBe(-1);
    expect(element.focus).toHaveBeenCalledWith({preventScroll:true});expect(order).toEqual(["focus","engage"]);
    controller.dispose();
  });
});
