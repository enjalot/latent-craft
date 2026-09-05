import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { EFFECTOR_DOT_COLOR } from "../config.ts";

/** A camera-centred sphere has no visible silhouette: fixed-angle rings look
 * identical at every radius. Deliberately open the angular aperture as R grows
 * to make scrolling legible in empty space, while every solid's centre remains
 * exactly R voxels away. Fixed slots avoid rotation/pop; small bars keep clearance. */
export function effectorRingLayout(radius: number, angularLimit = .45) {
  if (!Number.isFinite(radius) || radius <= 0 || !Number.isFinite(angularLimit) || angularLimit <= 0 || angularLimit >= Math.PI / 2)
    throw new Error("Invalid effector surface dimensions");
  // Logarithmic growth stays perceptible across the full 1–48 voxel range,
  // rather than saturating early and becoming static again for large fields.
  const aperture = angularLimit * (.1 + .9 * Math.min(1, Math.log1p(radius) / Math.log(49)));
  const step = radius * aperture / 3;
  return [1, 2, 3].map(ring => {
    const offset = step * ring, angle = offset / radius;
    const count = ring * 12;
    const chord = 2 * radius * Math.sin(angle) * Math.sin(Math.PI / count);
    const length = Math.min(1, chord * .6);
    return { offset, angle, count, length, width: length / 5, depth: length / 5 };
  });
}

export function buildEffectorSurfaceGeometry(radius = 2, angularLimit = .45): THREE.BufferGeometry {
  const bars: THREE.BufferGeometry[] = [];
  const normal = new THREE.Vector3(), along = new THREE.Vector3(), across = new THREE.Vector3();
  const transform = new THREE.Matrix4();
  const tilt = new THREE.Matrix4().makeRotationX(Math.PI / 6);
  effectorRingLayout(radius, angularLimit).forEach(ring => {
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
    roughness: .32, metalness: .25, emissive: EFFECTOR_DOT_COLOR, emissiveIntensity: .18,
    flatShading: true, transparent: true, depthTest: true, depthWrite: false });
  const surface = new THREE.Mesh(buildEffectorSurfaceGeometry(), material);
  surface.name = "effector-surface-rectangle-rings";
  surface.raycast = () => {};
  return surface;
}
