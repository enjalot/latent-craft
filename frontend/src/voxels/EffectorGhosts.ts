import * as THREE from "three";
import { XRAY_OPACITY, STREAM_MAX_INSTANCES } from "../config.ts";

/** One bounded, untextured draw for blocks the effector makes pass-through.
 * It has no atlas, no raycasts and no depth writes. Source chunks keep owning
 * the hidden, non-pickable textured instances and their mining state. */
export function createEffectorGhosts(capacity = STREAM_MAX_INSTANCES) {
  const material = new THREE.MeshBasicMaterial({ color: 0x82949a,
    transparent: true, opacity: XRAY_OPACITY / 3, depthWrite: false, fog: true });
  const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), material, capacity);
  mesh.name = "effector-untextured-ghosts";
  mesh.count = 0; mesh.frustumCulled = false;
  mesh.raycast = () => {};
  return mesh;
}
