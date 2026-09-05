import * as THREE from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildEffectorSurfaceGeometry, effectorSurfaceOpacity } from "./EffectorSurface.ts";
import { EffectorFieldController } from "./EffectorField.ts";
import type { ChunkStore } from "../streaming/ChunkStore.ts";
import type { Manifest } from "../streaming/Manifest.ts";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function radiiOf(geometry: ReturnType<typeof buildEffectorSurfaceGeometry>): number[] {
  const position = geometry.getAttribute("position");
  const radii = new Set<number>();
  for (let i = 0; i < position.count; i++) {
    const radius = Math.hypot(position.getX(i), position.getY(i), position.getZ(i));
    radii.add(Math.round(radius * 1_000) / 1_000);
  }
  return [...radii].sort((a, b) => a - b);
}

describe("Effector surface dots", () => {
  it("uses a fixed-size scatter on the exact sphere boundary", () => {
    const geometry = buildEffectorSurfaceGeometry();
    expect(geometry.getAttribute("position").count).toBe(384);
    expect(radiiOf(geometry)).toEqual([1]);
    geometry.dispose();
  });

  it("holds briefly, fades monotonically and stays hidden until the next scroll", () => {
    expect(effectorSurfaceOpacity(0)).toBe(0.8);
    expect(effectorSurfaceOpacity(180)).toBe(0.8);
    expect(effectorSurfaceOpacity(540)).toBeCloseTo(0.4);
    expect(effectorSurfaceOpacity(900)).toBe(0);
    expect(effectorSurfaceOpacity(Infinity)).toBe(0);
    for (let t = 0; t < 1000; t += 20) {
      expect(effectorSurfaceOpacity(t + 20)).toBeLessThanOrEqual(effectorSurfaceOpacity(t));
    }
  });

  it("fades while stationary without disabling the field or rebuilding geometry", () => {
    vi.stubGlobal("window", { devicePixelRatio: 1 });
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const target = { clientHeight: 600, addEventListener: vi.fn(), removeEventListener: vi.fn() };
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera();
    const field = new EffectorFieldController(
      { residentChunkIds: [] } as unknown as ChunkStore,
      { voxelWorldSize: 0.625, chunkWorldSize: 10 } as Manifest,
      scene, target as unknown as HTMLElement,
    );
    const geometry = (field.gizmo.children[0] as THREE.Points).geometry;
    field.update(camera);
    expect(field.currentRadiusVoxels).toBe(2);
    expect(field.gizmo.visible).toBe(false);
    field.adjustRadius(1);
    field.update(camera);
    expect(field.gizmo.visible).toBe(true);
    expect(field.gizmo.scale.x).toBeCloseTo(2.25 * 0.625);
    now = 1000;
    field.update(camera);
    expect(field.gizmo.visible).toBe(false);
    expect(field.isActive).toBe(true);
    field.adjustRadius(NaN);
    expect(field.currentRadiusVoxels).toBe(2.25);
    field.adjustRadius(10000);
    expect(field.currentRadius).toBe(30);
    field.adjustRadius(-10000);
    expect(field.currentRadiusVoxels).toBe(1);
    expect((field.gizmo.children[0] as THREE.Points).geometry).toBe(geometry);
    field.dispose();
    expect(scene.children).toHaveLength(0);
    expect(target.removeEventListener).toHaveBeenCalledWith("wheel", expect.any(Function));
  });
});
