import * as THREE from "three";
import { InstancedMesh2 } from "@three.ez/instanced-mesh";
import type { Manifest } from "../streaming/Manifest.ts";
import type { ChunkMeta, ManifestChunk } from "../types.ts";
import {
  GREEBLE_ARCHETYPES,
  GREEBLE_COLOR,
  GREEBLE_EDGE_MARGIN,
  GREEBLE_METALNESS,
  GREEBLE_PROTRUSION,
  GREEBLE_ROUGHNESS,
  GREEBLE_SHADE_JITTER,
  GREEBLE_SIZE_JITTER,
  VOXEL_FILL,
  greebleCountForPoints,
} from "../config.ts";

/**
 * Deterministic 32-bit PRNG (mulberry32) — the same generator `engine/
 * Starfield.ts` uses, for the same reason: every random-looking decision in
 * this project has to be reproducible.
 *
 * Here it is load-bearing rather than merely convenient. A chunk's
 * `InstancedMesh2` is disposed on eviction and rebuilt from scratch when the
 * camera comes back, so `Math.random()` placement would silently reshuffle
 * every greeble on a voxel the player had been looking at — and it would do so
 * *while* that voxel's extraction state (which greebles are broken off) was
 * being faithfully restored from `MiningController`, producing a partially
 * broken voxel whose surviving pieces moved. Seeding from the voxel's own
 * identity makes the geometry as persistent as the state on top of it.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The seed for one voxel: its global identity, mixed.
 *
 * `(chunkId, localVoxelId)` is exactly the key `MiningController` persists
 * extraction state under and the pair `row_to_voxel.bin` addresses voxels by,
 * so it is the canonical per-voxel identity in this codebase — not an incidental
 * load-order index, which is what would break across an evict/reload. The two
 * are combined and then passed through a xorshift-multiply avalanche so that
 * neighbouring voxels (whose ids differ by 1) don't produce visibly correlated
 * placements.
 */
