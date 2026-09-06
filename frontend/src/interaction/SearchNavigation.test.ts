import * as THREE from "three";
import { describe, expect, it } from "vitest";
import type { Manifest } from "../streaming/Manifest.ts";
import { planProjectionFlight } from "./SearchNavigation.ts";

describe("direct projection flight", () => {
  const manifest = { worldScale: 50, voxelWorldSize: 100/512 } as Manifest;
  it("uses the true coordinate even outside occupied chunks/the map frame", () => {
    const plan = planProjectionFlight([2, .5, -.2], manifest, new THREE.Vector3(), 2);
    expect(plan.target.toArray()).toEqual([100, 25, -10]);
    expect(plan.destination.distanceTo(plan.target)).toBeCloseTo(2 + 2*100/512);
  });
  it("frames a 12-voxel neighborhood and handles coincident positions", () => {
    const plan = planProjectionFlight([0, 0, 0], manifest, new THREE.Vector3(), 0);
    expect(plan.destination.toArray().every(Number.isFinite)).toBe(true);
    expect(plan.destination.distanceTo(plan.target)).toBeCloseTo(12*100/512);
  });
});
