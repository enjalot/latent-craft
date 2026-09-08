import { describe, expect, it } from "vitest";
import { BL_COLLECTION, MONET_CLIP_COLLECTION, parseCollectionResults } from "../search/CollectionProfile.ts";
const BL_MAP_RELEASE = BL_COLLECTION.release;
const parseBLResults = (value: unknown) => parseCollectionResults(value, BL_COLLECTION);

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

it("binds full-corpus CLIP results to the compact 4M-head release and final row", () => {
  const p = MONET_CLIP_COLLECTION;
  const result = { row: 103816749, chunk: 32000, local: 4095, thumb: 712976143, score: .2,
    thumbUrl: "/thumbs/monet/712976143.webp" };
  const body = { dataset: p.dataset, release: p.release, identity: p.identity, results: [result] };
  expect(parseCollectionResults(body, p)).toEqual([result]);
  for (const bad of [{ ...body, identity: "old" }, { ...body, release: "dino" },
    { ...body, results: [{ ...result, thumbUrl: "/thumbs/monet/42.webp" }] },
    { ...body, results: [{ ...result, row: 103816750 }] }]) expect(() => parseCollectionResults(bad, p)).toThrow();
});
