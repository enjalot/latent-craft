import * as THREE from "three";
import type { InstancedMesh2 } from "@three.ez/instanced-mesh";
import { ATLAS_TILE_INSET_TEXELS, VOXEL_COVERAGE_DITHER, VOXEL_UNDERLIGHT } from "../config.ts";
import { installDensityView } from "./DensityView.ts";

/**
 * Per-instance uniform schema every voxel chunk mesh declares. `tileIndex` is
 * either local_voxel_id (legacy fixed atlases) or the occupied instance index
 * (compact atlases).
 *
 * We use `InstancedMesh2.initUniformsPerInstance` rather than hand-rolling an
 * `InstancedBufferAttribute`: InstancedMesh2 renders *indirectly* (instances
 * are addressed through a `uint instanceIndex` attribute that its frustum
 * culling reorders every frame), so a plain per-instance attribute would be
 * read with the wrong index the moment culling or sorting kicks in. The
 * library's uniform texture is indexed by `instanceIndex`, so it stays correct.
 * Declaring the uniform under `fragment` (not `vertex`) makes the library fetch
 * it in the fragment shader — exactly where the atlas UV is computed.
 */
export const VOXEL_UNIFORM_SCHEMA = { fragment: { tileIndex: "float", densityLevel: "float", atlasAllowed: "float" } } as const;

/**
 * Replacement for three's `<map_fragment>`. `tileIndex` is in scope here
 * because InstancedMesh2 injects its per-instance uniform fetch immediately
 * after `void main() {`, which runs before this point in the shader body.
 */
const ATLAS_MAP_FRAGMENT = /* glsl */ `
#ifdef USE_MAP
	if (uDensityView < 0.5 && atlasAllowed > 0.5) {
	float lsTilesPerSide = uTilesPerSide;
	float lsTileX = mod( tileIndex, lsTilesPerSide );
	float lsTileY = floor( tileIndex / lsTilesPerSide );
	// Inset by half a texel so bilinear filtering at the tile border can't
	// reach into the neighbouring thumbnail.
	vec2 lsUv = clamp( vMapUv, uTileInset, 1.0 - uTileInset );
	// KTX2/Basis textures are uploaded with flipY = false (compressed data
	// can't be flipped on upload), so atlas row 0 is the *top* of the sheet
	// while three's box UVs put v = 1 at the top of a face. Flipping v inside
	// the tile is what keeps the book covers the right way up.
	vec2 lsAtlasUv = vec2( lsTileX + lsUv.x, lsTileY + 1.0 - lsUv.y ) / lsTilesPerSide;
	vec4 sampledDiffuseColor = texture2D( map, lsAtlasUv );
	diffuseColor *= sampledDiffuseColor;
	} else if (uDensityView < 0.5) {
	diffuseColor.rgb *= vec3(0.32, 0.36, 0.37);
	}
#endif
`;

/** Virtual bevel, evaluated in the face's derivative-derived tangent frame.
 * No extra geometry, textures or draw calls. Screen derivatives soften the
 * bevel below pixel size, avoiding sparkling on distant 32px atlas blocks. */
export const VOXEL_BEVEL_FRAGMENT = /* glsl */ `
  #include <normal_fragment_maps>
  #ifdef USE_MAP
    vec2 lsFace = vMapUv - 0.5;
    vec2 lsAA = max(fwidth(vMapUv), vec2(0.001));
    vec2 lsEdge = smoothstep(vec2(0.455) - lsAA, vec2(0.5) + lsAA, abs(lsFace));
    vec3 lsDx = dFdx(-vViewPosition), lsDy = dFdy(-vViewPosition);
    vec2 lsUx = dFdx(vMapUv), lsUy = dFdy(vMapUv);
    float lsDet = lsUx.x * lsUy.y - lsUx.y * lsUy.x;
    vec3 lsT = (lsDx * lsUy.y - lsDy * lsUx.y) * sign(lsDet);
    vec3 lsB = (lsDy * lsUx.x - lsDx * lsUy.x) * sign(lsDet);
    lsT /= max(length(lsT), 1e-8);
    lsB /= max(length(lsB), 1e-8);
    normal = normalize(normal + 0.65 * (lsT * sign(lsFace.x) * lsEdge.x + lsB * sign(lsFace.y) * lsEdge.y));
    // Polished edges around a satin image face. No high-frequency noise.
    roughnessFactor = mix(roughnessFactor, 0.23, max(lsEdge.x, lsEdge.y));
  #endif
`;

