import * as THREE from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FlightControls } from "./FlightControls.ts";

afterEach(() => vi.unstubAllGlobals());
function fly(speed: number, code = "KeyW") {
  const listeners = new Map<string, (e: unknown) => void>();
  vi.stubGlobal("window", { addEventListener: (name: string, fn: (e:unknown)=>void) => listeners.set(name,fn), removeEventListener:vi.fn() });
  const camera = new THREE.PerspectiveCamera(), controls = new FlightControls(camera);
  controls.setSpeed(speed);
  listeners.get("keydown")!({code,repeat:false,preventDefault:vi.fn(),target:null});
  for (let i=0;i<120;i++) controls.update(1/60);
  const distance = camera.position.length();
  controls.dispose(); return distance;
}
describe("adjustable flight speed", () => {
  it("scales horizontal and vertical movement equally", () => {
    const slow = fly(1);
    expect(slow).toBeGreaterThan(1.5);
    expect(slow).toBeLessThan(2);
    expect(fly(4)).toBeCloseTo(slow*4, 5);
    expect(fly(1,"Space")).toBeCloseTo(slow, 5);
  });
  it("makes the 512-grid default about five times slower than the old 8 world units/s", () => {
    expect(fly(8 * 100 / 512) / fly(8)).toBeCloseTo(100 / 512, 5);
  });
});
