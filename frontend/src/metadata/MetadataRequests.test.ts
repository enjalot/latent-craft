import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchMetadata, MetadataClient } from "./MetadataClient.ts";
import type { Manifest } from "../streaming/Manifest.ts";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe("metadata backpressure", () => {
  it("honors bounded Retry-After and stops after three total attempts", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async () => new Response("busy", { status: 429, headers: { "Retry-After": "100" } }));
    vi.stubGlobal("fetch", fetch);
    const pending = fetchMetadata("/metadata");
    await vi.advanceTimersByTimeAsync(3999); expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1); expect((await pending).status).toBe(429);
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it("recovers from a brief busy response and never retries validation failures", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockResolvedValueOnce(new Response("", { status: 429 })).mockResolvedValueOnce(new Response("ok"));
    vi.stubGlobal("fetch", fetch);
    const pending = fetchMetadata("/metadata"); await vi.runAllTimersAsync();
    expect(await (await pending).text()).toBe("ok"); expect(fetch).toHaveBeenCalledTimes(2);
    fetch.mockResolvedValue(new Response("bad", { status: 400 }));
    expect((await fetchMetadata("/metadata")).status).toBe(400); expect(fetch).toHaveBeenCalledTimes(3);
  });
  it("cancels backoff without sending another request", async () => {
    vi.useFakeTimers(); const abort = new AbortController();
    const fetch = vi.fn(async () => new Response("", { status: 429 })); vi.stubGlobal("fetch", fetch);
    const pending = fetchMetadata("/metadata", { signal: abort.signal });
    const assertion = expect(pending).rejects.toHaveProperty("name", "AbortError");
    await vi.advanceTimersByTimeAsync(1); abort.abort(); await assertion;
    await vi.runAllTimersAsync(); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("caches at most 128 validated detail rows per release", async () => {
    const identity = "ab".repeat(32), manifest = { raw: { row_to_voxel: { sha256: identity } } } as Manifest;
    const fetch = vi.fn(async (url: string) => new Response(JSON.stringify({ row: Number(url.split("/").at(-1)), identity, title: "Book", fields: [], links: [] })));
    vi.stubGlobal("fetch", fetch);
    const client = new MetadataClient("/metadata", manifest);
    await client.detail(0); await client.detail(0); expect(fetch).toHaveBeenCalledTimes(1);
    for (let row = 1; row < 129; row++) await client.detail(row);
    await client.detail(128); expect(fetch).toHaveBeenCalledTimes(129);
    await client.detail(0); expect(fetch).toHaveBeenCalledTimes(130);
  });
});
