import * as THREE from "three";
import { InstancedMesh2 } from "@three.ez/instanced-mesh";
import type { Manifest } from "../streaming/Manifest.ts";
import type { ChunkMeta, ManifestChunk } from "../types.ts";
import {
  CONTAINER_BRACKET_LENGTH_MAX,
  CONTAINER_BRACKET_LENGTH_MIN,
  CONTAINER_BRACKET_WIDTH_MULT,
  CONTAINER_DEPLETION_BRIGHTNESS_END,
  CONTAINER_DEPLETION_BRIGHTNESS_FLOOR,
  CONTAINER_DEPLETION_OPACITY_FLOOR,
  CONTAINER_DEPLETION_OPACITY_START,
  CONTAINER_FRAME_BRIGHTNESS_MAX,
  CONTAINER_FRAME_BRIGHTNESS_MIN,
  CONTAINER_FRAME_COLOR,
  CONTAINER_RAIL_WIDTH_MAX,
  CONTAINER_RAIL_WIDTH_MIN,
  CONTAINER_SCALE,
  CONTAINER_TICKS_MAX,
  CONTAINER_TICKS_MIN,
  SUN_DIRECTION,
  VOXEL_FILL,
  capacityForPoints,
} from "../config.ts";

/**
 * Per-instance uniform schema for a container mesh: the two numbers the shader
 * draws everything from.
 *
 * - `capacity` — `capacityForPoints(count)`, 0..1: how heavy the cage is.
 * - `fullness` — `(total - extracted) / total`, 1 untouched … 0 drained: how
 *   far along the depletion ramp (dim, then fade) the whole cage is.
 *
 * These are per-instance *uniforms* (InstancedMesh2's uniform texture), not
 * `InstancedBufferAttribute`s, for the reason `VoxelMaterial.ts` gives for
 * `tileIndex`: InstancedMesh2 renders indirectly through a culling-reordered
 * `instanceIndex`, so a plain instanced attribute would be read with the wrong
 * index the moment anything is culled (the library warns and ignores such
 * attributes outright). Declared under `vertex` so they are fetched once per
 * vertex and reach the fragment shader as flat varyings — the library injects
 * `float capacity; float fullness;` at the top of both `main()`s.
 */
const CONTAINER_UNIFORM_SCHEMA = { vertex: { capacity: "float", fullness: "float" } } as const;

/**
 * Drawn after the cubes (renderOrder 0 — the textured ones and the opaque
 * voxel proxies alike) — a translucent cage has to composite over the finished
 * block inside it. Proxies never get a cage: the cage is the visible "this
 * block has been fetched" difference between the two layers.
 */
const CONTAINER_RENDER_ORDER = 1;

/** Sink for a constant into GLSL source as an unambiguous float literal. */
const f = (value: number): string => value.toFixed(4);

/**
 * Vertex stage. `<batching_pars_vertex>` / `<batching_vertex>` are where
 * InstancedMesh2 hangs its indirect-instancing chunks (`instanceIndex`, the
 * matrices texture and `getInstancedMatrix()`), and its patched
 * `<project_vertex>` applies that matrix under `USE_INSTANCING_INDIRECT` — so a
 * ShaderMaterial that includes exactly those three chunks gets the same
 * per-instance transform path the built-in materials do. The box is a unit
 * cube, so `position` doubles as the face-local coordinate the fragment stage
 * draws the cage in, and `normal` (never rotated — instances are axis-aligned)
 * says which face this is.
 */
const CONTAINER_VERTEX_SHADER = /* glsl */ `
#include <batching_pars_vertex>
#include <fog_pars_vertex>
varying vec3 vLocal;
varying vec3 vNormalLocal;

void main() {
	#include <batching_vertex>
	vLocal = position;
	vNormalLocal = normal;
	vec3 transformed = position;
	#include <project_vertex>
	#include <fog_vertex>
}
`;

