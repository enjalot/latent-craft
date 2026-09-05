import * as THREE from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildEffectorSurfaceGeometry, effectorSurfaceOpacity, effectorRingLayout } from "./EffectorSurface.ts";
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

describe("Effector surface rectangles", () => {
  it("uses closed, lit solids centred on the boundary with stable slots and clearance", () => {
    for (const radius of [1, 2, 2.25, 9, 48]) {
      const geometry = buildEffectorSurfaceGeometry(radius);
      const positions = geometry.getAttribute("position");
      expect(geometry.getAttribute("normal").count).toBe(positions.count);
      expect(geometry.groups).toHaveLength(0); // one draw, not one per bar
      const radii = radiiOf(geometry);
      expect(radii[0]).toBeLessThan(radius);
      expect(radii.at(-1)).toBeGreaterThan(radius);
      const layout = effectorRingLayout(radius);
      expect(layout.map(r => r.count)).toEqual([12, 24, 36]);
      const verticesPerBar = positions.count / 72;
      let start = 0;
      for (const ring of layout) {
        const chord = 2 * radius * Math.sin(ring.angle) * Math.sin(Math.PI / ring.count);
        expect(Math.hypot(ring.length, ring.width, ring.depth)).toBeLessThan(chord);
        expect(ring.length).toBeLessThanOrEqual(1);
        for (let bar = 0; bar < ring.count; bar++) {
          const centre = new THREE.Vector3();
          for (let v = 0; v < verticesPerBar; v++) centre.add(new THREE.Vector3().fromBufferAttribute(positions, start++));
          centre.divideScalar(verticesPerBar);
          expect(centre.length()).toBeCloseTo(radius, 5);
          expect(Math.atan2(centre.y, centre.x)).toBeCloseTo(Math.atan2(Math.sin(bar * 2 * Math.PI / ring.count), Math.cos(bar * 2 * Math.PI / ring.count)), 5);
        }
      }
      geometry.dispose();
    }
    // Projected radius (tan(angle)), not just world radius, must grow in
    // open space. Otherwise camera-centred scaling is visually invisible.
    for (let radius = 1; radius < 48; radius += .25) {
      const before = effectorRingLayout(radius), after = effectorRingLayout(radius + .25);
      for (let ring = 0; ring < 3; ring++) expect(Math.tan(after[ring].angle)).toBeGreaterThan(Math.tan(before[ring].angle));
    }
    expect(() => effectorRingLayout(0)).toThrow();
    expect(() => effectorRingLayout(Infinity)).toThrow();
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

  it("follows the mouse on the sphere, reuses geometry while stationary and fades", () => {
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
    field.update(camera);
    expect(field.currentRadiusVoxels).toBe(2);
    expect(field.gizmo.visible).toBe(false);
    field.adjustRadius(1);
    field.update(camera);
    expect(field.gizmo.visible).toBe(true);
    expect(field.gizmo.scale.x).toBeCloseTo(0.625);
    const geometry = (field.gizmo.children[0] as THREE.Mesh).geometry;
    const pointer = new THREE.Vector2(.4,.2);
    field.update(camera, pointer);
    expect((field.gizmo.children[0] as THREE.Mesh).geometry).toBe(geometry);
    const ray = new THREE.Raycaster(); ray.setFromCamera(pointer, camera);
    const aim = new THREE.Vector3(0,0,-1).applyQuaternion(field.gizmo.quaternion);
    expect(aim.distanceTo(ray.ray.direction)).toBeLessThan(1e-6);
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
    field.dispose();
    expect(scene.children).toHaveLength(0);
    expect(target.removeEventListener).toHaveBeenCalledWith("wheel", expect.any(Function));
  });
});
