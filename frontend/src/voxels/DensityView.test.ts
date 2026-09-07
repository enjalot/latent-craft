import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { densityLevel, installDensityView, setDensityRendering } from "./DensityView.ts";
import { createVoxelMaterial, VOXEL_UNIFORM_SCHEMA } from "./VoxelMaterial.ts";
import type { InstancedMesh2 } from "@three.ez/instanced-mesh";

describe("stable count heatmap", () => {
  it("uses the same log scale in every chunk, safely clamping its endpoints", () => {
    expect([1,10,100,1000,10000].map(densityLevel)).toEqual([0,.25,.5,.75,1]);
    expect([0,-1,NaN,Infinity].map(densityLevel)).toEqual([0,0,0,0]);
    expect(densityLevel(1000000)).toBe(1);
  });
  it("switches atlas sampling to count coloring without losing instance alpha or bevels", () => {
    const material = createVoxelMaterial({atlas:new THREE.Texture(),tilesPerSide:16,tilePx:32});
    const shader = {uniforms:{} as Record<string,{value:unknown}>, vertexShader:THREE.ShaderLib.standard.vertexShader,fragmentShader:THREE.ShaderLib.standard.fragmentShader};
    material.onBeforeCompile(shader as never, {} as THREE.WebGLRenderer);
    expect(VOXEL_UNIFORM_SCHEMA.fragment.densityLevel).toBe("float");
    expect(shader.fragmentShader).toContain("if (uDensityView < 0.5)");
    expect(shader.fragmentShader).toContain("diffuseColor.rgb = lsDensityColor(densityLevel)");
    expect(shader.fragmentShader).toContain("#include <color_fragment>");
    expect(shader.fragmentShader).toContain("fwidth(vMapUv)");
    const mesh = {material,customSort:()=>{},sortObjects:false} as unknown as InstancedMesh2;
    setDensityRendering(mesh,true);
    expect(shader.uniforms.uDensityView.value).toBe(1); expect(material.depthWrite).toBe(false);
    setDensityRendering(mesh,false);
    expect(shader.uniforms.uDensityView.value).toBe(0); expect(material.depthWrite).toBe(true);
    material.map?.dispose(); material.dispose();
  });
  it("supports untextured proxy materials using the same palette and uniform switch", () => {
    const material = new THREE.MeshStandardMaterial(); installDensityView(material);
    const shader = {uniforms:{},vertexShader:THREE.ShaderLib.standard.vertexShader,fragmentShader:THREE.ShaderLib.standard.fragmentShader};
    material.onBeforeCompile(shader as never, {} as THREE.WebGLRenderer);
    expect(shader.fragmentShader).toContain("lsDensityColor(densityLevel)");
    expect(material.userData.densityView.value).toBe(0);
    material.dispose();
  });
});