/**
 * Fragment stage — the entire cage, procedurally, from the face-local position.
 *
 * Coordinates: `p` is the fragment's position on its face in [-1,1]^2, with the
 * second component chosen to be the box's local Y wherever the face has one
 * (the four side faces), so the rails at `|p.x| == 1` there run vertically.
 * `d` is the distance in from the two edge pairs; whichever is nearer decides
 * which rail the fragment belongs to, giving an along-rail coordinate `s` and
 * an across-rail depth `e`.
 *
 * Layers, outermost first:
 *
 * 1. **Coverage.** Inside `railW` of an edge (or `bracketW` within `bracketL`
 *    of a corner) the fragment is frame; everything else is the open face and
 *    is discarded, so the cube's thumbnail shows through untouched and the
 *    cage never occludes a neighbour. All boundaries are `fwidth`-anti-aliased
 *    so a distant hairline fades rather than shimmers.
 * 2. **Rail body.** Frame tint × capacity brightness × a rounded-bar profile
 *    (highlight a third of the way in, shadow at the inner boundary) × the
 *    scene's sun on the face normal.
 * 3. **Texture.** Rails (not brackets) carry `ticks` segments: a dark notch
 *    across the rail at each boundary and a rivet — dark ring, bright head — at
 *    each centre.
 * 4. **Depletion.** Two linear ramps on `fullness` applied to the WHOLE cage,
 *    one after the other (`CONTAINER_DEPLETION_*` in config.ts): from 1 down
 *    to the brightness breakpoint the colour is scaled toward the brightness
 *    floor, and from the opacity breakpoint down to 0 the alpha is scaled
 *    toward the opacity floor. The brightness scale is applied to the
 *    sRGB-encoded output (after `colorspace_fragment`), so the floor is a
 *    fraction of what is seen, not of linear light. No positional readout —
 *    the old top-down fill-line is gone — so a face-local Y never enters into
 *    it; every fragment of a cage is dimmed and faded by the same two factors.
 */
const CONTAINER_FRAGMENT_SHADER = /* glsl */ `
#include <fog_pars_fragment>
uniform vec3 uFrameColor;
uniform vec3 uSunDir;
varying vec3 vLocal;
varying vec3 vNormalLocal;

void main() {
	vec3 an = abs( vNormalLocal );
	vec2 p = an.y > 0.5 ? vLocal.xz : ( an.x > 0.5 ? vLocal.zy : vLocal.xy );
	p *= 2.0;
	vec2 d = 1.0 - abs( p );

	float railW = mix( ${f(CONTAINER_RAIL_WIDTH_MIN)}, ${f(CONTAINER_RAIL_WIDTH_MAX)}, capacity ) * 2.0;
	float bracketL = mix( ${f(CONTAINER_BRACKET_LENGTH_MIN)}, ${f(CONTAINER_BRACKET_LENGTH_MAX)}, capacity ) * 2.0;
	float bracketW = railW * ${f(CONTAINER_BRACKET_WIDTH_MULT)};

	bool onXEdge = d.x < d.y;
	float e = onXEdge ? d.x : d.y;
	float s = onXEdge ? p.y : p.x;
	float toCorner = onXEdge ? d.y : d.x;

	float aaE = fwidth( e ) * 0.8;
	float aaC = fwidth( toCorner ) * 0.8;
	float bracket = 1.0 - smoothstep( bracketL - aaC, bracketL + aaC, toCorner );
	float w = mix( railW, bracketW, bracket );
	float coverage = 1.0 - smoothstep( w - aaE, w + aaE, e );
	if ( coverage < 0.01 ) discard;

	// --- rail body -----------------------------------------------------------
	float prof = clamp( e / w, 0.0, 1.0 );
	float bar = 1.0 - 0.45 * smoothstep( 0.4, 1.0, prof )
	          + 0.18 * ( 1.0 - smoothstep( 0.0, 0.3, abs( prof - 0.22 ) ) );
	float light = 0.6 + 0.4 * max( dot( vNormalLocal, uSunDir ), 0.0 );
	float bright = mix( ${f(CONTAINER_FRAME_BRIGHTNESS_MIN)}, ${f(CONTAINER_FRAME_BRIGHTNESS_MAX)}, capacity );
	vec3 body = uFrameColor * bright * bar * light;

	// --- ticks + rivets (rails only) ----------------------------------------
	float ticks = floor( mix( ${f(CONTAINER_TICKS_MIN)}, ${f(CONTAINER_TICKS_MAX)}, capacity ) + 0.5 );
	float seg = fract( ( s + 1.0 ) * 0.5 * ticks );
	float g = abs( seg - 0.5 ) * 2.0;
	float aaG = fwidth( g ) * 0.8;
	float notch = smoothstep( 0.86 - aaG, 0.86 + aaG, g ) * ( 1.0 - bracket );
	body *= 1.0 - 0.55 * notch;

	vec2 rv = vec2( ( seg - 0.5 ) * 2.0 / ticks, ( prof - 0.5 ) * w );
	float rr = w * 0.22;
	float rd = length( rv );
	float rivet = ( 1.0 - smoothstep( rr - aaE, rr + aaE, rd ) ) * ( 1.0 - bracket );
	float rivetHead = ( 1.0 - smoothstep( rr * 0.5 - aaE, rr * 0.5 + aaE, rd ) ) * ( 1.0 - bracket );
	body = mix( body, body * 0.45, rivet );
	body = mix( body, uFrameColor * bright * light * 1.35, rivetHead );

	// --- depletion -------------------------------------------------------------
	// Brightness first (fullness 1 → BRIGHTNESS_END), then opacity
	// (OPACITY_START → 0); each ramp is linear and clamps flat outside its span.
	float dim = mix(
		${f(CONTAINER_DEPLETION_BRIGHTNESS_FLOOR)}, 1.0,
		clamp( ( fullness - ${f(CONTAINER_DEPLETION_BRIGHTNESS_END)} ) / ${f(1 - CONTAINER_DEPLETION_BRIGHTNESS_END)}, 0.0, 1.0 ) );
	float alpha = mix(
		${f(CONTAINER_DEPLETION_OPACITY_FLOOR)}, 1.0,
		clamp( fullness / ${f(CONTAINER_DEPLETION_OPACITY_START)}, 0.0, 1.0 ) );

	gl_FragColor = vec4( body, coverage * alpha );
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
	// The brightness ramp is applied AFTER the output transform, so the floor
	// is a fraction of on-screen (sRGB) brightness — 0.35 means the cage looks
	// 35% as bright, not 35% of the linear-light value (which the transform
	// would lift to ~60% on screen). Before fog, so a dim cage still fogs
	// toward the fog colour like everything else.
	gl_FragColor.rgb *= dim;
	#include <fog_fragment>
}
`;

