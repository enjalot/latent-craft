"""Measure 64px encodes for deterministic occupancy-stratified chunk samples.

Exact GPU dimensions; estimated whole-pack CDN bytes from within-stratum
compressed-size ratios. Never assumes that doubling edge quadruples transfer.
Outputs a separate JSON report; does not mutate the production pack.
"""
import argparse
import json
from pathlib import Path
import sys
import tempfile

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from lsvoxel.chunkpack.atlas import build_compact_chunk_atlas_png, encode_ktx2
from lsvoxel.chunkpack.metablob import read_chunk_meta
from lsvoxel.datasets.monet import MonetThumbnailSource


def bucket(n):
    return 0 if n <= 16 else 1 if n <= 64 else 2 if n <= 256 else 3


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('pack', type=Path)
    parser.add_argument('report', type=Path)
    args = parser.parse_args()
    if args.report.exists():
        parser.error('Report already exists; choose a new output')
    manifest = json.loads((args.pack / 'manifest.json').read_text())
    assert manifest['atlas']['tile_px'] == 32
    points = pd.read_parquet(manifest['point_source']['points_table'], columns=['row_id', 'shard_idx', 'local_row'])
    source = MonetThumbnailSource(points)
    groups = [[c for c in manifest['chunks'] if bucket(c['n_occupied_voxels']) == b] for b in range(4)]
    samples, projected = [], 0
    try:
        with tempfile.TemporaryDirectory(prefix='lsv-atlas-cost-') as temp:
            for b, entries in enumerate(groups):
                if not entries:
                    continue
                entries.sort(key=lambda c: (c['n_occupied_voxels'], c['chunk_id']))
                indices = np.unique(np.rint(np.linspace(0, len(entries) - 1, min(4, len(entries)))).astype(int))
                selected = []
                for index in indices:
                    entry = entries[int(index)]
                    meta = read_chunk_meta(args.pack / entry['meta_path'])
                    local = np.flatnonzero(meta.voxel_records['count'])
                    rows = meta.voxel_records['repr_row_id'][local]
                    image, blank, side = build_compact_chunk_atlas_png(local, rows, source, tile_px=64, max_atlas_px=4096)
                    png, ktx = Path(temp) / 'sample.png', Path(temp) / 'sample.ktx2'
                    image.save(png); encode_ktx2(png, ktx)
                    result = dict(chunk=entry['chunk_id'], stratum=b, occupied=len(local), blank=blank,
                                  bytes32=entry['atlas_bytes'], bytes64=ktx.stat().st_size, side64=side*64)
                    selected.append(result); samples.append(result)
                    print(result, flush=True)
                ratio = sum(s['bytes64'] for s in selected) / sum(s['bytes32'] for s in selected)
                projected += sum(c['atlas_bytes'] for c in entries) * ratio
    finally:
        source.close()
    rgba = sum(c['atlas_size_px']**2 * 4 for c in manifest['chunks'])
    result = dict(pack=args.pack.name, rows=manifest['point_source']['n_points'],
                  voxels=sum(c['n_occupied_voxels'] for c in manifest['chunks']), chunks=len(manifest['chunks']),
                  rgba32=rgba, rgba64=rgba*4, rgb4bit32=rgba//8, rgb4bit64=rgba//2,
                  disk32=sum(c['atlas_bytes'] for c in manifest['chunks']), estimatedDisk64=round(projected),
                  method='Four occupancy strata (<=16, <=64, <=256, >256); up to four quantile samples each; per-stratum byte-ratio extrapolation. Not a full 64px build.',
                  samples=samples)
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(result, indent=2) + '\n')
    print({k:v for k,v in result.items() if k != 'samples'}, flush=True)


if __name__ == '__main__':
    main()
