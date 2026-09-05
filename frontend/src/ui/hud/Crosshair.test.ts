import { describe, expect, it } from "vitest";
import { formatVoxelCount } from "./Crosshair.ts";

describe("Hover counts", () => {
  it("shows full precision for million-image blocks and live remaining counts", () => {
    expect(formatVoxelCount(1_000_000, 1_000_000)).toBe("1,000,000 images");
    expect(formatVoxelCount(999_900, 1_000_000)).toBe("999,900 images left");
    expect(formatVoxelCount(1, 100)).toBe("1 image left");
    expect(formatVoxelCount(0, 100)).toBe("0 images left");
  });
  it("labels aggregated unloaded regions, not individual mineable blocks", () => {
    expect(formatVoxelCount(20_000_000, 20_000_000, true)).toBe("20,000,000 images · overview");
  });
});