/**
 * One container material. Per-chunk, like the voxel material and for the same
 * reason (InstancedMesh2 patches each material with closures bound to its own
 * mesh's textures); every chunk compiles byte-identical source, so the constant
 * cache key lets them all share one GL program.
 *
 * `fog: true` opts a ShaderMaterial into the scene's `FogExp2` (the `USE_FOG` /
 * `FOG_EXP2` defines and the fog uniforms three refreshes per frame — hence
 * `UniformsLib.fog` in the uniform set, without which that refresh would throw).
 * Left unfogged, a distant cluster's cages would sit bright and sharp around
 * cubes that have faded into the haze.
 */
function createContainerMaterial(): THREE.ShaderMaterial {
  const material = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uFrameColor: { value: new THREE.Color().setHex(CONTAINER_FRAME_COLOR, THREE.SRGBColorSpace) },
        uSunDir: { value: new THREE.Vector3(...SUN_DIRECTION).normalize() },
      },
    ]),
    vertexShader: CONTAINER_VERTEX_SHADER,
    fragmentShader: CONTAINER_FRAGMENT_SHADER,
    // Open faces are discarded and rail edges are anti-aliased, so the cage
    // is inherently translucent; and it must not write depth — a shell around
    // every cube that wrote depth would punch holes in the neighbours behind
    // it wherever a discarded face's edge pixels landed.
    transparent: true,
    depthWrite: false,
    fog: true,
  });
  material.customProgramCacheKey = () => "ls-voxel-container-v2";
  return material;
}

const _scratchCenter = new THREE.Vector3();

