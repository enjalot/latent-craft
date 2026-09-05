import { describe, expect, it } from "vitest";
import { DATASETS, DEFAULT_DATASET } from "./config.ts";

describe("dataset identities", () => {
  it("names the projection embedding separately from MONET's sampling arm", () => {
    expect(DATASETS["bl-160"].label).toContain("SigLIP 2");
    for (const [id, dataset] of Object.entries(DATASETS)) {
      if (!id.startsWith("monet-")) continue;
      expect(dataset.label).toContain("CLIP ViT-B/32");
      if (id.includes("basemap")) continue;
      expect(dataset.label).toContain(`draw · 2M · ${id.split("-").at(-1)}³`);
      expect(dataset.pointsId).toBe(id.replace(/-(160|512)$/, ""));
    }
    expect(DATASETS["monet-sscd-160"].label).toContain("SSCD draw");
  });

  it("uses the verified 512 SSCD release by default while preserving the 160 option", () => {
    expect(DEFAULT_DATASET).toBe("monet-sscd-512");
    expect(DATASETS[DEFAULT_DATASET]).toMatchObject({
      path: "/chunks/monet-sscd-512-stream-20260905a",
      pointsId: "monet-sscd",
      minimapPath: "/minimap/monet-sscd",
    });
    expect(DATASETS["monet-sscd-160"].path).toBe("/chunks/monet-sscd-160-stream-20260904b");
  });

  it("keeps basemap training rows separate from the SSCD draw", () => {
    expect(DATASETS["monet-clip-basemap-training-512"]).toMatchObject({
      label: expect.stringContaining("basemap · 2.01M · 512³"),
      pointsId: "monet-clip-basemap-training-20260905a",
      minimapPath: "/minimap/monet-clip-basemap-training-20260905a",
    });
  });
});
