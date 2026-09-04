#!/usr/bin/env python3
"""Build wide-count compact atlases and immutable streaming pack, without fitting a projection.

Usage: .venv/bin/python scripts/run_streaming_monet.py sscd --release 20260904b [--voxels 256]
Offline assignment still uses NumPy/pandas memory proportional to N; serving/browser do not.
"""
import argparse
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
import numpy as np
import pandas as pd
from lsvoxel.chunkpack.build import assign_and_build
from lsvoxel.chunkpack.streaming import convert
from lsvoxel.config import MONET_SOURCES, MONET_THUMB_URL_TEMPLATE, chunks_dir, monet_dataset_id, points_table_path, umap_run_dir
from lsvoxel.datasets.monet import MonetThumbnailSource


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('arm')
    parser.add_argument('--release', required=True)
    parser.add_argument('--voxels', type=int, default=160)
    args = parser.parse_args()
    if not args.release.isalnum() or args.voxels < 160 or args.voxels % 16:
        parser.error('release must be alphanumeric; voxels must be a multiple of 16, at least 160')
    dataset = monet_dataset_id(args.arm)
    pack = f'{dataset}-{args.voxels}'
    output = chunks_dir(f'{pack}-stream-{args.release}')
    source = chunks_dir(f'{pack}-source-{args.release}')
    if output.exists() or source.exists():
        parser.error('Release already exists; choose a fresh release ID')
    points_path = points_table_path(dataset)
    points = pd.read_parquet(points_path)
    assign_and_build(dataset_id=pack, points_df=points,
        coords3d=np.load(umap_run_dir(dataset) / 'coords3d.npy', mmap_mode='r'),
        num_voxels=args.voxels, thumb_source=MonetThumbnailSource(points), out_dir=source,
        subsets=dict(MONET_SOURCES), thumb_url_template=MONET_THUMB_URL_TEMPLATE,
        umap_run='umap-001', points_table_path=points_path, wide_counts=True)
    minimap = output.parents[1] / 'minimap' / dataset
    print(convert(source, output, minimap))
    print(f'Published {output}; set the frontend dataset path to this immutable release.')


if __name__ == '__main__':
    main()
