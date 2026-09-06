/** Original occupancy, not the number of images left after mining. Zero disables
 * the filter; enabled thresholds are positive integers (default: singletons). */
export function voxelCountThreshold(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(1, Math.min(0xffffffff, Math.floor(value))) : 1;
}

/** Maximum *individual voxel* count in each coarse proxy cell. Using the sum
 * would keep a brick of 64 singleton voxels visible when singletons are hidden.
 * Fine records are range-loaded for selected bricks only, not the whole map. */
export function proxyCellMaxCounts(fine: DataView, coarse: DataView, step: number, vpc: number): Uint32Array {
  const maxima = new Uint32Array(vpc ** 3);
  const key = (view: DataView, offset: number) => {
    const x = Math.floor(view.getUint16(offset, true) / step) * step;
    const y = Math.floor(view.getUint16(offset + 2, true) / step) * step;
    const z = Math.floor(view.getUint16(offset + 4, true) / step) * step;
    return x + vpc * (y + vpc * z);
  };
  for (let offset = 0; offset < fine.byteLength; offset += 16) {
    const cell = key(fine, offset);
    maxima[cell] = Math.max(maxima[cell], fine.getUint32(offset + 8, true));
  }
  return Uint32Array.from({ length: coarse.byteLength / 16 }, (_, i) => maxima[key(coarse, i * 16)]);
}
