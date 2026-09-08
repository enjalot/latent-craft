import { Vector3 } from "three";
import { expect, it } from "vitest";
import { createContainerGeometry, FRAME_INNER_HALF } from "./ContainerGeometry.ts";
import { CONTAINER_RAIL_WIDTH_MAX, CONTAINER_BRACKET_WIDTH_MULT } from "../config.ts";

it("preserves outward faces and frame coverage while eliminating over half the empty-face area", () => {
  const g = createContainerGeometry(), p = g.getAttribute("position"), n = g.getAttribute("normal"), indices = g.index!;
  let area = 0;
  for (let i = 0; i < indices.count; i += 3) {
    const a = new Vector3().fromBufferAttribute(p, indices.getX(i));
    const b = new Vector3().fromBufferAttribute(p, indices.getX(i + 1));
    const c = new Vector3().fromBufferAttribute(p, indices.getX(i + 2));
    const cross = b.sub(a).cross(c.sub(a));
    expect(cross.dot(new Vector3().fromBufferAttribute(n, indices.getX(i)))).toBeGreaterThan(0);
    area += cross.length() / 2;
  }
  expect(indices.count / 3).toBe(48);
  expect(area / 6).toBeCloseTo(1 - (FRAME_INNER_HALF * 2) ** 2, 6);
  expect(.5 - FRAME_INNER_HALF).toBeGreaterThan(CONTAINER_RAIL_WIDTH_MAX * CONTAINER_BRACKET_WIDTH_MULT + .04);
  g.computeBoundingBox();
  expect(g.boundingBox!.min.toArray()).toEqual([-.5, -.5, -.5]);
  expect(g.boundingBox!.max.toArray()).toEqual([.5, .5, .5]);
  g.dispose();
});
