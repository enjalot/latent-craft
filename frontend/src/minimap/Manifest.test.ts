import { describe, expect, it } from "vitest";
import type { MinimapManifestJson } from "../types.ts";
import { MinimapPack } from "./Manifest.ts";

function manifest(nPoints: number): MinimapManifestJson {
  return {
    pack_format_version: "1",
    dataset_id: "test",
    built_at: "now",
    n_points: nPoints,
    corpus_codes: { "0": "test" },
    corpus_counts: { "0": nPoints },
    frame: { extent: [0, 1, 0, 1], raw_extent: [0, 1, 0, 1], squared: true },
    quantization: { levels: 65_536, bits: 16, formula: "test" },
    tiles: { tile_bins: 256, max_zoom: 0, levels: [] },
    points: { record_bytes: 8, n_points: nPoints, packed: "test" },
  };
}

function points(rowIds: number[]): ArrayBuffer {
  const buffer = new ArrayBuffer(rowIds.length * 8);
  const shorts = new Uint16Array(buffer);
  const words = new Uint32Array(buffer);
  for (let i = 0; i < rowIds.length; i++) {
    shorts[i * 4] = (i * 97) & 0xffff;
    shorts[i * 4 + 1] = (i * 193) & 0xffff;
    words[i * 2 + 1] = rowIds[i];
  }
  return buffer;
}

describe("MinimapPack", () => {
  it("rejects duplicate row ids rather than placing a missing row at 0,0", () => {
    expect(() => new MinimapPack(manifest(2), "/map", points([0, 0]))).toThrow(
      "duplicate row_id 0",
    );
  });

  it("rejects out-of-range row ids", () => {
    expect(() => new MinimapPack(manifest(2), "/map", points([0, 2]))).toThrow(
      "out-of-range row_id 2",
    );
  });

  it("keeps indexed radius queries comfortably off a frame budget", () => {
    const n = 100_000;
    const pack = new MinimapPack(manifest(n), "/map", points([...Array(n).keys()]));
    const out = new Uint32Array(4_096);
    const started = performance.now();
    for (let i = 0; i < 2_000; i++) {
      pack.collectRowsNear((i * 101) & 0xffff, (i * 211) & 0xffff, 512, out);
    }
    expect(performance.now() - started).toBeLessThan(500);
  });
});
