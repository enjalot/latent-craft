import * as THREE from "three";
import { expect, it } from "vitest";
import { HighlightCubes } from "./HighlightCubes.ts";

it("uses a readable outline for search, then restores ordinary minimap glow", () => {
  const cubes = new HighlightCubes(1, 1, 0xffb347, .32);
  cubes.begin(true); cubes.add(new THREE.Vector3()); cubes.commit();
  expect((cubes.mesh.material as THREE.MeshBasicMaterial).wireframe).toBe(true);
  cubes.begin(); cubes.add(new THREE.Vector3()); cubes.commit();
  expect((cubes.mesh.material as THREE.MeshBasicMaterial).wireframe).toBe(false);
  cubes.dispose();
});
