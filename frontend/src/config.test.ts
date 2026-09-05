import { describe, expect, it } from "vitest";
import { DATASETS, DEFAULT_DATASET } from "./config.ts";

describe("dataset identities", () => {
  it("names the projection embedding separately from MONET's sampling arm", () => {
    expect(DATASETS["bl-160"].label).toContain("SigLIP 2");
    for (const [id, dataset] of Object.entries(DATASETS)) {
      if (!id.startsWith("monet-")) continue;
      expect(dataset.label).toContain("CLIP ViT-B/32");
      expect(dataset.label).toContain("draw · 2M · 160³");
      expect(dataset.pointsId).toBe(id.replace(/-160$/, ""));
    }
    expect(DATASETS["monet-sscd-160"].label).toContain("SSCD draw");
  });

  it("keeps the already-built 2M CLIP SSCD streaming release as the default", () => {
    expect(DEFAULT_DATASET).toBe("monet-sscd-160");
    expect(DATASETS[DEFAULT_DATASET]).toMatchObject({
      path: "/chunks/monet-sscd-160-stream-20260904b",
      pointsId: "monet-sscd",
      minimapPath: "/minimap/monet-sscd",
    });
  });
});
