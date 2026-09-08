import { afterEach, expect, it, vi } from "vitest";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetModules(); });
it("only routes known local thumbnail identities through the 128px experiment", async () => {
  vi.stubEnv("DEV", true); vi.stubGlobal("location", { href: "http://gsv.local:5300/?thumbSize=128", search: "?thumbSize=128" });
  const { localThumbnailPreview, thumbnailPreviewSize } = await import("./ThumbnailQuality.ts");
  expect(thumbnailPreviewSize).toBe(128);
  expect(localThumbnailPreview("/thumbs/monet/65537.webp")).toBe("/api/thumb-preview/monet/65537.webp?size=128");
  expect(localThumbnailPreview("/thumbs/bl/plates/00000042.webp")).toBe("/api/thumb-preview/bl/plates/00000042.webp?size=128");
  expect(localThumbnailPreview("https://source.test/original.jpg")).toBeNull();
});
it("never enables the local encoder in a public production build", async () => {
  vi.stubEnv("DEV", false); vi.stubGlobal("location", { href: "https://demo.test/?thumbSize=128", search: "?thumbSize=128" });
  const { localThumbnailPreview, thumbnailPreviewSize } = await import("./ThumbnailQuality.ts");
  expect(thumbnailPreviewSize).toBe(256); expect(localThumbnailPreview("/thumbs/monet/42.webp")).toBeNull();
});
