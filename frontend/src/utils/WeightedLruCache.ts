export interface WeightedLruCacheOptions<K, V> {
  maxEntries: number;
  maxWeight: number;
  weightOf: (value: V, key: K) => number;
  onEvict?: (value: V, key: K) => void;
}

interface Entry<V> {
  value: V;
  weight: number;
}

/** O(1) weighted LRU. Map insertion order is the recency list. */
export class WeightedLruCache<K, V> {
  private readonly entries = new Map<K, Entry<V>>();
  private totalWeight = 0;

  constructor(private readonly options: WeightedLruCacheOptions<K, V>) {
    if (!Number.isInteger(options.maxEntries) || options.maxEntries < 0) {
      throw new RangeError("maxEntries must be a non-negative integer");
    }
    if (!(options.maxWeight >= 0)) throw new RangeError("maxWeight must be non-negative");
  }

  get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  peek(key: K): V | undefined {
    return this.entries.get(key)?.value;
  }

  /** Inserts as most-recent and returns whether the new entry fit the budget. */
  set(key: K, value: V): boolean {
    const weight = this.options.weightOf(value, key);
    if (!Number.isFinite(weight) || weight < 0) {
      throw new RangeError(`cache weight must be finite and non-negative, got ${weight}`);
    }
    const previous = this.entries.get(key);
    if (previous) {
      this.entries.delete(key);
      this.totalWeight -= previous.weight;
      // Re-inserting the exact same resource is a refresh, not an eviction;
      // releasing it through onEvict would invalidate the value retained below.
      if (previous.value !== value) this.options.onEvict?.(previous.value, key);
    }
    this.entries.set(key, { value, weight });
    this.totalWeight += weight;
    this.trim();
    return this.entries.has(key);
  }

  delete(key: K): boolean {
    const entry = this.entries.get(key);
    if (!entry) return false;
    this.entries.delete(key);
    this.totalWeight -= entry.weight;
    this.options.onEvict?.(entry.value, key);
    return true;
  }

  clear(): void {
    for (const [key, entry] of this.entries) this.options.onEvict?.(entry.value, key);
    this.entries.clear();
    this.totalWeight = 0;
  }

  keys(): K[] {
    return [...this.entries.keys()];
  }

  get size(): number {
    return this.entries.size;
  }

  get weight(): number {
    return this.totalWeight;
  }

  private trim(): void {
    while (
      this.entries.size > this.options.maxEntries ||
      this.totalWeight > this.options.maxWeight
    ) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.delete(oldest.value);
    }
  }
}