/**
 * Ground-bounce fill, injected just before three's `<opaque_fragment>` (which
 * is where `outgoingLight` has been assembled but not yet written out).
 *
 * The bug this fixes: the scene's lighting is one directional sun from above
 * plus a hemisphere light whose ground color is near-black — no ambient term,
 * and no ground to bounce off, because the world is a cube of blocks floating
 * in a void. (The Phase 7 headlamp is a point light behind the camera, so it
 * reaches an underside only while you are beneath it; the argument stands.) A
 * face pointing straight down therefore gets
 * `max(dot(n, sunDir), 0) == 0` from the sun and the pure ground color from the
 * hemisphere, i.e. essentially zero light. Measured on a real voxel before this
 * fix: the -Y face read luminance 6/255 (visually black) while the +X face read
 * 133 and the +Y face 165 — the underside of every voxel was a black square
 * instead of the thumbnail its other five faces show.
 *
 * `lsDownFacing` is the ground half of a hemisphere light's weighting (1 when
 * the face points straight down, 0.5 side-on, 0 straight up), so this only
 * fills in the faces the existing lights can't reach and leaves the sunlit top
 * face exactly as it was.
 *
 * Why it lives in the material and not as a brighter `HemisphereLight` ground
 * color in `main.ts`: "every face of a voxel shows its thumbnail" is a property
 * of the voxel material's own contract (one tile, six faces), not of whatever
 * lighting rig the scene happens to have. Keeping it here means the atlas stays
 * legible if the scene's lights are ever retuned, and it doesn't silently
 * brighten the flat voxel proxies or the effector gizmo along with it (a
 * proxy's underside going dark is fine — it is a stand-in, not a thumbnail).
 *
 * `normal` (view-space, already normalized by `<normal_fragment_begin>`) and
 * `viewMatrix` (declared in three's own fragment prefix) are both in scope
 * here; `viewMatrix * vec4(worldUp, 0)` is the world Y axis in view space.
 *
 * The second half is the alpha-to-coverage dither — see `createVoxelMaterial`
 * for why translucency goes through coverage at all. With 4x MSAA the hardware
 * turns alpha into one of only five coverage levels (0/4 … 4/4), so a plain
 * `diffuseColor.a = 0.3` would render as a flat 25% and the continuous
 * extraction fade would visibly step. Offsetting alpha per pixel by a 4x4
 * Bayer threshold (±half a coverage level, `uCoverageDither`) spreads the
 * quantization across neighbouring pixels so the average coverage tracks the
 * requested alpha — ordered dithering, the same trick as screen-door
 * transparency but hidden under the MSAA resolve. Guarded by both
 * `ALPHA_TO_COVERAGE` and `0 < a < 1`, so X-ray gets clean alpha and a source
 * replaced by a sharp preview stays at exactly zero coverage on any MSAA rig.
 */
const VOXEL_OUTPUT_FRAGMENT = /* glsl */ `
	vec3 lsUpView = normalize( ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz );
	float lsDownFacing = 0.5 - 0.5 * clamp( dot( normal, lsUpView ), -1.0, 1.0 );
	outgoingLight += diffuseColor.rgb * uUnderlight * lsDownFacing;
	#ifdef ALPHA_TO_COVERAGE
	if ( diffuseColor.a > 0.0 && diffuseColor.a < 1.0 ) {
		const float lsBayer4[16] = float[16]( 0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0 );
		ivec2 lsPx = ivec2( gl_FragCoord.xy ) & 3;
		float lsThreshold = ( lsBayer4[ lsPx.y * 4 + lsPx.x ] + 0.5 ) / 16.0;
		diffuseColor.a = clamp( diffuseColor.a + ( lsThreshold - 0.5 ) * uCoverageDither, 0.0, 1.0 );
	}
	#endif
	#include <opaque_fragment>
`;

export interface VoxelMaterialParams {
  /** The chunk's KTX2 atlas. */
  atlas: THREE.Texture;
  /** This chunk's atlas tiles per side. */
  tilesPerSide: number;
  /** `manifest.atlas.tile_px`, used only to size the anti-bleed inset. */
  tilePx: number;
}

