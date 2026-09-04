import { describe, expect, it } from "vitest";
import { buildEffectorRingGeometries } from "./EffectorField.ts";

function radiiOf(geometry: ReturnType<typeof buildEffectorRingGeometries>["boundary"]): number[] {
  const position = geometry.getAttribute("position");
  const radii = new Set<number>();
  for (let i = 0; i < position.count; i++) {
    const radius = Math.hypot(position.getX(i), position.getY(i), position.getZ(i));
    radii.add(Math.round(radius * 1_000) / 1_000);
  }
  return [...radii].sort((a, b) => a - b);
}

describe("Effector Field calibrated rings", () => {
  it("places the default boundary at two voxels and an inner guide at one", () => {
    const rings = buildEffectorRingGeometries(1, 0.5);
    expect(radiiOf(rings.boundary)).toEqual([1]);
    expect(radiiOf(rings.intervals)).toEqual([0.5]);
    rings.boundary.dispose();
    rings.intervals.dispose();
  });

  it("caps guide density for large fields while preserving the exact boundary", () => {
    const rings = buildEffectorRingGeometries(20, 1);
    expect(radiiOf(rings.intervals)).toEqual([3, 6, 9, 12, 15, 18]);
    expect(radiiOf(rings.boundary)).toEqual([20]);
    rings.boundary.dispose();
    rings.intervals.dispose();
  });
});
