import { describe, expect, it, vi } from "vitest";
import { WeightedLruCache } from "./WeightedLruCache.ts";

describe("WeightedLruCache", () => {
  it("evicts least-recent entries by aggregate weight", () => {
    const evicted: string[] = [];
    const cache = new WeightedLruCache<string, number>({
      maxEntries: 3,
      maxWeight: 10,
      weightOf: (value) => value,
      onEvict: (_value, key) => evicted.push(key),
    });

    cache.set("a", 4);
    cache.set("b", 4);
    cache.get("a"); // b is now oldest
    expect(cache.set("c", 4)).toBe(true);
    expect(cache.keys()).toEqual(["a", "c"]);
    expect(cache.weight).toBe(8);
    expect(evicted).toEqual(["b"]);
  });

  it("rejects an entry that cannot fit by itself", () => {
    const onEvict = vi.fn();
    const cache = new WeightedLruCache<string, number>({
      maxEntries: 2,
      maxWeight: 5,
      weightOf: (value) => value,
      onEvict,
    });
    expect(cache.set("huge", 6)).toBe(false);
    expect(cache.size).toBe(0);
    expect(onEvict).toHaveBeenCalledWith(6, "huge");
  });

  it("keeps a large hot set on the constant-time Map path", () => {
    const cache = new WeightedLruCache<number, number>({
      maxEntries: 10_000,
      maxWeight: 10_000,
      weightOf: () => 1,
    });
    for (let i = 0; i < 10_000; i++) cache.set(i, i);
    const started = performance.now();
    let checksum = 0;
    for (let i = 0; i < 100_000; i++) checksum += cache.get(i % 10_000) ?? -1;
    expect(checksum).toBe(499_950_000);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("can refresh the same owned resource without evicting it", () => {
    const onEvict = vi.fn();
    const value = { bytes: 4 };
    const cache = new WeightedLruCache<string, typeof value>({
      maxEntries: 1,
      maxWeight: 4,
      weightOf: (entry) => entry.bytes,
      onEvict,
    });
    cache.set("a", value);
    expect(cache.set("a", value)).toBe(true);
    expect(onEvict).not.toHaveBeenCalled();
  });
});
