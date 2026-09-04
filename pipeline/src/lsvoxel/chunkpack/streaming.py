"""Publish immutable streaming sidecars from a chunk pack, bounded by one render chunk.

The input can contain legacy v1 metadata or v2 u32 summaries + separate postings.
Outputs are never rewritten: publish a NEW directory, then point the registry at it.
All large point tables are copied in streaming IO, or mmap'd, not decoded globally.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import struct
from pathlib import Path

import numpy as np


def blob(path: Path, root: Path) -> dict:
    digest = hashlib.sha256()
    with path.open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(block)
    return dict(path=str(path.relative_to(root)), bytes=path.stat().st_size, sha256=digest.hexdigest())


def convert(source: Path, output: Path, minimap: Path | None = None) -> dict:
    if output.exists():
        raise FileExistsError('Use a fresh immutable output directory')
    raw = json.loads((source / 'manifest.json').read_text())
    output.mkdir(parents=True)
    # An interrupted conversion has no manifest and cannot be mistaken for a complete pack.
    for key in ('point_index', 'row_to_voxel', 'proxy', 'voxel_proxy'):
        path = raw[key]['path']
        (output / path).parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source / path, output / path)
    nodes = []
    vpc = raw['world']['voxels_per_chunk']
    ngrid = raw['world']['num_voxels']
    brick_path = output / 'bricks.bin'
    with brick_path.open('wb') as bricks:
        for entry in raw['chunks']:
            old = (source / entry['meta_path']).read_bytes()
            version = struct.unpack_from('<H', old, 4)[0]
            nvox = struct.unpack_from('<I', old, 10)[0]
            summary = bytearray(old[:32 + nvox * 16])
            struct.pack_into('<H', summary, 4, 2)
            counts, colors = [], []
            for local in range(nvox):
                off = 32 + local * 16
                if version == 1:
                    count, start = struct.unpack_from('<HI', old, off)
                    color = old[off + 6:off + 9]
                    flags = old[off + 9]
                    row = struct.unpack_from('<I', old, off + 10)[0]
                    struct.pack_into('<II3sBI', summary, off, count, start, color, flags, row)
                else:
                    count = struct.unpack_from('<I', old, off)[0]
                    color = old[off + 8:off + 11]
                counts.append(count)
                colors.append(tuple(color))
            target = output / entry['meta_path']
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(summary)
            entry.update({f'meta_{k}': v for k, v in blob(target, output).items()})
            postings = target.with_name('postings.bin')
            if version == 1:
                postings.write_bytes(old[32 + nvox * 16:])
            else:
                shutil.copyfile(source / entry['postings']['path'], postings)
            entry['postings'] = blob(postings, output)
            atlas = output / entry['atlas_path']
            atlas.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source / entry['atlas_path'], atlas)
            levels = []
            for step in (4, 2, 1):
                cells = {}
                for local, count in enumerate(counts):
                    if not count:
                        continue
                    x, y, z = local % vpc, local // vpc % vpc, local // (vpc * vpc)
                    key = (x // step, y // step, z // step)
                    total, color, representative = cells.get(key, (0, np.zeros(3), local))
                    cells[key] = total + count, color + np.array(colors[local]) * count, representative
                offset = bricks.tell()
                for (x, y, z), (count, color, representative) in sorted(cells.items()):
                    # u16 local x,y,z; u16 representative; u32 count; RGB + pad = 16B
                    bricks.write(struct.pack('<4HI3BB', x * step, y * step, z * step, representative,
                        count, *np.rint(color / count).astype(int), 0))
                levels.append(dict(offset=offset, count=len(cells), step=step))
            nodes.append(dict(chunk=entry['chunk_id'], xyz=[entry['cx'], entry['cy'], entry['cz']],
                count=entry['n_points'], levels=levels))
    # Chunk octree: internal proxy bricks contain one representative per occupied child.
    tree = []
    def branch(ids, origin, span):
        index = len(tree)
        tree.append(None)
        if span == 1:
            node = dict(origin=origin, span=span, leaf=ids[0], children=[])
        else:
            half = span // 2
            groups = {}
            for i in ids:
                xyz = nodes[i]['xyz']
                octant = tuple(int(xyz[k] >= origin[k] + half) for k in range(3))
                groups.setdefault(octant, []).append(i)
            children = [branch(group, [origin[k] + key[k] * half for k in range(3)], half)
                        for key, group in sorted(groups.items())]
            node = dict(origin=origin, span=span, children=children)
        node['count'] = sum(nodes[i]['count'] for i in ids)
        tree[index] = node
        return index
    side = 1
    while side < raw['world']['chunks_per_axis']:
        side *= 2
    if nodes:
        branch(list(range(len(nodes))), [0, 0, 0], side)
    hierarchy = dict(version=1, file='bricks.bin', bytes=brick_path.stat().st_size,
                     nodes=nodes, tree=tree, num_voxels=ngrid)
    (output / 'hierarchy.json').write_text(json.dumps(hierarchy, separators=(',', ':')))
    raw['streaming'] = dict(version=1, hierarchy='hierarchy.json')
    if minimap:
        build_spatial(source, output, minimap, raw)
    (output / 'manifest.json').write_text(json.dumps(raw, indent=2))
    return dict(points=raw['point_source']['n_points'], chunks=len(nodes),
                brick_bytes=brick_path.stat().st_size, hierarchy_nodes=len(tree))


def build_spatial(source: Path, output: Path, minimap: Path, raw: dict):
    n = raw['point_source']['n_points']
    xy_path = minimap / 'points/xy_id.bin'
    if xy_path.stat().st_size != n * 8:
        raise ValueError('Minimap and chunk pack row counts differ')
    xy = np.memmap(xy_path, dtype=np.dtype([('x','<u2'),('y','<u2'),('packed','<u4')]), mode='r')
    rv = np.memmap(source / raw['row_to_voxel']['path'], dtype=np.dtype([('chunk','<u4'),('local','<u2'),('pad','<u2')]), mode='r')
    row_xy = np.memmap(output / 'row_xy.bin', dtype='<u2', mode='w+', shape=(n, 2))
    pages = []
    with (output / 'spatial.bin').open('wb') as dest:
        for start in range(0, n, 4096):
            batch = xy[start:start + 4096]
            rows = batch['packed'] & 0x0fffffff
            if np.any(rows >= n):
                raise ValueError('Minimap row outside points table')
            data = np.zeros(len(batch), dtype=np.dtype([('x','<u2'),('y','<u2'),('row','<u4'),('chunk','<u4'),('local','<u2'),('corpus','u1'),('pad','u1')]))
            data['x'], data['y'], data['row'] = batch['x'], batch['y'], rows
            data['chunk'], data['local'] = rv['chunk'][rows], rv['local'][rows]
            data['corpus'] = batch['packed'] >> 28
            row_xy[rows, 0], row_xy[rows, 1] = batch['x'], batch['y']
            pages.append([start, len(batch), int(batch['x'].min()), int(batch['y'].min()),
                          int(batch['x'].max()), int(batch['y'].max())])
            dest.write(data.tobytes())
    row_xy.flush()
    # Density is bounded independently of N; copy its existing pyramid, never xy_id.bin.
    shutil.copytree(minimap / 'density', output / 'density')
    shutil.copyfile(minimap / 'manifest.json', output / 'minimap.json')
    (output / 'spatial.json').write_text(json.dumps(dict(version=1, count=n, file='spatial.bin', pages=pages)))
    raw['streaming'].update(spatial='spatial.json', row_xy='row_xy.bin', minimap_base='minimap.json')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('--minimap', type=Path)
    args = parser.parse_args()
    print(convert(args.source, args.output, args.minimap))
