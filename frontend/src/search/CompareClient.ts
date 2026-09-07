export const COMPARE_DATASET = "monet-clip-basemap-training-512";
export const COMPARE_RELEASE = "monet-clip-basemap-training-20260905a";
export type CompareMode = "project" | "search";
export interface SearchResult { row: number; chunk: number; local: number; thumb: number; score: number; thumbUrl?: string; model?: string }
export interface CompareResponse {
  dataset: string; release: string; query: string; mode: CompareMode;
  projection: { position: [number, number, number]; raw2: [number, number]; outside_frame: boolean };
  results: SearchResult[]; truncated: boolean; embedding_cached: boolean;
  timings: { embed_ms: number; project_ms: number; search_ms: number; total_ms: number };
  resources: { rows: number; index_state: string; index_bytes: number; encoder_weight_bytes: number; projection_weight_bytes: number };
}

export function parseComparison(value: unknown, query: string, mode: CompareMode): CompareResponse {
  const r = value as CompareResponse;
  if (!r || r.dataset !== COMPARE_DATASET || r.release !== COMPARE_RELEASE || r.query !== query || r.mode !== mode ||
    !Array.isArray(r.projection?.position) || r.projection.position.length !== 3 || !r.projection.position.every(Number.isFinite) ||
    !Array.isArray(r.projection.raw2) || r.projection.raw2.length !== 2 || !r.projection.raw2.every(Number.isFinite) ||
    !Array.isArray(r.results) || r.results.length > 24 || (mode === "project" && r.results.length !== 0) ||
    !r.resources || !Number.isSafeInteger(r.resources.rows) || r.resources.rows <= 0 ||
    !r.timings || ![r.timings.embed_ms, r.timings.project_ms, r.timings.search_ms, r.timings.total_ms,
      r.resources.index_bytes, r.resources.encoder_weight_bytes, r.resources.projection_weight_bytes].every(n => Number.isFinite(n) && n >= 0)) {
    throw new Error("Search response does not match this map/query");
  }
  const rows = new Set<number>();
  for (const hit of r.results) {
    if (![hit.row, hit.chunk, hit.local, hit.thumb].every(n => Number.isSafeInteger(n) && n >= 0) ||
      hit.row >= r.resources.rows || hit.chunk >= 32 ** 3 || hit.local >= 16 ** 3 || hit.thumb > 0xffffffff ||
      !Number.isFinite(hit.score) || rows.has(hit.row)) throw new Error("Invalid result identity");
    rows.add(hit.row);
  }
  return r;
}

/** Abort plus generations: stale responses cannot move the camera even if a
 * transport has already completed and cannot honor AbortController. */
export class CompareClient {
  private generation = 0;
  private controller: AbortController | null = null;
  constructor(private readonly fetcher: typeof fetch = (...args) => globalThis.fetch(...args)) {}
  cancel(): void { this.generation++; this.controller?.abort(); this.controller = null; }

  async query(query: string, mode: CompareMode, progress: (text: string) => void): Promise<CompareResponse | null> {
    this.cancel();
    const generation = this.generation;
    const controller = new AbortController(); this.controller = controller;
    query = query.trim();
    if (!query || query.length > 400) throw new Error("Enter between 1 and 400 characters");
    const started = performance.now();
    while (true) {
      const response = await this.fetcher("/api/explore/query", {
        method: "POST", signal: controller.signal, headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dataset: COMPARE_DATASET, release: COMPARE_RELEASE, query, mode }),
      });
      if (generation !== this.generation) return null;
      const body = await response.json().catch(() => { throw new Error("Local search API unavailable. Start search_compare_server.py on port 8803."); });
      if (generation !== this.generation) return null;
      if (response.status === 503 && body.resources?.index_state === "loading" && performance.now()-started < 180000) {
        progress(`Preparing exact index · ${(100 * body.resources.index_rows / body.resources.rows).toFixed(0)}% · projection still available`);
        await new Promise<void>((resolve, reject) => {
          const abort = () => { clearTimeout(timer); reject(new DOMException("Cancelled", "AbortError")); };
          const timer = setTimeout(() => { controller.signal.removeEventListener("abort", abort); resolve(); }, 1000);
          controller.signal.addEventListener("abort", abort, { once: true });
          if (controller.signal.aborted) abort();
        });
        if (generation !== this.generation) return null;
        continue;
      }
      if (!response.ok) throw new Error(body.resources?.index_error || body.error || `Search failed (${response.status})`);
      return parseComparison(body, query, mode);
    }
  }
}
