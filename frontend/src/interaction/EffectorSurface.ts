import * as THREE from "three";
import { EFFECTOR_DOT_COLOR } from "../config.ts";

/** Fixed-size Fibonacci scatter on the unit sphere. Scale one geometry to
 * resize; no allocations per wheel event and no latitude grid lines. */
export function buildEffectorSurfaceGeometry(): THREE.BufferGeometry {
  const count = 384;
  const positions = new Float32Array(count * 3);
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const y = 1 - 2 * (i + 0.5) / count;
    const r = Math.sqrt(1 - y * y);
    positions.set([Math.cos(i * goldenAngle) * r, y, Math.sin(i * goldenAngle) * r], i * 3);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  return geometry;
}

export function effectorSurfaceOpacity(elapsedMs: number): number {
  const t = Math.max(0, Math.min(1, (elapsedMs - 180) / 720));
  return 0.8 * (1 - t * t * (3 - 2 * t));
}

export function createEffectorSurface(voxelWorldSize: number) {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      color: { value: new THREE.Color(EFFECTOR_DOT_COLOR) },
      opacity: { value: 0 },
      pointSize: { value: voxelWorldSize * 0.035 },
      viewportHeight: { value: 1 },
    },
    vertexShader: `uniform float pointSize, viewportHeight;
      void main() {
        vec4 p = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * p;
        gl_PointSize = clamp(pointSize * viewportHeight * projectionMatrix[1][1] / max(0.001, -2.0 * p.z), 1.5, 12.0);
      }`,
    fragmentShader: `uniform vec3 color; uniform float opacity;
      void main() {
        float r = length(gl_PointCoord - 0.5) * 2.0;
        float glow = exp(-5.0 * r * r) * (1.0 - smoothstep(0.7, 1.0, r));
        gl_FragColor = vec4(color, opacity * glow);
      }`,
    transparent: true, depthTest: true, depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const surface = new THREE.Points(buildEffectorSurfaceGeometry(), material);
  surface.name = "effector-surface-dots";
  return surface;
}
