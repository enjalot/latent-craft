import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { SkyBackdrop } from "./SkyBackdrop.ts";

describe("sky backdrop", () => {
  it("uses one unclipped triangle, drawn before opaque geometry without depth writes", () => {
    const sky = new SkyBackdrop(new THREE.CubeTexture());
    expect(sky.mesh.geometry.getAttribute("position").count).toBe(3);
    expect(sky.mesh.frustumCulled).toBe(false);
    expect(sky.mesh.renderOrder).toBeLessThan(0);
    expect(sky.mesh.material).toMatchObject({ depthTest: false, depthWrite: false, transparent: false, fog: false });
    sky.dispose();
  });

  it("reconstructs camera rays across face boundaries, ignoring position and following FOV", () => {
    const sky = new SkyBackdrop(new THREE.CubeTexture());
    const camera = new THREE.PerspectiveCamera(75, 1.44, .05, 1200);
    for (const fov of [45, 75, 110]) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
      camera.position.set(-5.8, 28.3, 5.3);
      camera.lookAt(10, 20, -5);
      camera.updateMatrixWorld();
      sky.updateCamera(camera);
      const uniforms = sky.mesh.material.uniforms;
      for (const x of [-1, 0, 1]) for (const y of [-1, 0, 1]) {
        const clip = new THREE.Vector4(x, y, 1, 1).applyMatrix4(uniforms.inverseProjection.value);
        const ray = new THREE.Vector3(clip.x, clip.y, clip.z).transformDirection(uniforms.cameraWorld.value);
        const expected = new THREE.Vector3(x, y, 1).unproject(camera).sub(camera.position).normalize();
        expect(ray.distanceTo(expected)).toBeLessThan(1e-10);
      }
    }
    sky.dispose();
  });

  it("disposes its draw resources, not the shared cubemap", () => {
    const texture = new THREE.CubeTexture(), sky = new SkyBackdrop(texture), scene = new THREE.Scene();
    scene.add(sky.mesh);
    const geometry = vi.spyOn(sky.mesh.geometry, "dispose"), material = vi.spyOn(sky.mesh.material, "dispose"), cube = vi.spyOn(texture, "dispose");
    sky.dispose();
    expect(scene.children).toHaveLength(0);
    expect(geometry).toHaveBeenCalledOnce(); expect(material).toHaveBeenCalledOnce(); expect(cube).not.toHaveBeenCalled();
  });
});
