import { afterEach, expect, it, vi } from "vitest";
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });
it("publishes one pinned BL map and binds its search capability to that release", async () => {
  vi.stubEnv("VITE_DEMO_DATASET", "bl-160"); vi.resetModules();
  const { DATASETS, DEFAULT_DATASET } = await import("./config.ts");
  expect(DEFAULT_DATASET).toBe("bl-160");
  expect(Object.keys(DATASETS)).toEqual(["bl-160"]);
  expect(DATASETS["bl-160"]).toMatchObject({ searchProfile: "bl-siglip2-20260907a",
    path: "/chunks/bl-siglip2-160-stream-20260907a", pointMetaFile: { rows: 1080814 } });
});
it("does not attach published search identities to the legacy development BL map", async () => {
  vi.stubEnv("VITE_DEMO_DATASET", ""); vi.resetModules();
  const { DATASETS } = await import("./config.ts");
  expect(DATASETS["bl-160"].searchProfile).toBeUndefined();
});