/**
 * One chunk's container layer: a persistent cage around every occupied voxel's
 * cube, whose heft says how many thumbnails are inside and which dims, then
 * fades, as they are extracted (see `config.ts`'s "Voxel containers" section
 * for the ask and the tuning surface, and the shader above for the look).
 *
 * ## Structure
 *
 * One extra `InstancedMesh2` per chunk, built alongside the cube mesh with
 * EXACTLY its instance count and instance-id order (`meta.occupied`
 * ascending), so instance `i` here wraps instance `i` of the cube mesh and
 * every existing per-instance hook — mining's extracted fraction, the Effector
 * Field's suppression — addresses the cage with the id it already holds. It is
 * parented to the chunk's voxel mesh rather than hung off the scene root:
 * `ChunkStore`'s add/remove and `ChunkLoader.unload`'s explicit `dispose` carry
 * it along, with no second residency table. The parent's matrix is the identity
 * (instances carry world positions), so being a child costs no transform math.
 *
 * ## Not raycastable
 *
 * `main.ts` raycasts `chunkStore.group` RECURSIVELY, so a child mesh would be
 * hit-tested — and the cage is *outside* the cube, so a hit on it would always
 * win over the cube and resolve to a mesh with no `chunkId`, i.e. "hovering
 * nothing" while the cursor is plainly on a voxel. `raycast` is overridden to a
 * no-op (three's `Raycaster` calls `object.raycast()` per object and skips one
 * that adds no intersections). Layers were the alternative and are wrong here:
 * three tests the same `layers` mask for camera visibility, so hiding the cage
 * from the raycaster that way would hide it from the render too.
 *
 * ## Per-frame cost
 *
 * One draw call per resident chunk and one instance per voxel, with
 * InstancedMesh2's per-instance frustum culling on and a BVH built once at
 * load (instances are static for the chunk's life) — the same deal the voxel
 * mesh already accepts, so the drawn count tracks what is on screen rather
 * than what is resident.
 */
export class VoxelContainers {
  readonly mesh: InstancedMesh2;

  /** Shadow of each instance's `fullness` uniform, so a hook re-applying an
   * unchanged fraction (X-Ray toggles, residency passes) skips the texture
   * upload rather than enqueueing a row for nothing. */
  private readonly fullness: Float32Array;
  /** 1 while the Effector Field is hiding voxel `i` (see `setSuppressed`). */
  private readonly suppressed: Uint8Array;
  private suppressedCount = 0;
  private xrayActive = false;
  private detailVisible = true;

  private readonly geometry: THREE.BoxGeometry;
  private readonly material: THREE.ShaderMaterial;

  private constructor(mesh: InstancedMesh2, geometry: THREE.BoxGeometry, material: THREE.ShaderMaterial, count: number) {
    this.mesh = mesh;
    this.geometry = geometry;
    this.material = material;
    this.fullness = new Float32Array(count).fill(1);
    this.suppressed = new Uint8Array(count);
  }

  /** Builds the container layer for one loaded chunk — one cage per occupied
   * voxel, all at fullness 1 (`MiningController.onChunkResident` re-applies
   * any drained voxels' fractions right after the chunk becomes resident). */
  static build(
    entry: ManifestChunk,
    meta: ChunkMeta,
    manifest: Manifest,
    renderer: THREE.WebGLRenderer,
  ): VoxelContainers {
    const occupied = meta.occupied;
    const count = occupied.length;

    // Geometry and material are BOTH per-chunk, exactly as `ChunkLoader` does
    // for the voxel mesh and for the same two reasons: InstancedMesh2 writes
    // its own `instanceIndex` attribute into whatever geometry it is handed,
    // and patches the material with per-mesh closures. A unit box is 24
    // vertices, and every material here compiles to the same GL program.
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const material = createContainerMaterial();
    const mesh = new InstancedMesh2(geometry, material, {
      capacity: Math.max(1, count),
      renderer,
    });
    mesh.name = `chunk-${entry.chunk_id}-containers`;
    mesh.renderOrder = CONTAINER_RENDER_ORDER;
    // See the class doc comment — a cage must never absorb a voxel hover.
    mesh.raycast = () => {};
    // Must precede any setUniform call — it allocates the uniform texture at
    // the mesh's capacity.
    mesh.initUniformsPerInstance(CONTAINER_UNIFORM_SCHEMA);

    const edge = manifest.voxelWorldSize * VOXEL_FILL * CONTAINER_SCALE;
    const { cx, cy, cz } = entry;
    mesh.addInstances(count, (instance, index) => {
      const localVoxelId = occupied[index];
      manifest.voxelCenterWorld(cx, cy, cz, localVoxelId, _scratchCenter);
      instance.position.copy(_scratchCenter);
      instance.scale.setScalar(edge);
      instance.setUniform("capacity", capacityForPoints(meta.count[localVoxelId]));
      instance.setUniform("fullness", 1);
    });

    // Built after the instances exist, for culling (this mesh is never
    // raycast) — the same one-shot build `ChunkLoader` does for the voxel
    // mesh, for the same reason: instances are static for the chunk's life.
    mesh.computeBVH();

    return new VoxelContainers(mesh, geometry, material, count);
  }

