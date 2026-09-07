import { describe, it, expect } from "vitest";
import { MatchSnapshot } from "./MetadataClient.ts";

export function snapshotFixture(rows: number[], totalRows = 32, local = 0, chunk = 0): ArrayBuffer {
  const size = Math.ceil(totalRows / 8), buffer = new ArrayBuffer(64 + size + (rows.length ? 12 : 0)), view = new DataView(buffer);
  view.setUint32(0, 0x464d434c, true); view.setUint32(4, totalRows, true); view.setUint32(8, rows.length, true);
  view.setUint32(12, rows.length ? 1 : 0, true); view.setUint32(48, size, true); view.setUint32(52, 1, true);
  const bits = new Uint8Array(buffer, 64, size); for (const row of rows) bits[row >> 3] |= 1 << (row & 7);
  if (rows.length) { view.setUint32(64 + size, chunk, true); view.setUint32(68 + size, local, true); view.setUint32(72 + size, rows.length, true); }
  return buffer;
}
describe("bounded release-bound metadata snapshots", () => {
  const parse = (buffer: ArrayBuffer) => new MatchSnapshot(buffer, "0".repeat(64), 32, 8, 4);
  it("uses one bit per row and sparse counts, with exact proxy-cell aggregation", () => {
    const match = parse(snapshotFixture([0, 7, 8, 31], 32, 21));
    expect(match.total).toBe(4); expect(match.bits.byteLength).toBe(4);
    expect([0, 7, 8, 31].every(row => match.matches(row))).toBe(true);
    expect([-1, 1, 32, .5, NaN].some(row => match.matches(row))).toBe(false);
    expect(match.cell(0, 0, 2, 4)).toEqual({ total: 4, max: 4, local: 21 });
    expect(match.count(1, 21)).toBe(0);
  });
  it("accepts empty matches and rejects identity, truncation, inconsistent counts and row masks", () => {
    expect(parse(snapshotFixture([])).total).toBe(0);
    expect(() => parse(new ArrayBuffer(2))).toThrow();
    for (const offset of [0, 4, 8, 12, 16, 48, 52, 64, 76]) {
      const buffer = snapshotFixture([1]); const bytes = new Uint8Array(buffer); bytes[offset] ^= 1;
      expect(() => parse(buffer), `offset ${offset}`).toThrow();
    }
    expect(() => parse(snapshotFixture([1]).slice(0, -1))).toThrow();
  });
});
