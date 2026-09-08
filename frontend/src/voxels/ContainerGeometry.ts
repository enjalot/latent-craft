import { BufferGeometry, Float32BufferAttribute } from "three";

// Largest shader shoulder is .065 * 1.45 wide. Keep extra room for its
// antialiasing, but never rasterize the empty middle 72% of each face.
export const FRAME_INNER_HALF = .36;

/** Same cube faces/normals as BoxGeometry; four non-overlapping strips per face.
 * 48 triangles instead of 12, for 51.84% less potential fragment coverage.
 * This trades a small shared vertex buffer for less transparent overdraw. */
export function createContainerGeometry(): BufferGeometry {
  const positions: number[] = [], normals: number[] = [], indices: number[] = [];
  const h = FRAME_INNER_HALF;
  const strips = [[-.5, -h, -.5, .5], [h, .5, -.5, .5], [-h, h, -.5, -h], [-h, h, h, .5]];
  for (let axis = 0; axis < 3; axis++) for (const sign of [-1, 1]) {
    const u = (axis + 1) % 3, v = (axis + 2) % 3;
    for (const [x0, x1, y0, y1] of strips) {
      const start = positions.length / 3;
      for (const [x, y] of [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]) {
        const p = [0, 0, 0], n = [0, 0, 0];
        p[axis] = sign * .5; p[u] = x; p[v] = y; n[axis] = sign;
        positions.push(...p); normals.push(...n);
      }
      for (const i of sign > 0 ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2]) indices.push(start + i);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new Float32BufferAttribute(normals, 3));
  geometry.setIndex(indices);
  return geometry;
}