  /** Cages in this chunk — always equal to the chunk's voxel count. */
  get instanceCount(): number {
    return this.fullness.length;
  }

  /** Cages not currently hidden by the Effector Field. */
  get visibleInstanceCount(): number {
    return this.fullness.length - this.suppressedCount;
  }

  /** Cages the last frame actually drew, after per-instance frustum culling
   * — zero while X-Ray has the whole mesh hidden (the renderer never visits
   * an invisible object, so `mesh.count` would otherwise report the stale
   * pre-X-Ray culling result). */
  get drawnInstanceCount(): number {
    return this.mesh.visible ? this.mesh.count : 0;
  }

  /** Current fullness of cage `instanceId`, 1 full … 0 drained. */
  fullnessAt(instanceId: number): number {
    return this.fullness[instanceId] ?? 1;
  }

  /**
   * Sets a cage's fullness from its voxel's extraction state — the SAME
   * fraction `MiningController` feeds `combinedVoxelOpacity` for the cube's
   * fade, so the two readouts can never disagree. Stored as fullness
   * (`1 - fraction`) because that is what the shader's depletion ramps read.
   */
  setExtractedFraction(instanceId: number, extractedFraction: number): void {
    if (instanceId < 0 || instanceId >= this.fullness.length) return;
    const fullness = 1 - Math.max(0, Math.min(1, extractedFraction));
    if (this.fullness[instanceId] === fullness) return;
    this.fullness[instanceId] = fullness;
    this.mesh.setUniformAt(instanceId, "fullness", fullness);
  }

  /**
   * Hides/reveals a cage alongside its voxel when the Effector Field
   * suppresses it (`EffectorFieldController` calls `setVisibilityAt(false)` on
   * the cube to reach through a cluster). Without this the cube would vanish
   * and its cage would stay behind, an empty frame floating in the hole. Same
   * `setVisibilityAt` gate, which also drops the instance from culling — and,
   * were this mesh raycastable, from raycasting.
   */
  setSuppressed(instanceId: number, suppressed: boolean): void {
    if (instanceId < 0 || instanceId >= this.suppressed.length) return;
    const value = suppressed ? 1 : 0;
    if (this.suppressed[instanceId] === value) return;
    this.suppressed[instanceId] = value;
    this.suppressedCount += suppressed ? 1 : -1;
    this.mesh.setVisibilityAt(instanceId, !suppressed);
  }

  /**
   * X-Ray hook: the cages vanish entirely while X-Ray is equipped ("xray
   * should hide the greeble completely"). The mesh is switched off at the
   * object level rather than drawn at zero alpha — the renderer skips an
   * invisible object outright, so a resident world's worth of cages (up to
   * ~4,096 per chunk, tens of thousands in total) costs no draw calls, no
   * culling pass and no fragment work while X-Ray is on, whereas a 0-alpha
   * draw would still rasterize every rail and discard it. There is no
   * per-cage component to X-Ray, so one flag per chunk is exactly the right
   * granularity, and the Effector Field's per-instance `setVisibilityAt`
   * state underneath is untouched by it: un-equipping X-Ray shows the mesh
   * again with whatever instances the field is still suppressing still
   * hidden.
   */
  setXrayActive(active: boolean): void {
    this.xrayActive = active;
    this.syncMeshVisibility();
  }

  /** Distance LOD: cages are close-range detail and disappear before their
   * full-face discard shader becomes expensive for tiny on-screen voxels. */
  setDetailVisible(visible: boolean): void {
    if (visible === this.detailVisible) return;
    this.detailVisible = visible;
    this.syncMeshVisibility();
  }

  private syncMeshVisibility(): void {
    this.mesh.visible = !this.xrayActive && this.detailVisible;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.dispose();
    this.geometry.dispose();
    this.material.dispose();
  }
}
