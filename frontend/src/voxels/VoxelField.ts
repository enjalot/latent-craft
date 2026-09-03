import * as THREE from "three";
import { InstancedMesh2 } from "@three.ez/instanced-mesh";
import { SYNTHETIC_INSTANCE_COUNT, VOXEL_SIZE, WORLD_HALF_EXTENT } from "../config.ts";

const CLUSTER_COUNT = 14;
/** Fraction of instances sampled as diffuse background noise rather than
 * inside one of the Gaussian blobs — keeps the field from reading as
 * uniform static, closer to how a real UMAP point cloud looks (dense
 * clusters + a sparse "connective tissue" halo). */
const NOISE_FRACTION = 0.15;

function randomPastelColor(target: THREE.Color): THREE.Color {
  const hue = Math.random();
  const saturation = 0.45 + Math.random() * 0.25; // 0.45..0.70
  const lightness = 0.72 + Math.random() * 0.13; // 0.72..0.85
  return target.setHSL(hue, saturation, lightness);
}

/** Box-Muller transform for a standard-normal sample. */
function sampleGaussian(): number {
  const u1 = Math.max(Number.EPSILON, Math.random());
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

interface ClusterCenter {
  position: THREE.Vector3;
  spread: number;
}

function buildClusterCenters(count: number): ClusterCenter[] {
  const centers: ClusterCenter[] = [];
  const placementRadius = WORLD_HALF_EXTENT * 0.7;
  for (let i = 0; i < count; i++) {
    const position = new THREE.Vector3(
      (Math.random() * 2 - 1) * placementRadius,
      (Math.random() * 2 - 1) * placementRadius,
      (Math.random() * 2 - 1) * placementRadius,
    );
    const spread = WORLD_HALF_EXTENT * (0.06 + Math.random() * 0.12);
    centers.push({ position, spread });
  }
  return centers;
}

/**
 * Builds a single `InstancedMesh2` of flat-colored unit cubes scattered
 * through a synthetic point cloud — a mixture of Gaussian "clusters" plus a
 * uniform noise halo, standing in for a real UMAP embedding until the
 * pipeline's chunk-streamed data lands in Phase 2. No textures, no chunking:
 * this is purely here to stress-test InstancedMesh2's rendering + BVH
 * raycasting at scale and validate flight-control feel.
 */
export function createSyntheticVoxelField(renderer?: THREE.WebGLRenderer): InstancedMesh2 {
  const geometry = new THREE.BoxGeometry(VOXEL_SIZE, VOXEL_SIZE, VOXEL_SIZE);
  // NOTE: `vertexColors` stays false here on purpose. InstancedMesh2's
  // per-instance color texture (`instance.color = ...` below) is threaded
  // through independently of THREE's own per-vertex `color` geometry
  // attribute — setting `vertexColors: true` makes its patched shader look
  // for that (nonexistent, for a plain BoxGeometry) vertex attribute
  // instead of just multiplying by the fetched instance-color texture,
  // which silently renders every instance near-black.
  const material = new THREE.MeshStandardMaterial({
    roughness: 0.85,
    metalness: 0.0,
  });

  const mesh = new InstancedMesh2(geometry, material, {
    capacity: SYNTHETIC_INSTANCE_COUNT,
    renderer,
  });

  const clusters = buildClusterCenters(CLUSTER_COUNT);
  const halfExtent = WORLD_HALF_EXTENT;
  const color = new THREE.Color();

  mesh.addInstances(SYNTHETIC_INSTANCE_COUNT, (instance) => {
    if (Math.random() < NOISE_FRACTION || clusters.length === 0) {
      instance.position.set(
        (Math.random() * 2 - 1) * halfExtent,
        (Math.random() * 2 - 1) * halfExtent,
        (Math.random() * 2 - 1) * halfExtent,
      );
    } else {
      const cluster = clusters[(Math.random() * clusters.length) | 0];
      instance.position.set(
        cluster.position.x + sampleGaussian() * cluster.spread,
        cluster.position.y + sampleGaussian() * cluster.spread,
        cluster.position.z + sampleGaussian() * cluster.spread,
      );
      instance.position.clampScalar(-halfExtent, halfExtent);
    }

    // Slight per-instance scale jitter so the field doesn't look like a
    // perfectly uniform grid of identical cubes.
    const scale = 0.75 + Math.random() * 0.5;
    instance.scale.setScalar(scale);

    instance.color = randomPastelColor(color);
  });

  // The whole point of Phase 1: validate BVH-accelerated raycasting/culling
  // at scale. Instances are static after this point, so a single computeBVH
  // call up front (not recomputed per frame) is exactly the intended usage.
  mesh.computeBVH();

  return mesh;
}
