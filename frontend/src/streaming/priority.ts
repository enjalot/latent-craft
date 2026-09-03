import type * as THREE from "three";

/**
 * Which streaming ring a chunk falls in, given its distance from the camera.
 * Modelled on `mapviewer`'s `DensityStore` tiering, converted from a 2D
 * viewport query to a 3D camera-centred one.
 */
export enum Ring {
  /** Inside R0 — fetch now. */
  Load = 0,
  /** Inside R1 — fetch in the background once R0 is satisfied. */
  Prefetch = 1,
  /** Inside R2 — keep if already resident, but don't fetch. */
  Keep = 2,
  /** Beyond R2 — evict. */
  Evict = 3,
}

export interface RingRadii {
  /** All three radii are in *chunk edge lengths*, so they stay meaningful
   * across datasets with different `chunks_per_axis`. */
  r0: number;
  r1: number;
  r2: number;
}

export function ringFor(distanceInChunks: number, radii: RingRadii): Ring {
  if (distanceInChunks <= radii.r0) return Ring.Load;
  if (distanceInChunks <= radii.r1) return Ring.Prefetch;
  if (distanceInChunks <= radii.r2) return Ring.Keep;
  return Ring.Evict;
}

/**
 * Lower is fetched first. Primarily distance, but chunks in front of the
 * camera get a discount: while flying you reach what you're looking at long
 * before you reach what's beside you, so loading forward first is what makes
 * streaming feel invisible.
 *
 * `toChunk` must already be normalized; `forward` is the camera's -Z axis.
 */
export function chunkPriority(
  distanceInChunks: number,
  toChunk: THREE.Vector3,
  forward: THREE.Vector3,
): number {
  const facing = toChunk.dot(forward); // 1 = dead ahead, -1 = directly behind
  return distanceInChunks * (1.0 - 0.35 * facing);
}
