import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { Manifest } from "../streaming/Manifest.ts";
import type { ManifestJson } from "../types.ts";
import { planVoxelFlight } from "./VoxelFlight.ts";

const manifest = new Manifest({
  format_version: 1,
  world: { num_voxels: 160, voxels_per_chunk: 16, chunks_per_axis: 10 },
  atlas: { tiles_per_side: 64, tile_px: 32 },
  chunks: [{ chunk_id: 321, cx: 1, cy: 2, cz: 3 }],
} as ManifestJson, "/test", 50);

describe("Inventory voxel flights", () => {
  it("resolves the exact block without minimap data or resident geometry", () => {
    const camera = new THREE.Vector3(10, 20, 30);
    const plan = planVoxelFlight(manifest, 321, 543, camera, 1.25)!;
    expect(plan.target).toEqual(manifest.voxelCenterWorldById(321, 543, new THREE.Vector3()));
    expect(plan.destination.distanceTo(plan.target)).toBeCloseTo(3 * 0.625);
    expect(plan.destination.clone().sub(plan.target).normalize().dot(camera.clone().sub(plan.target).normalize()))
      .toBeCloseTo(1);
    expect(camera.toArray()).toEqual([10, 20, 30]);
  });

  it("keeps the target outside even a large effector field", () => {
    const plan = planVoxelFlight(manifest, 321, 543, new THREE.Vector3(), 20)!;
    expect(plan.destination.distanceTo(plan.target)).toBeCloseTo(20 + manifest.voxelWorldSize);
  });

  it("has a finite arrival direction when already at the block center", () => {
    const target = manifest.voxelCenterWorldById(321, 543, new THREE.Vector3());
    const plan = planVoxelFlight(manifest, 321, 543, target, 1.25)!;
    expect(plan.destination.toArray().every(Number.isFinite)).toBe(true);
    expect(plan.destination.z).toBeGreaterThan(target.z);
  });

  it("rejects unknown chunks and invalid local voxel addresses", () => {
    const camera = new THREE.Vector3();
    expect(planVoxelFlight(manifest, 999, 0, camera, 1)).toBeNull();
    for (const local of [-1, 4096, 0.5, NaN]) {
      expect(planVoxelFlight(manifest, 321, local, camera, 1)).toBeNull();
    }
  });
});
