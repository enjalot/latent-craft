export interface DeviceProfile { mobile: boolean; maxPixelRatio: number; maxPixels: number; maxFps: number }

/** Capability/layout based, with an explicit preview override. No UA sniffing. */
export function deviceProfile(coarse: boolean, touchPoints: number, shortEdge: number, override: string | null): DeviceProfile {
  const mobile = override === "1" || (override !== "0" && touchPoints > 0 && (coarse || shortEdge < 900));
  return { mobile, maxPixelRatio: mobile ? 1.25 : 2, maxPixels: mobile ? 1_000_000 : 8_294_400, maxFps: mobile ? 30 : 60 };
}
export function renderPixelRatio(profile: DeviceProfile, width: number, height: number, deviceRatio: number): number {
  return Math.min(deviceRatio || 1, profile.maxPixelRatio, Math.sqrt(profile.maxPixels / Math.max(1, width * height)));
}
export const runtimeProfile = typeof window === "undefined" ? deviceProfile(false, 0, 1000, null) : deviceProfile(
  window.matchMedia?.("(pointer: coarse)").matches ?? false, navigator.maxTouchPoints || 0,
  Math.min(window.innerWidth, window.innerHeight), new URLSearchParams(window.location.search).get("mobile"));
