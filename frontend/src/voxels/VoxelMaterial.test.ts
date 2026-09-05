import * as THREE from "three";
import {describe, expect, it} from "vitest";
import {createVoxelMaterial} from "./VoxelMaterial.ts";

describe("physical atlas shading", () => {
  it("adds filtered bevel lighting without changing atlas sampling or coverage", () => {
    const atlas=new THREE.Texture(), material=createVoxelMaterial({atlas,tilesPerSide:16,tilePx:32});
    const shader={uniforms:{},vertexShader:THREE.ShaderLib.standard.vertexShader,
      fragmentShader:THREE.ShaderLib.standard.fragmentShader};
    material.onBeforeCompile(shader as never, {} as THREE.WebGLRenderer);
    expect(shader.fragmentShader).toContain("fwidth(vMapUv)");
    expect(shader.fragmentShader).toContain("normal = normalize(normal + 0.65");
    expect(shader.fragmentShader).toContain("lsAtlasUv");
    expect(shader.fragmentShader).toContain("diffuseColor.a > 0.0");
    expect(material.map).toBe(atlas);expect(material.alphaToCoverage).toBe(true);
    expect(material.transparent).toBe(false);expect(material.depthWrite).toBe(true);
    material.dispose();atlas.dispose();
  });
});
