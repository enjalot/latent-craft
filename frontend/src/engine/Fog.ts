import * as THREE from "three";
import { FOG_COLOR, FOG_DENSITY } from "../config.ts";

/**
 * Three's `<fog_fragment>` chunk with the exp2 curve replaced by Beer-Lambert
 * (`T = exp(-density * depth)`). Everything else — the `USE_FOG` / `FOG_EXP2`
 * defines, the `fogColor` / `fogDensity` uniforms and their per-frame refresh,
 * the `vFogDepth` varying — is three's own machinery for `THREE.FogExp2`,
 * untouched. Only the one line that turns depth into a fog factor differs.
 *
 * Why a chunk override rather than per-material `onBeforeCompile` patches:
 * three has exactly two fog models, linear and exp2, and picks between them
 * with `isFogExp2` in the renderer, so a third curve can't be added as a new
 * fog class. Meanwhile every fogged material in the scene — the voxel cubes
 * (`MeshStandardMaterial`), the voxel proxies (same), the container cages (a
 * `ShaderMaterial` that `#include`s this chunk), the hover wireframe, the
 * effector gizmo — resolves `#include <fog_fragment>` from
 * `THREE.ShaderChunk` at compile time, so one assignment here gives all of
 * them the same curve. That is a requirement, not a convenience: a cage fogged
 * on exp2 around a cube fogged on exp would sit bright and sharp around a
 * block that has faded into the haze (see `VoxelContainers.ts`), which is the
 * exact mismatch the cages' `fog: true` exists to prevent.
 *
 * Must run before the first material compiles. `Engine` calls it from its
 * constructor while setting `scene.fog`, before any material exists — the
 * same ordering argument that puts the fog itself there.
 */
const BEER_LAMBERT_FOG_FRAGMENT = /* glsl */ `
#ifdef USE_FOG
	#ifdef FOG_EXP2
		float fogFactor = 1.0 - exp( - fogDensity * vFogDepth );
	#else
		float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
	#endif
	gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );
#endif
`;

/**
 * Builds the scene fog and installs the Beer-Lambert curve. The returned
 * `FogExp2` is the vehicle — it is what makes three define `FOG_EXP2` and
 * refresh a `fogDensity` uniform — but the density it carries is the
 * exponential's (see `FOG_DENSITY` in config.ts for the curve and the numbers).
 */
export function createSceneFog(): THREE.FogExp2 {
  // The override reuses three's own identifiers (`fogDensity`, `vFogDepth`,
  // `fogColor`, `FOG_EXP2`, `fogNear`/`fogFar`). A three upgrade that renamed
  // any of them would surface as a GLSL compile failure in every fogged
  // material at first render — far from here. Check the stock chunk still
  // uses the names we depend on, so the failure is one clear message at
  // startup instead.
  const stock = THREE.ShaderChunk.fog_fragment;
  for (const name of ["fogDensity", "vFogDepth", "fogColor", "FOG_EXP2", "fogNear", "fogFar"]) {
    if (!stock.includes(name)) {
      throw new Error(`three's fog_fragment no longer references '${name}' — Fog.ts's Beer-Lambert override needs updating`);
    }
  }
  THREE.ShaderChunk.fog_fragment = BEER_LAMBERT_FOG_FRAGMENT;
  return new THREE.FogExp2(FOG_COLOR, FOG_DENSITY);
}
