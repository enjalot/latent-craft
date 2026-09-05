import * as THREE from "three";
import { EFFECTOR_DOT_COLOR } from "../config.ts";

/** Geodesic 3/6/9-voxel offsets when they fit; compress spacing for small
 * fields. Marker dimensions stay 1 × .2 voxels along surface geodesics. */
export function effectorRingLayout(radius: number, angularLimit = .45) {
  if (!Number.isFinite(radius) || radius <= 0 || !Number.isFinite(angularLimit) || angularLimit <= 0 || angularLimit >= Math.PI / 2)
    throw new Error("Invalid effector surface dimensions");
  const step = Math.min(3, radius * angularLimit / 3);
  return [1, 2, 3].map(ring => {
    const offset = step * ring, angle = offset / radius;
    return { offset, angle, count: Math.max(1, Math.floor(2 * Math.PI * radius * Math.sin(angle) / 1.6)) };
  });
}

export function buildEffectorSurfaceGeometry(radius = 2, angularLimit = .45): THREE.BufferGeometry {
  const positions: number[] = [];
  const normal = new THREE.Vector3(), along = new THREE.Vector3(), across = new THREE.Vector3();
  const point = new THREE.Vector3();
  const vertex = (u: number, v: number) => {
    const distance = Math.hypot(u, v), angle = distance / radius;
    point.copy(normal).multiplyScalar(radius * Math.cos(angle));
    if (distance) {
      point.addScaledVector(along, radius * Math.sin(angle) * u / distance);
      point.addScaledVector(across, radius * Math.sin(angle) * v / distance);
    }
    positions.push(point.x, point.y, point.z);
  };
  effectorRingLayout(radius, angularLimit).forEach((ring, index) => {
    for (let i = 0; i < ring.count; i++) {
      const phi = (i + index * .23) * Math.PI * 2 / ring.count;
      normal.set(Math.sin(ring.angle) * Math.cos(phi), Math.sin(ring.angle) * Math.sin(phi), -Math.cos(ring.angle));
      along.set(-Math.sin(phi), Math.cos(phi), 0);
      across.crossVectors(normal, along).normalize();
      // Four strips follow the sphere instead of floating tangent cards.
      for (let j = 0; j < 4; j++) {
        const a = -.5 + j / 4, b = a + .25;
        vertex(a, -.1); vertex(b, -.1); vertex(b, .1);
        vertex(a, -.1); vertex(b, .1); vertex(a, .1);
      }
    }
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeBoundingSphere();
  return geometry;
}

export function effectorSurfaceOpacity(elapsedMs: number): number {
  const t = Math.max(0, Math.min(1, (elapsedMs - 180) / 720));
  return .8 * (1 - t * t * (3 - 2 * t));
}

export function createEffectorSurface() {
  const material = new THREE.MeshBasicMaterial({ color: EFFECTOR_DOT_COLOR, opacity: 0,
    transparent: true, depthTest: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
  const surface = new THREE.Mesh(buildEffectorSurfaceGeometry(), material);
  surface.name = "effector-surface-rectangle-rings";
  surface.raycast = () => {};
  return surface;
}
