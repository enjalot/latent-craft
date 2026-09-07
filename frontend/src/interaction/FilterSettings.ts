import { voxelCountThreshold } from "../voxels/VoxelCountFilter.ts";

/** Migrate the old off/1 default once, retaining subsequent explicit choices. */
export function restoreFilterSettings(saved?: { filterEnabled?: boolean; filterThreshold?: number; filterDefaultsVersion?: number } | null) {
  const oldDefault = saved?.filterDefaultsVersion !== 2 && saved?.filterEnabled === false && saved?.filterThreshold === 1;
  return {
    filterDefaultsVersion: 2,
    filterEnabled: oldDefault || typeof saved?.filterEnabled !== "boolean" ? true : saved.filterEnabled,
    filterThreshold: oldDefault || saved?.filterThreshold === undefined ? 2 : voxelCountThreshold(saved.filterThreshold),
  };
}
