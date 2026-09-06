import struct
import threading

import numpy as np
import pandas as pd
import pytest

from lsvoxel.chunkpack import atlas_jobs, metablob


def test_parallel_atlases_are_bounded_and_yield_in_input_order(tmp_path, monkeypatch):
    first_pair = threading.Event()
    completed = []
    def prepare(chunk, *args):
        if chunk == 0:
            assert first_pair.wait(2)
        if chunk == 1:
            first_pair.set()
        completed.append(chunk)
        return chunk
    monkeypatch.setattr(atlas_jobs, "prepare_atlas", prepare)
    iterator = atlas_jobs.ordered_atlases(range(10), dict.fromkeys(range(10)), None,
        tmp_path, tmp_path, 32, 2048, "unused", workers=2)
    assert next(iterator) == 0
    # First yield admits only the initial pair plus its single replacement.
    assert len(completed) <= 3
    assert list(iterator) == list(range(1, 10))


def test_reuse_requires_matching_representative_and_atlas_dimensions(tmp_path, monkeypatch):
    old = tmp_path / "old"
    meta_path = old / "c/000000/meta.bin"
    records = metablob.new_voxel_records(4096, wide=True)
    records["count"][7] = 1; records["repr_row_id"][7] = 19
    records["color_rgb"][7] = [10, 20, 30]
    metablob.write_chunk_meta(meta_path, metablob.ChunkMeta(0, 16, 32, records, np.array([19], dtype=np.uint32)))
    header = bytearray(80); header[:12] = b"\xabKTX 20\xbb\r\n\x1a\n"
    struct.pack_into("<II", header, 20, 32, 32)
    meta_path.with_name("atlas.ktx2").write_bytes(header)
    class Thumbs:
        def open(self, row): return b"thumbnail-present"
    reps = pd.DataFrame(dict(local_voxel_id=[7], repr_row_id=[19]))
    monkeypatch.setattr(atlas_jobs.atlas, "encode_ktx2", lambda *a, **kw: pytest.fail("Re-encoded a matching atlas"))
    result = atlas_jobs.prepare_atlas(0, reps, Thumbs(), tmp_path / "output", tmp_path, 32, 2048, "unused", old)
    assert result["blank"] == 0 and result["width"] == 32
    np.testing.assert_array_equal(result["colors"], [[10, 20, 30]])
    reps.loc[0, "repr_row_id"] = 20
    with pytest.raises(ValueError, match="mismatched atlas"):
        atlas_jobs.prepare_atlas(0, reps, Thumbs(), tmp_path / "output2", tmp_path, 32, 2048, "unused", old)