function voxelSeed(chunkId: number, localVoxelId: number): number {
  let h = (Math.imul(chunkId, 0x9e3779b1) ^ Math.imul(localVoxelId + 1, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/** One of a cube's 12 edges, in cube-local units (edge length 1, centred on the
 * origin) — scaled up to world units per voxel at build time. */
interface CubeEdge {
  /** Unit vector along the edge. */
  along: THREE.Vector3;
  /** Unit vector out of the cube, bisecting the two faces that meet here. */
  outward: THREE.Vector3;
  /** `along × outward`, completing a right-handed frame. */
  tangent: THREE.Vector3;
  /** The edge's midpoint. */
  anchor: THREE.Vector3;
}

/**
 * The 12 edges, each with an orthonormal frame. A greeble is placed in its
 * edge's frame — `along` for the piece's length, `outward` for how far it
 * protrudes, `tangent` for the third axis — which is what makes "oriented
 * outward from the cube surface" fall out of the archetype's size triple
 * instead of needing per-piece orientation logic.
 */
const CUBE_EDGES: readonly CubeEdge[] = buildCubeEdges();

function buildCubeEdges(): CubeEdge[] {
  const axes = [
    new THREE.Vector3(1, 0, 0),
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(0, 0, 1),
  ];
  const edges: CubeEdge[] = [];
  for (let a = 0; a < 3; a++) {
    const along = axes[a];
    const b = axes[(a + 1) % 3];
    const c = axes[(a + 2) % 3];
    for (const sb of [-1, 1]) {
      for (const sc of [-1, 1]) {
        const anchor = new THREE.Vector3().addScaledVector(b, sb * 0.5).addScaledVector(c, sc * 0.5);
        const outward = anchor.clone().normalize();
        const tangent = new THREE.Vector3().crossVectors(along, outward).normalize();
        edges.push({ along: along.clone(), outward, tangent, anchor });
      }
    }
  }
  return edges;
}

const ARCHETYPE_WEIGHT_TOTAL = GREEBLE_ARCHETYPES.reduce((sum, a) => sum + a.weight, 0);

/** Fisher-Yates over the 12 edge indices, driven by the voxel's own PRNG, so
 * each of a voxel's greebles lands on a DIFFERENT edge (up to 12 of them) —
 * cheaper and more legible than rejection-sampling for collisions. */
function shuffledEdges(rand: () => number): number[] {
  const order = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = order[i];
    order[i] = order[j];
    order[j] = tmp;
  }
  return order;
}

function pickArchetype(rand: () => number): (typeof GREEBLE_ARCHETYPES)[number] {
  let roll = rand() * ARCHETYPE_WEIGHT_TOTAL;
  for (const archetype of GREEBLE_ARCHETYPES) {
    roll -= archetype.weight;
    if (roll <= 0) return archetype;
  }
  return GREEBLE_ARCHETYPES[GREEBLE_ARCHETYPES.length - 1];
}

/** Floats per instance in the staging buffer: position(3) + quaternion(4) +
 * scale(3) + linear color(3). */
const STRIDE = 13;

const _scratchCenter = new THREE.Vector3();
const _scratchPos = new THREE.Vector3();
const _scratchBasis = new THREE.Matrix4();
const _scratchQuat = new THREE.Quaternion();
const _scratchRoll = new THREE.Quaternion();
const _scratchColor = new THREE.Color();
const _localY = new THREE.Vector3(0, 1, 0);

/**
 * One chunk's greeble layer: small plain-shaded hull-detail boxes clamped along
 * the edges of every occupied voxel's cube, in numbers that say how many points
 * the voxel holds, disappearing one at a time as it is mined out.
 *
 * ## Why a separate mesh
 *
 * Same reasoning `voxels/ProxyCloud.ts` and `voxels/HighlightCubes.ts` already
 * apply: an independent `InstancedMesh2` computing its own transforms, rather
 * than anything layered onto the chunk's own voxel mesh. The voxel mesh is one
 * instance per voxel with an atlas-sampling material and a per-instance
 * `tileIndex` uniform; greebles are N instances per voxel with a plain grey
 * material and no atlas at all. They cannot share an instance pool, and making
 * greebles part of the voxel geometry would put thumbnail texture on them,
 * which is exactly what they must not have.
 *
 * They are, however, parented to the chunk's voxel mesh rather than hung off
 * the scene root. Greebles have to load, evict and reload in lockstep with
 * their chunk, and the chunk mesh is already the object with exactly that
 * lifetime — so `ChunkStore`'s add/remove and `ChunkLoader`'s dispose carry the
 * greebles along for free, with no second residency table to keep in sync. The
 * parent's own matrix is the identity (instances carry world positions), so
 * being a child costs no transform math.
 *
 * ## Not raycastable
 *
 * `main.ts` raycasts `chunkStore.group` RECURSIVELY, so a child mesh would be
 * hit-tested — and a hit on a greeble would resolve to a mesh with no `chunkId`
 * in its userData, i.e. would read as "you are hovering nothing" while the
 * cursor is plainly on a voxel. `raycast` is therefore overridden to a no-op
 * (three's `Raycaster` calls `object.raycast()` per object and skips a mesh
 * that adds no intersections). Layers were the alternative and are wrong here:
 * three tests the same `layers` mask for camera visibility, so hiding greebles
 * from the raycaster that way would hide them from the render too.
 *
 * ## Per-frame cost
 *
 * This layer is by far the biggest instance population in the app — at BL
 * num_voxels=96 it is 19,739 instances against the voxels' 5,917 — so it keeps
 * InstancedMesh2's per-instance frustum culling on (the default) and builds a
 * BVH for it, exactly as `ChunkLoader` does for the voxel mesh, rather than
 * relying on the whole-mesh cull alone.
 *
 * That is not a cosmetic choice; it was measured. With per-instance culling
 * off, the app's own spawn framing drew 13,636 greebles against 2,219 voxels —
 * six times the visible triangle count of the data itself, most of it behind
 * the camera — and tripled the frame time in the headless (software-GL) harness
 * (167ms -> 483ms median). With the BVH the drawn count tracks what is actually
 * on screen. The cost is one build per chunk at load, over at most a few
 * thousand static instances, which is the same deal already accepted for the
 * voxel mesh.
 */
export class VoxelGreebles {
  readonly mesh: InstancedMesh2;

  /**
   * Instance-id range per occupied-voxel index: voxel `i`'s greebles are
   * instances `offsets[i] … offsets[i+1]-1`.
   *
   * Indexed by the voxel's INSTANCE ID in the parent chunk mesh, which
   * `ChunkLoader` assigns in ascending `meta.occupied` order — the same
   * identity `MiningController.onChunkResident` already relies on, so every
   * call site here can pass the instance id it already has instead of
   * re-deriving anything.
   */
  private readonly offsets: Uint32Array;
  /** How many of voxel `i`'s greebles have broken off (0 … count). */
  private readonly broken: Uint8Array;
  /** 1 while the Effector Field is hiding voxel `i` (see `setSuppressed`). */
  private readonly suppressed: Uint8Array;

  private readonly geometry: THREE.BoxGeometry;
  private readonly material: THREE.MeshStandardMaterial;

  private constructor(
    mesh: InstancedMesh2,
    geometry: THREE.BoxGeometry,
    material: THREE.MeshStandardMaterial,
    offsets: Uint32Array,
  ) {
    this.mesh = mesh;
    this.geometry = geometry;
    this.material = material;
    this.offsets = offsets;
    this.broken = new Uint8Array(offsets.length - 1);
    this.suppressed = new Uint8Array(offsets.length - 1);
  }

  /**
   * Builds the greeble layer for one loaded chunk, or returns `null` if none of
   * its voxels earn any (every voxel under `GREEBLE_MIN_POINTS`) — a chunk with
   * no greebles gets no mesh at all rather than an empty one, the same way
   * `ProxyCloud` skips empty chunk slots.
   */
  static build(
    entry: ManifestChunk,
    meta: ChunkMeta,
    manifest: Manifest,
    renderer: THREE.WebGLRenderer,
  ): VoxelGreebles | null {
    const occupied = meta.occupied;
    const offsets = new Uint32Array(occupied.length + 1);
    let total = 0;
    for (let i = 0; i < occupied.length; i++) {
      offsets[i] = total;
      total += greebleCountForPoints(meta.count[occupied[i]]);
    }
    offsets[occupied.length] = total;
    if (total === 0) return null;

    const cubeEdge = manifest.voxelWorldSize * VOXEL_FILL;
    const staging = new Float32Array(total * STRIDE);
    const baseColor = new THREE.Color().setHex(GREEBLE_COLOR, THREE.SRGBColorSpace);

    for (let i = 0; i < occupied.length; i++) {
      const count = offsets[i + 1] - offsets[i];
      if (count === 0) continue;
      const localVoxelId = occupied[i];
      manifest.voxelCenterWorld(entry.cx, entry.cy, entry.cz, localVoxelId, _scratchCenter);

      const rand = mulberry32(voxelSeed(entry.chunk_id, localVoxelId));
      const edgeOrder = shuffledEdges(rand);

      for (let j = 0; j < count; j++) {
        const edge = CUBE_EDGES[edgeOrder[j % CUBE_EDGES.length]];
        const archetype = pickArchetype(rand);
        const jitter = 1 + (rand() * 2 - 1) * GREEBLE_SIZE_JITTER;
        const sizeAlong = archetype.size[0] * cubeEdge * jitter;
        const sizeOut = archetype.size[1] * cubeEdge * jitter;
        const sizeTangent = archetype.size[2] * cubeEdge * jitter;

        // Position: slide along the edge (keeping clear of both corners), then
        // push out along the edge's outward bisector by a fraction of the
        // piece's own half-depth, so part of it stays buried in the cube.
        const t = GREEBLE_EDGE_MARGIN + rand() * (1 - 2 * GREEBLE_EDGE_MARGIN);
        _scratchPos
          .copy(_scratchCenter)
          .addScaledVector(edge.anchor, cubeEdge)
          .addScaledVector(edge.along, (t - 0.5) * cubeEdge)
          .addScaledVector(edge.outward, sizeOut * 0.5 * GREEBLE_PROTRUSION);

        // Orientation: the edge frame, plus a quarter-turn roll about the
        // outward axis. Quantized to 90° rather than free — arbitrary angles
        // read as debris stuck to the cube, right angles read as hardware.
        _scratchBasis.makeBasis(edge.along, edge.outward, edge.tangent);
        _scratchQuat.setFromRotationMatrix(_scratchBasis);
        _scratchRoll.setFromAxisAngle(_localY, Math.floor(rand() * 4) * (Math.PI / 2));
        _scratchQuat.multiply(_scratchRoll);

        const shade = 1 + (rand() * 2 - 1) * GREEBLE_SHADE_JITTER;
        _scratchColor.copy(baseColor).multiplyScalar(shade);

        const base = (offsets[i] + j) * STRIDE;
        staging[base] = _scratchPos.x;
        staging[base + 1] = _scratchPos.y;
        staging[base + 2] = _scratchPos.z;
        staging[base + 3] = _scratchQuat.x;
        staging[base + 4] = _scratchQuat.y;
        staging[base + 5] = _scratchQuat.z;
        staging[base + 6] = _scratchQuat.w;
        staging[base + 7] = sizeAlong;
        staging[base + 8] = sizeOut;
        staging[base + 9] = sizeTangent;
        staging[base + 10] = _scratchColor.r;
        staging[base + 11] = _scratchColor.g;
        staging[base + 12] = _scratchColor.b;
      }
    }

    // Geometry and material are BOTH per-chunk, exactly as `ChunkLoader` does
    // for the voxel mesh and for the same two reasons: InstancedMesh2 writes
    // its own `instanceIndex` attribute into whatever geometry it is handed
    // (so a shared geometry would leave every mesh drawing through the last
    // one's index buffer), and it patches the material's `onBeforeCompile` /
    // `customProgramCacheKey` with per-mesh closures bound to that mesh's own
    // matrices/colors textures (so a shared material would have one chunk's
    // meshes rendering with another chunk's transforms). Both are cheap: a unit
    // box is 24 vertices, and the library's composed cache key is identical
    // across these materials, so they still share one compiled GL program.
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const material = new THREE.MeshStandardMaterial({
      // White, because the tint lives in the per-instance color (which the
      // shader MULTIPLIES into the diffuse) — a tinted material would square it.
      color: 0xffffff,
      roughness: GREEBLE_ROUGHNESS,
      metalness: GREEBLE_METALNESS,
    });

    const mesh = new InstancedMesh2(geometry, material, {
      capacity: total,
      renderer,
    });
    mesh.name = `chunk-${entry.chunk_id}-greebles`;
    // See the class doc comment — a greeble must never absorb a voxel hover.
    mesh.raycast = () => {};

    mesh.addInstances(total, (instance, index) => {
      const base = index * STRIDE;
      instance.position.set(staging[base], staging[base + 1], staging[base + 2]);
      instance.quaternion.set(staging[base + 3], staging[base + 4], staging[base + 5], staging[base + 6]);
      instance.scale.set(staging[base + 7], staging[base + 8], staging[base + 9]);
      _scratchColor.setRGB(staging[base + 10], staging[base + 11], staging[base + 12]);
      instance.color = _scratchColor;
    });

    // Built AFTER the instances exist, and for culling rather than raycasting
    // (this mesh is never raycast) — the same one-shot build `ChunkLoader` does
    // for the voxel mesh, for the same reason: instances are static for the life
    // of the chunk. See the class doc comment for what it buys.
    mesh.computeBVH();

    return new VoxelGreebles(mesh, geometry, material, offsets);
  }

  /** Total greeble instances in this chunk (visible or broken off). */
  get instanceCount(): number {
    return this.offsets[this.offsets.length - 1];
  }

  /** Greeble instances currently rendered — instance count minus everything
   * broken off by extraction or hidden by the Effector Field. */
  get visibleInstanceCount(): number {
    let visible = 0;
    for (let i = 0; i < this.broken.length; i++) {
      if (this.suppressed[i]) continue;
      visible += this.offsets[i + 1] - this.offsets[i] - this.broken[i];
    }
    return visible;
  }

  /** How many greebles voxel `voxelIndex` (its instance id in the parent chunk
   * mesh) was built with. */
  countFor(voxelIndex: number): number {
    if (voxelIndex < 0 || voxelIndex >= this.broken.length) return 0;
    return this.offsets[voxelIndex + 1] - this.offsets[voxelIndex];
  }

  /** How many of that voxel's greebles have broken off. */
  brokenFor(voxelIndex: number): number {
    if (voxelIndex < 0 || voxelIndex >= this.broken.length) return 0;
    return this.broken[voxelIndex];
  }

  /**
   * Breaks off / restores greebles to match a voxel's extraction state.
   *
   * The mapping is deterministic and monotone: with `K` greebles, piece `j`
   * (0-based, in generation order) is gone once `extractedFraction >= (j+1)/K`.
   * So the pieces always break in the same order for a given voxel, a partial
   * extraction always shows the same partial set, and — because `broken` is
   * derived from the fraction rather than accumulated — putting points BACK
   * (per-item return, `restoreAll`) reattaches exactly the pieces that had come
   * off, with no separate reverse path. A fully drained voxel has `broken == K`,
   * i.e. bare, matching the faded, mostly-empty cube underneath.
   *
   * The `+1e-6` is not cosmetic: `extracted/total` for something like 1/3
   * lands a hair under the exact threshold in binary floating point, which
   * would leave the last piece clinging to a voxel the player just emptied.
   */
  setExtractedFraction(voxelIndex: number, extractedFraction: number): void {
    const count = this.countFor(voxelIndex);
    if (count === 0) return;
    const clamped = Math.max(0, Math.min(1, extractedFraction));
    const broken = Math.min(count, Math.floor(clamped * count + 1e-6));
    if (broken === this.broken[voxelIndex]) return;
    this.broken[voxelIndex] = broken;
    this.applyVoxel(voxelIndex);
  }

  /**
   * Fades the whole layer to match the X-Ray tool's global translucency.
   *
   * Deliberately a WHOLE-MESH material opacity rather than the per-instance
   * opacity channel the voxel meshes use for this: X-Ray is a global toggle
   * with no per-greeble component (a greeble is either attached or broken off —
   * there is no partial state to compose with), so one material write per chunk
   * does what 20k per-instance writes would. Left opaque, the greebles would
   * stay solid inside an X-rayed cluster and defeat the one tool whose entire
   * purpose is seeing through it.
   *
   * `transparent` is flipped on once and never back, exactly as
   * `ensureTransparentMaterial` does for the voxel materials, and for the same
   * reason: a fully-opaque material in the transparent queue renders
   * identically, so tracking "can I switch this back yet" would buy nothing.
   */
  setXrayOpacity(opacity: number): void {
    if (this.material.opacity === opacity) return;
    if (!this.material.transparent && opacity < 1) {
      this.material.transparent = true;
      this.material.needsUpdate = true;
    }
    this.material.opacity = opacity;
  }

  /**
   * Hides/reveals a voxel's greebles alongside the voxel itself when the
   * Effector Field suppresses it (`EffectorFieldController` calls
   * `setVisibilityAt(false)` on the voxel instance to reach through a cluster).
   * Without this the cube would vanish and its trim would stay behind, floating
   * in the hole.
   */
  setSuppressed(voxelIndex: number, suppressed: boolean): void {
    if (voxelIndex < 0 || voxelIndex >= this.suppressed.length) return;
    const value = suppressed ? 1 : 0;
    if (this.suppressed[voxelIndex] === value) return;
    this.suppressed[voxelIndex] = value;
    this.applyVoxel(voxelIndex);
  }

  /**
   * Writes one voxel's greeble visibility flags.
   *
   * `setVisibilityAt` is the same per-instance show/hide `EffectorFieldController`
   * uses (and the same one Phase 3.5 moved MINING away from, because it also
   * kills raycasting — irrelevant here, since greebles are never raycast at
   * all). A broken-off greeble keeps its slot and its transform; only the flag
   * moves, so restoring it is one more flag write rather than a rebuild.
   */
  private applyVoxel(voxelIndex: number): void {
    const start = this.offsets[voxelIndex];
    const end = this.offsets[voxelIndex + 1];
    const broken = this.suppressed[voxelIndex] ? end - start : this.broken[voxelIndex];
    for (let id = start; id < end; id++) {
      this.mesh.setVisibilityAt(id, id - start >= broken);
    }
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.dispose();
    this.geometry.dispose();
    this.material.dispose();
  }
}
