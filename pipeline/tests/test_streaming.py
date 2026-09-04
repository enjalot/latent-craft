import struct
import json
from urllib.request import Request, urlopen
from urllib.error import HTTPError
import numpy as np
import pytest
from lsvoxel.chunkpack import metablob, voxel_proxy
from lsvoxel.chunkpack.streaming import convert, blob
from test_data_server_meta import server


@pytest.mark.parametrize('range_header,expected', [
    ('bytes=0-5', b'static'), ('bytes=7-', b'still works\n'), ('bytes=-6', b'works\n'),
])
def test_static_ranges(server, range_header, expected):
    request = Request(server + '/hello.txt', headers={'Range': range_header})
    with urlopen(request) as response:
        assert response.status == 206
        assert response.read() == expected
        assert int(response.headers['Content-Length']) == len(expected)
        assert response.headers['ETag']


@pytest.mark.parametrize('value', ['bytes=99-', 'bytes=7-3', 'bytes=-0', 'bytes=1-2,4-5', 'bytes=-'])
def test_invalid_ranges(server, value):
    with pytest.raises(HTTPError) as error:
        urlopen(Request(server + '/hello.txt', headers={'Range': value}))
    assert error.value.code == 416
    assert error.value.headers['Content-Range'] == 'bytes */19'


def test_range_head_and_if_range(server):
    with urlopen(Request(server + '/hello.txt', headers={'Range': 'bytes=0-2'}, method='HEAD')) as response:
        assert response.status == 200
        assert response.read() == b''
        assert response.headers['Content-Length'] == '19'
    with urlopen(Request(server + '/hello.txt', headers={'Range': 'bytes=0-2', 'If-Range': '"stale"'})) as response:
        assert response.status == 200
        assert response.read() == b'static still works\n'


def test_wide_counts_and_postings_roundtrip(tmp_path):
    records = metablob.new_voxel_records(4096, wide=True)
    records['count'][3] = 1_000_000
    records['repr_row_id'][3] = 99_999_999
    path = tmp_path / 'meta.bin'
    metablob.write_chunk_meta(path, metablob.ChunkMeta(0, 16, 32, records, np.arange(1_000_000, dtype='<u4')))
    assert path.stat().st_size == 65568
    assert struct.unpack_from('<H', path.read_bytes(), 4)[0] == 2
    result = metablob.read_chunk_meta(path)
    assert result.voxel_records['count'][3] == 1_000_000
    assert result.point_ids[-1] == 999_999
    proxy = voxel_proxy.records_for_chunk(0, records)
    voxel_proxy.write_voxel_proxy(tmp_path / 'proxy.bin', 160, 16, proxy)
    assert voxel_proxy.read_voxel_proxy(tmp_path / 'proxy.bin').records['count'][0] == 1_000_000


def test_converter_conserves_counts_at_every_proxy_level(tmp_path):
    source, output = tmp_path / 'source', tmp_path / 'release'
    source.mkdir()
    records = metablob.new_voxel_records(4096, wide=True)
    records['count'][0], records['count'][4095] = 150, 50
    records['point_offset'][4095] = 150
    records['color_rgb'][0], records['color_rgb'][4095] = [100, 120, 140], [200, 40, 60]
    meta = source / 'c/000000/meta.bin'
    metablob.write_chunk_meta(meta, metablob.ChunkMeta(0, 16, 32, records, np.arange(200, dtype='<u4')))
    atlas = meta.with_name('atlas.ktx2')
    atlas.write_bytes(b'opaque-atlas-fixture')
    raw = dict(world=dict(num_voxels=160, voxels_per_chunk=16, chunks_per_axis=10), point_source=dict(n_points=200))
    for key in ('point_index', 'row_to_voxel', 'proxy', 'voxel_proxy'):
        path = source / (key + '.bin')
        path.write_bytes(bytes(1600))
        raw[key] = blob(path, source)
    entry = dict(chunk_id=0, cx=0, cy=0, cz=0, n_points=200, n_occupied_voxels=2,
                 postings=blob(meta.with_name('postings.bin'), source))
    entry.update({f'meta_{key}': value for key, value in blob(meta, source).items()})
    entry.update({f'atlas_{key}': value for key, value in blob(atlas, source).items()})
    raw['chunks'] = [entry]
    (source / 'manifest.json').write_text(json.dumps(raw))
    result = convert(source, output)
    hierarchy = json.loads((output / 'hierarchy.json').read_text())
    bricks = (output / 'bricks.bin').read_bytes()
    assert result['points'] == 200
    assert hierarchy['tree'][0]['count'] == 200
    for level in hierarchy['nodes'][0]['levels']:
        counts = [struct.unpack_from('<I', bricks, level['offset'] + i * 16 + 8)[0] for i in range(level['count'])]
        assert sum(counts) == 200
    assert (output / entry['postings']['path']).read_bytes() == np.arange(200, dtype='<u4').tobytes()
    with pytest.raises(FileExistsError):
        convert(source, output)
