import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { EFFECTOR_DOT_COLOR } from "../config.ts";

/** Fixed physical solids, NOT constant-pixel-size indicators. Fixed angular
 * slots keep orientation stable; their apparent size falls naturally as 1/R.
 * Sparse rings leave clearance even at the minimum one-voxel field radius. */
export function effectorRingLayout(radius: number) {
  if (!Number.isFinite(radius) || radius <= 0)
    throw new Error("Invalid effector surface dimensions");
  return [1, 2, 3].map(ring => {
    const angle = ring * .2;
    return { offset: radius * angle, angle, count: ring * 3,
      length: .25, width: .05, depth: .05 };
  });
}

export function buildEffectorSurfaceGeometry(radius = 2): THREE.BufferGeometry {
  const bars: THREE.BufferGeometry[] = [];
  const normal = new THREE.Vector3(), along = new THREE.Vector3(), across = new THREE.Vector3();
  const transform = new THREE.Matrix4();
  const tilt = new THREE.Matrix4().makeRotationX(Math.PI / 6);
  effectorRingLayout(radius).forEach(ring => {
    for (let i = 0; i < ring.count; i++) {
      const phi = i * Math.PI * 2 / ring.count;
      normal.set(Math.sin(ring.angle) * Math.cos(phi), Math.sin(ring.angle) * Math.sin(phi), -Math.cos(ring.angle));
      along.set(-Math.sin(phi), Math.cos(phi), 0);
      across.crossVectors(normal, along).normalize();
      // Actual closed solids with end caps, side faces and lit chamfers. The
      // object's centre, not a raycast hit, lies on the effector boundary.
      const bar = new RoundedBoxGeometry(ring.length, ring.width, ring.depth, 1, ring.width * .16);
      transform.makeBasis(along, across, normal).multiply(tilt).setPosition(normal.clone().multiplyScalar(radius));
      bar.applyMatrix4(transform);
      bars.push(bar);
    }
  });
  // One draw call, no per-marker scene objects or work while the field is idle.
  const geometry = mergeGeometries(bars, false)!;
  for (const bar of bars) bar.dispose();
  geometry.computeBoundingSphere();
  return geometry;
}

export function effectorSurfaceOpacity(elapsedMs: number): number {
  const t = Math.max(0, Math.min(1, (elapsedMs - 180) / 720));
  return .8 * (1 - t * t * (3 - 2 * t));
}

export function createEffectorSurface() {
  const material = new THREE.MeshStandardMaterial({ color: EFFECTOR_DOT_COLOR, opacity: 0,
    roughness: .24, metalness: .5, envMapIntensity: 1.2,
    transparent: true, depthTest: true, depthWrite: false });
  const surface = new THREE.Mesh(buildEffectorSurfaceGeometry(), material);
  surface.name = "effector-surface-rectangle-rings";
  surface.raycast = () => {};
  return surface;
}
