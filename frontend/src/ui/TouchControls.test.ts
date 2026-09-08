import { afterEach, expect, it, vi } from "vitest";
import { TouchControls } from "./TouchControls.ts";
import type { FlightControls } from "../engine/FlightControls.ts";

class Element extends EventTarget {
  children: Element[] = []; style = {}; attrs = new Map<string, string>();
  append(...elements: Element[]) { this.children.push(...elements); }
  setAttribute(name: string, value: string) { this.attrs.set(name, value); }
  setPointerCapture() {} remove() {}
}
afterEach(() => vi.unstubAllGlobals());

it("allows simultaneous D-pad pointers and releases only their own keys, including cancellation", () => {
  const doc = Object.assign(new EventTarget(), { createElement: () => new Element() });
  const view = new EventTarget(); vi.stubGlobal("document", doc); vi.stubGlobal("window", view);
  const root = new Element(), setTouchKey = vi.fn();
  const controls = new TouchControls(root as unknown as HTMLElement, { setTouchKey } as unknown as FlightControls, vi.fn());
  const [pad, vertical] = root.children[0].children;
  const forward = pad.children[0], up = vertical.children[0];
  const send = (target: Element, type: string, id: number) => target.dispatchEvent(Object.assign(new Event(type, {cancelable:true}), {pointerId:id}));
  send(forward,"pointerdown",1); send(up,"pointerdown",2);
  expect(setTouchKey.mock.calls).toEqual([["KeyW",true],["Space",true]]);
  send(forward,"pointerup",99); expect(setTouchKey).toHaveBeenCalledTimes(2);
  send(forward,"lostpointercapture",1); expect(setTouchKey).toHaveBeenLastCalledWith("KeyW",false);
  expect(up.attrs.get("aria-pressed")).toBe("true");
  view.dispatchEvent(new Event("blur")); expect(setTouchKey).toHaveBeenLastCalledWith("Space",false);
  send(forward,"pointerdown",3); send(forward,"pointerdown",4); send(forward,"pointercancel",3);
  expect(forward.attrs.get("aria-pressed")).toBe("true");
  doc.dispatchEvent(new Event("visibilitychange")); expect(forward.attrs.get("aria-pressed")).toBe("false");
  controls.dispose(); const count = setTouchKey.mock.calls.length;
  send(up,"pointerdown",5); expect(setTouchKey).toHaveBeenCalledTimes(count);
});
