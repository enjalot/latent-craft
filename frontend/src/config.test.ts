import { describe, expect, it } from "vitest";
import { DATASETS, DEFAULT_DATASET } from "./config.ts";

describe("dataset identities", () => {
  it("names the projection embedding separately from MONET's sampling arm", () => {
    expect(DATASETS["bl-160"].label).toContain("SigLIP 2");
    for (const [id, dataset] of Object.entries(DATASETS)) {
      if (!id.startsWith("monet-")) continue;
      if (id.startsWith("monet-dino-")) {
        expect(dataset.label).toContain("DINOv2 ViT-g/14 · PCA-768 · 6M head");
        continue;
      }
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

  it("gives the audited 6M DINO pair its own release and save identity", () => {
    const dino = DATASETS["monet-dino-basemap-full-6m-pca768-512"];
    expect(dino).toMatchObject({
      path: "/chunks/monet-dino-basemap-full-6m-pca768-20260908a-512-stream",
      pointsId: "monet-dino-basemap-full-6m-pca768-20260908a",
      minimapPath: "/minimap/monet-dino-basemap-full-6m-pca768-20260908a",
    });
    expect(dino.pointsId).not.toBe(DATASETS["monet-clip-basemap-full-4m-512"].pointsId);
    expect(dino.searchProfile).toBeUndefined();
    expect(dino.metadataEndpoint).toBeUndefined();
    expect(dino.streamingProfile).toBeUndefined();
  });

  it("pins the audited full pool to its own immutable 2D/3D pack", () => {
    expect(DATASETS["monet-clip-basemap-pool-512"]).toMatchObject({
      label: expect.stringContaining("basemap · 19.34M · 512³"),
      path: "/chunks/monet-clip-basemap-pool-20260905a-512-stream",
      pointsId: "monet-clip-basemap-pool-20260905a",
      minimapPath: "/minimap/monet-clip-basemap-pool-20260905a",
    });
    expect(DATASETS["monet-clip-basemap-pool-512"].pointsId)
      .not.toBe(DATASETS["monet-clip-basemap-training-512"].pointsId);
  });
});
