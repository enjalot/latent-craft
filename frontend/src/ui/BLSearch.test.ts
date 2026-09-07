import { describe, expect, it } from "vitest";
import { BL_MAP_RELEASE, parseBLResults } from "./BLSearch.ts";

const hit = { row: 42, chunk: 43, local: 20, thumb: 42, score: 0.2, model: "SigLIP 2", thumbUrl: "/thumbs/bl/plates/00000042.webp" };
const response = (results: unknown[] = [hit]) => ({ dataset: "bl-160", release: BL_MAP_RELEASE, results });
describe("BL search identity boundary", () => {
  it("accepts only this immutable map's results", () => {
    expect(parseBLResults(response())).toEqual([hit]);
    expect(() => parseBLResults({ ...response(), release: "old" })).toThrow();
    expect(() => parseBLResults(null)).toThrow();
  });
  it("rejects invalid, duplicate and cross-image identities", () => {
    for (const bad of [null, { ...hit, row: 1080814 }, { ...hit, chunk: -1 }, { ...hit, local: 4096 },
      { ...hit, score: NaN }, { ...hit, thumb: 43 }, { ...hit, thumbUrl: "https://other.test/image.webp" }]) {
      expect(() => parseBLResults(response([bad]))).toThrow();
    }
    expect(() => parseBLResults(response([hit, hit]))).toThrow();
    expect(() => parseBLResults(response(Array(25).fill(hit)))).toThrow();
  });
});
