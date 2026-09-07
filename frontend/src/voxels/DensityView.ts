import * as THREE from "three";
import { createRadixSort, type InstancedMesh2 } from "@three.ez/instanced-mesh";

/** Fixed across chunks, LODs and camera movement. The final stop is 10,000+. */
export const DENSITY_STOPS = ["#3b1e6d", "#2952a3", "#11b5af", "#f2a65a", "#fff0a3"];
export function densityLevel(count: number): number {
  return Number.isFinite(count) ? Math.min(1, Math.max(0, Math.log10(Math.max(1, count)) / 4)) : 0;
}

const colors = DENSITY_STOPS.map(hex => {
  const c = new THREE.Color(hex);
  return `vec3(${c.toArray().map(n => n.toFixed(8)).join(",")})`;
});
const palette = `
uniform float uDensityView;
vec3 lsDensityColor(float level) {
  float x = clamp(level, 0.0, 1.0) * 4.0;
  vec3 c = ${colors[0]};
  ${colors.slice(1).map((c, i) => `c = mix(c, ${c}, clamp(x - ${i.toFixed(1)}, 0.0, 1.0));`).join("\n")}
  return c;
}`;

/** Replace surface color after instance tinting, preserving opacity, fog,
 * geometry and some lighting. All instances provide a densityLevel uniform. */
export function installDensityView(material: THREE.Material): void {
  const enabled = { value: 0 };
  material.userData.densityView = enabled;
  const compile = material.onBeforeCompile, key = material.customProgramCacheKey();
  material.onBeforeCompile = (shader, renderer) => {
    compile.call(material, shader, renderer);
    shader.uniforms.uDensityView = enabled;
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${palette}`)
      .replace("#include <color_fragment>", `#include <color_fragment>
        if (uDensityView > 0.5) diffuseColor.rgb = lsDensityColor(densityLevel);`)
      .replace("#include <opaque_fragment>", `
        if (uDensityView > 0.5) outgoingLight = mix(outgoingLight, diffuseColor.rgb, 0.65);
        #include <opaque_fragment>`);
  };
  material.customProgramCacheKey = () => `${key}:density-v1`;
}

/** True glass blending, shared by loaded voxels and count-bearing proxies. */
export function setDensityRendering(mesh: InstancedMesh2, active: boolean): void {
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  for (const material of materials) {
    if (material.userData.densityView) material.userData.densityView.value = active ? 1 : 0;
    const changed = material.transparent !== active || material.depthWrite === active || material.alphaToCoverage === active;
    material.transparent = active;
    material.depthWrite = !active;
    material.alphaToCoverage = !active;
    material.blending = THREE.NormalBlending;
    if (changed) material.needsUpdate = true;
  }
  if (active && !mesh.customSort) mesh.customSort = createRadixSort(mesh);
  mesh.sortObjects = active;
}
