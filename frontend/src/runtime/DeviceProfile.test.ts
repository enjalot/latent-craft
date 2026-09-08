import { expect, it } from "vitest";
import { deviceProfile, renderPixelRatio } from "./DeviceProfile.ts";
it("selects touch phones/tablets without shrinking desktop windows into mobile mode", () => {
  expect(deviceProfile(true, 5, 1024, null).mobile).toBe(true);
  expect(deviceProfile(false, 5, 390, null).mobile).toBe(true);
  expect(deviceProfile(false, 0, 390, null).mobile).toBe(false);
  expect(deviceProfile(true, 5, 390, "0").mobile).toBe(false);
  expect(deviceProfile(false, 0, 1000, "1").mobile).toBe(true);
});
it("caps framebuffer area as well as DPR on phones and large tablets", () => {
  const profile = deviceProfile(true, 5, 390, null);
  for (const [w,h] of [[390,844], [2048,1536]]) {
    const ratio = renderPixelRatio(profile, w, h, 3);
    expect(ratio).toBeLessThanOrEqual(1.25);
    expect(w*h*ratio*ratio).toBeLessThanOrEqual(1_000_001);
  }
});
