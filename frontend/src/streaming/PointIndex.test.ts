import { describe, expect, it } from "vitest";
import { parsePointIndex } from "./PointIndex.ts";

describe("parsePointIndex", () => {
  it("rejects a whole-record file from the wrong points table", () => {
    const buffer = new ArrayBuffer(16);
    expect(() => parsePointIndex(buffer, {}, "{local_idx}", "/thumbs", 3)).toThrow(
      "has 2 records, manifest says 3 points",
    );
  });
});
