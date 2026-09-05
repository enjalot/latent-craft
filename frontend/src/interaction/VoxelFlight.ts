import * as THREE from "three";
import type { Manifest } from "../streaming/Manifest.ts";

/** Direct inventory navigation needs no point-ID or minimap pages. Keep the
 * selected voxel outside the camera's effector bubble on arrival. */
export function planVoxelFlight(
  manifest: Manifest, chunkId: number, localVoxelId: number,
  cameraPosition: THREE.Vector3, effectorRadius: number,
): { target: THREE.Vector3; destination: THREE.Vector3 } | null {
  if (!manifest.chunksById.has(chunkId) || !Number.isInteger(localVoxelId) ||
    localVoxelId < 0 || localVoxelId >= manifest.voxelsPerChunk ** 3) return null;
  const target = manifest.voxelCenterWorldById(chunkId, localVoxelId, new THREE.Vector3());
  const direction = cameraPosition.clone().sub(target);
  if (direction.lengthSq() < 1e-6) direction.set(0, 0, 1);
  direction.normalize();
  const standoff = Math.max(2 * manifest.voxelWorldSize, effectorRadius + manifest.voxelWorldSize);
  return { target, destination: target.clone().addScaledVector(direction, standoff) };
}
