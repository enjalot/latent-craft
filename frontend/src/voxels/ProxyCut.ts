/** Best-first octree cut. Negative scores are outside the view. Refining one
 * branch cannot spend the whole budget before an equally important sibling
 * is considered. Parents stay in the cut when there is no room for children. */
export function selectProxyCut(
  tree: readonly { children: readonly number[] }[],
  score: (index: number) => number,
  budget = 512,
  threshold = 80,
): number[] {
  if (!tree.length || budget < 1) return [];
  const rootScore = score(0);
  if (rootScore < 0) return [];
  const cut = new Map<number, number>([[0, rootScore]]);
  const candidates = new Map<number, number>(cut);
  while (candidates.size) {
    let best = -1, importance = threshold;
    for (const [id, value] of candidates) if (value > importance) { best = id; importance = value; }
    if (best < 0) break;
    candidates.delete(best);
    if (!tree[best].children.length) continue;
    const children = tree[best].children.map(id => [id, score(id)] as const).filter(([, value]) => value >= 0);
    if (cut.size - 1 + children.length > budget) continue;
    cut.delete(best);
    for (const [id, value] of children) { cut.set(id, value); candidates.set(id, value); }
  }
  return [...cut.keys()];
}

/** Dense full-resolution bricks are only useful near the thumbnail horizon.
 * Farther ahead, small 4³-voxel aggregates provide coverage cheaply. */
export function proxyBrickLod(distanceInChunks: number, voxelPixels: number, previous = 0): number {
  // Exit deadbands prevent small forward/back movements from repeatedly
  // changing geometry at the detail boundaries. No camera-angle dependence.
  if (previous === 2 && distanceInChunks <= 2.2 && voxelPixels >= 7) return 2;
  if (previous >= 1 && distanceInChunks <= 4.25 && voxelPixels >= 2.5)
    return distanceInChunks <= 2 && voxelPixels >= 8 ? 2 : 1;
  return distanceInChunks <= 2 && voxelPixels >= 8 ? 2 : distanceInChunks <= 4 && voxelPixels >= 3 ? 1 : 0;
}

/** Inputs are nearest-first. Reserve cheap coverage for every admitted leaf
 * BEFORE upgrades. Selection depends on metadata, never cache/load timing. */
export function allocateProxyBricks(
  leaves: readonly { counts: readonly number[]; lod: number }[],
  maxBricks = 128, maxInstances = 65536,
): number[] {
  const selected: number[] = [];
  let used = 0;
  for (const leaf of leaves) {
    if (selected.length >= maxBricks || used + leaf.counts[0] > maxInstances) break;
    selected.push(0); used += leaf.counts[0];
  }
  for (let i = 0; i < selected.length; i++) {
    for (let lod = leaves[i].lod; lod > 0; lod--) {
      const extra = leaves[i].counts[lod] - leaves[i].counts[0];
      if (used + extra <= maxInstances) { selected[i] = lod; used += extra; break; }
    }
  }
  return selected;
}
