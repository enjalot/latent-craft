import * as THREE from "three";
import type { InstancedMesh2 } from "@three.ez/instanced-mesh";
import { ATLAS_TILE_INSET_TEXELS, VOXEL_UNDERLIGHT } from "../config.ts";

/**
 * Per-instance uniform schema every voxel chunk mesh declares. `tileIndex` is
 * the voxel's `local_voxel_id`, which the pipeline guarantees IS its atlas tile
 * index (16^3 voxels per chunk == 64^2 tiles per atlas).
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
export const VOXEL_UNIFORM_SCHEMA = { fragment: { tileIndex: "float" } } as const;

/**
 * Replacement for three's `<map_fragment>`. `tileIndex` is in scope here
 * because InstancedMesh2 injects its per-instance uniform fetch immediately
 * after `void main() {`, which runs before this point in the shader body.
 */
const ATLAS_MAP_FRAGMENT = /* glsl */ `
#ifdef USE_MAP
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
#endif
`;

/**
 * Ground-bounce fill, injected just before three's `<opaque_fragment>` (which
 * is where `outgoingLight` has been assembled but not yet written out).
 *
 * The bug this fixes: the scene's lighting is one directional sun from above
 * plus a hemisphere light whose ground color is near-black, and nothing else —
 * no ambient term, and no ground to bounce off, because the world is a cube of
 * blocks floating in a void. A face pointing straight down therefore gets
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
 * brighten the translucent proxy cloud or the effector gizmo along with it.
 *
 * `normal` (view-space, already normalized by `<normal_fragment_begin>`) and
 * `viewMatrix` (declared in three's own fragment prefix) are both in scope
 * here; `viewMatrix * vec4(worldUp, 0)` is the world Y axis in view space.
 */
const VOXEL_UNDERLIGHT_FRAGMENT = /* glsl */ `
	vec3 lsUpView = normalize( ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz );
	float lsDownFacing = 0.5 - 0.5 * clamp( dot( normal, lsUpView ), -1.0, 1.0 );
	outgoingLight += diffuseColor.rgb * uUnderlight * lsDownFacing;
	#include <opaque_fragment>
`;

export interface VoxelMaterialParams {
  /** The chunk's KTX2 atlas. */
  atlas: THREE.Texture;
  /** `manifest.atlas.tiles_per_side` (64 for a 2048px sheet of 32px tiles). */
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
 */
export function createVoxelMaterial(params: VoxelMaterialParams): THREE.MeshStandardMaterial {
  const { atlas, tilesPerSide, tilePx } = params;

  const material = new THREE.MeshStandardMaterial({
    map: atlas,
    roughness: 0.9,
    metalness: 0.0,
  });

  const tilesPerSideUniform = { value: tilesPerSide };
  const tileInsetUniform = { value: ATLAS_TILE_INSET_TEXELS / tilePx };
  const underlightUniform = { value: VOXEL_UNDERLIGHT };

  // Set BEFORE the material is ever rendered: InstancedMesh2 saves whatever
  // `onBeforeCompile` it finds as its "base" and calls it first, then layers
  // its own instancing patches on top. Assigning ours later would be silently
  // dropped (it captures the base once, at first patchMaterial).
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTilesPerSide = tilesPerSideUniform;
    shader.uniforms.uTileInset = tileInsetUniform;
    shader.uniforms.uUnderlight = underlightUniform;
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <map_pars_fragment>",
        "#include <map_pars_fragment>\nuniform float uTilesPerSide;\nuniform float uTileInset;\nuniform float uUnderlight;",
      )
      .replace("#include <map_fragment>", ATLAS_MAP_FRAGMENT)
      .replace("#include <opaque_fragment>", VOXEL_UNDERLIGHT_FRAGMENT);
  };
  // Every chunk compiles byte-identical shader source, so a constant key lets
  // all of them share one GL program instead of one per chunk. Bumped to v2
  // when the underlight patch was added — the key is what three's program
  // cache dedupes on, so a stale v1 entry would keep serving the old,
  // black-bottomed shader within a session that had already compiled one.
  material.customProgramCacheKey = () => "ls-voxel-atlas-v2";

  return material;
}

/** Declares the per-instance uniform block a voxel chunk mesh needs. Must be
 * called after construction (it sizes itself from the mesh's capacity) and
 * before any `setUniform("tileIndex", …)`. */
export function initVoxelUniforms(mesh: InstancedMesh2): void {
  mesh.initUniformsPerInstance(VOXEL_UNIFORM_SCHEMA as unknown as { fragment: Record<string, "float"> });
}