/**
 * One chunk's material: a stock `MeshStandardMaterial` (so it keeps working
 * with the scene's existing hemisphere + sun lighting, and with three's own
 * shadow/depth passes) whose `<map_fragment>` is swapped for atlas-tile
 * sampling.
 *
 * A raw `ShaderMaterial` is NOT an option here: InstancedMesh2's indirect
 * instancing, its per-instance uniform texture, and its matrix texture are all
 * injected into three's *built-in* shader chunks via `onBeforeCompile`. A
 * from-scratch shader gets none of that and renders every instance at the
 * origin.
 *
 * v1 scope: one thumbnail per voxel, repeated on all six faces — that matches
 * the data contract, which stores a single `repr_row_id`/tile per voxel.
 *
 * ## Two deliberate translucency paths
 *
 * Per-voxel fading writes an instance opacity
 * through `InstancedMesh2.setOpacityAt`, which reaches the shader as
 * `diffuseColor.a` (the library defines `USE_COLOR_ALPHA`, so three's own
 * `<color_fragment>` multiplies it in). The material stays in the OPAQUE queue
 * with depth writes on and `alphaToCoverage: true`: the MSAA hardware converts
 * that alpha into a per-sample coverage mask, and the resolve blends the
 * covered samples with whatever is behind. Visually it's transparency; in the
 * pipeline it's an opaque draw.
 *
 * Why not leave `material.transparent = true` all the time: a chunk is
 * ONE instanced draw, and InstancedMesh2 emits instances in its own
 * culling-reordered sequence, not back-to-front. With the material in the
 * transparent queue but depth writes still on, a faded cube drawn before the
 * cubes behind it stamped its depth first, so the ones drawn later failed the
 * depth test and vanished wherever it covered them — while cubes drawn earlier
 * showed through fine. The user-visible symptom was "a transparent block makes
 * some, but not all, of the blocks behind it disappear." Coverage is
 * order-independent: no sorting, correct depth for everything drawn after,
 * and one fast code path for the normal view's sparse extraction fades.
 *
 * Pickaxe glass view is the explicit exception. `XRayController` temporarily
 * moves these same materials into the transparent queue, disables depth
 * writes and alpha-to-coverage, and enables InstancedMesh2's back-to-front
 * instance sorting. That is more expensive, but it is the path that lets
 * multiple directly aligned cubes blend as simple glass layers; the cost
 * exists only while the tool is equipped.
 *
 * Requirements this leans on: the renderer's drawing buffer is multisampled
 * (`Engine` creates it with `antialias: true`) — alpha-to-coverage is a no-op
 * on a single-sample target, so any future post-processing chain has to render
 * into a multisampled target or this silently reverts to fully opaque. Three
 * also stops forcing `diffuseColor.a = 1.0` (its `OPAQUE` define) precisely
 * when `alphaToCoverage` is set, which is what lets the alpha through.
 */
export function createVoxelMaterial(params: VoxelMaterialParams): THREE.MeshStandardMaterial {
  const { atlas, tilesPerSide, tilePx } = params;

  const material = new THREE.MeshStandardMaterial({
    map: atlas,
    roughness: 0.42,
    metalness: 0.04,
    envMapIntensity: 0.8,
    alphaToCoverage: true,
  });

  const tilesPerSideUniform = { value: tilesPerSide };
  const tileInsetUniform = { value: ATLAS_TILE_INSET_TEXELS / tilePx };
  const underlightUniform = { value: VOXEL_UNDERLIGHT };
  const coverageDitherUniform = { value: VOXEL_COVERAGE_DITHER };

  // Set BEFORE the material is ever rendered: InstancedMesh2 saves whatever
  // `onBeforeCompile` it finds as its "base" and calls it first, then layers
  // its own instancing patches on top. Assigning ours later would be silently
  // dropped (it captures the base once, at first patchMaterial).
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTilesPerSide = tilesPerSideUniform;
    shader.uniforms.uTileInset = tileInsetUniform;
    shader.uniforms.uUnderlight = underlightUniform;
    shader.uniforms.uCoverageDither = coverageDitherUniform;
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <map_pars_fragment>",
        "#include <map_pars_fragment>\nuniform float uTilesPerSide;\nuniform float uTileInset;\nuniform float uUnderlight;\nuniform float uCoverageDither;",
      )
      .replace("#include <map_fragment>", ATLAS_MAP_FRAGMENT)
      .replace("#include <normal_fragment_maps>", VOXEL_BEVEL_FRAGMENT)
      .replace("#include <opaque_fragment>", VOXEL_OUTPUT_FRAGMENT);
  };
  // Every chunk compiles byte-identical shader source, so a constant key lets
  // all of them share one GL program instead of one per chunk. The key is what
  // three's program cache dedupes on, so it's bumped whenever the patched
  // source changes (v2: underlight; v3: coverage dither; v4: glass-mode
  // dither guard; v5: exact zero coverage; v6: filtered bevel normals) — a stale entry would
  // otherwise keep serving the previous shader within a session that had
  // already compiled one.
  material.customProgramCacheKey = () => "ls-voxel-atlas-v7-metadata";
  installDensityView(material);

  return material;
}

/** Declares the per-instance uniform block a voxel chunk mesh needs. Must be
 * called after construction (it sizes itself from the mesh's capacity) and
 * before any `setUniform("tileIndex", …)`. */
export function initVoxelUniforms(mesh: InstancedMesh2): void {
  mesh.initUniformsPerInstance(VOXEL_UNIFORM_SCHEMA as unknown as { fragment: Record<string, "float"> });
}
