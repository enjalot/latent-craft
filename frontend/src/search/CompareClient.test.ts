import { describe, expect, it, vi } from "vitest";
import { COMPARE_DATASET, COMPARE_RELEASE, CompareClient, parseComparison } from "./CompareClient.ts";

function response(query = "car", mode = "project") {
  return { dataset: COMPARE_DATASET, release: COMPARE_RELEASE, query, mode,
    projection: { position: [2, .1, -.2], raw2: [1, 2], outside_frame: true }, results: [],
    resources: { rows: 2008321, index_bytes: 0, encoder_weight_bytes: 20, projection_weight_bytes: 10 },
    timings: { embed_ms: 1, project_ms: 1, search_ms: 0, total_ms: 2 } };
}

describe("comparison responses", () => {
  it("calls the native fetch with its window/global receiver", async () => {
    const original = globalThis.fetch;
    try {
      globalThis.fetch = function(this: unknown) {
        expect(this).toBe(globalThis);
        return Promise.resolve(new Response(JSON.stringify(response())));
      };
      expect((await new CompareClient().query("car", "project", () => {}))?.query).toBe("car");
    } finally { globalThis.fetch = original; }
  });
  it("retains outside-frame projections without snapping", () => {
    expect(parseComparison(response(), "car", "project").projection.position[0]).toBe(2);
  });
  it("rejects stale release/query/mode and invalid coordinates", () => {
    for (const change of [{ release: "old" }, { query: "dog" }, { mode: "search" },
      { projection: { position: [NaN, 0, 0], raw2: [0, 0] } }])
      expect(() => parseComparison({ ...response(), ...change }, "car", "project")).toThrow();
  });
  it("rejects out-of-range and duplicated image identities", () => {
    const hit = { row: 12, chunk: 3, local: 1, thumb: 42, score: .4 };
    for (const results of [[{ ...hit, row: 99999999 }], [hit, hit], [{ ...hit, local: 4096 }]])
      expect(() => parseComparison({ ...response("car", "search"), results }, "car", "search")).toThrow();
  });
  it("suppresses stale responses even when fetch ignores abort", async () => {
    let resolveOld!: (response: Response) => void;
    const fetcher = vi.fn().mockImplementationOnce(() => new Promise<Response>(r => { resolveOld = r; }))
      .mockResolvedValueOnce(new Response(JSON.stringify(response("dog"))));
    const client = new CompareClient(fetcher);
    const old = client.query("car", "project", () => {});
    const current = client.query("dog", "project", () => {});
    expect((await current)?.query).toBe("dog");
    resolveOld(new Response(JSON.stringify(response())));
    expect(await old).toBeNull();
  });
  it("cancels polling an index when a projection supersedes it", async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ resources: {
        index_state: "loading", index_rows: 10, rows: 100 } }), { status: 503 }))
        .mockResolvedValueOnce(new Response(JSON.stringify(response())));
      const client = new CompareClient(fetcher);
      let progressed!: () => void;
      const progress = new Promise<void>(r => { progressed = r; });
      const old = client.query("car", "search", () => progressed()).catch(e => e.name);
      await progress;
      expect((await client.query("car", "project", () => {}))?.mode).toBe("project");
      expect(await old).toBe("AbortError");
      await vi.runAllTimersAsync();
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });
});
