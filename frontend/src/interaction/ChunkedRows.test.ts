import { expect, it } from "vitest";
import { ChunkedRows } from "./ChunkedRows.ts";

it("does not reserve a 16 KiB page for every one-image block", () => {
  const rows = new ChunkedRows();
  rows.push(42);
  expect(rows.byteLength).toBe(64);
});

it("stores a million mined IDs in ~4 MB and supports bounded page access", () => {
  const rows = new ChunkedRows();
  for (let i = 0; i < 1_000_000; i++) rows.push(i * 2);
  expect(rows.byteLength).toBeLessThan(4_020_000);
  expect(rows.length).toBe(1_000_000);
  expect(rows.at(-1)).toBe(1_999_998);
  expect(rows.slice(999_990)).toHaveLength(10);
  expect(rows.remove(8190)).toBe(true);
  expect(rows.at(4095)).toBe(8192);
  expect(rows.at(-1)).toBe(1_999_998);
  expect(rows.remove(8190)).toBe(false);
  rows.push(123);
  expect(rows.at(-1)).toBe(123);
});
