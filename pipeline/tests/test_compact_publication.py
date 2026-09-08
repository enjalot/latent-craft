import importlib.util
import json
from pathlib import Path
import struct
import numpy as np
import pandas as pd
import pytest
from lsvoxel.chunkpack import build, metablob
from lsvoxel.chunkpack.streaming import convert
from lsvoxel.minimap.build import build_minimap_pack

def module(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).parents[1] / f"scripts/{name}.py")
    result = importlib.util.module_from_spec(spec); spec.loader.exec_module(result); return result
compact = module("compact_streaming_pack")
audit = module("verify_fullcorpus_monet")

def test_compact_pack_preserves_every_join_and_save_identity(tmp_path, monkeypatch):
    n = 47
    points = tmp_path / "points"; points.mkdir()
    coords = [tmp_path / f"coords{dim}.npy" for dim in (2, 3)]
    for dim, path in zip((2, 3), coords): np.save(path, np.random.default_rng(dim).normal(size=(n, dim)).astype(np.float32))
    refs = np.arange(n, dtype=np.uint32)
    np.save(points / "thumb_refs.npy", refs); np.save(points / "source_codes.npy", np.zeros(n, dtype=np.uint8))
    (points / "provenance.json").write_text(json.dumps(dict(dataset="fixture", n_points=n, coordinates=[dict(path=str(p)) for p in coords])))
    table = pd.DataFrame(dict(row_id=refs, global_idx=refs, subset="images"))
    source, stream, minimap, output = [tmp_path / name for name in ("source", "stream", "minimap", "compact")]
    build_minimap_pack("fixture", coords[0], table, minimap, {"images": 0}, overview_only=True)
    monkeypatch.setattr(build.atlas_mod, "encode_ktx2", lambda png, out, **kwargs: out.write_bytes(b"fixture-atlas"))
    class Thumbs:
        def open(self, row): return b""
    build.assign_and_build("fixture", table, np.load(coords[1]), 16, Thumbs(), source, {"images": 0}, "{local_idx}", "fixture", points / "points.parquet", wide_counts=True)
    convert(source, stream, minimap)
    before = (stream / "manifest.json").read_bytes()
    result = compact.compact(stream, output)
    assert result["publication_bytes"] < result["original_bytes"]
    manifest = json.loads((output / "manifest.json").read_text())
    assert manifest["point_index"]["bytes"] == n*5 and manifest["row_to_voxel"]["bytes"] == n*4
    assert manifest["save_identity"] == "/chunks/stream"
    assert audit.verify(output, points)["full_row_joins_verified"]
    assert (stream / "manifest.json").read_bytes() == before
    assert metablob.read_chunk_meta(stream / "c/000000/meta.bin").n_points == n
    with pytest.raises(FileExistsError): compact.compact(stream, output)
    raw = bytearray((output / "c/000000/meta.bin").read_bytes())
    struct.pack_into("<H", raw, 50, struct.unpack_from("<H", raw, 32)[0])
    corrupt = output / "c/000000/corrupt.bin"; corrupt.write_bytes(raw)
    with pytest.raises(ValueError, match="sparse voxel IDs"): metablob.read_chunk_meta(corrupt)

def test_dense_summary_avoids_sparse_overhead():
    records = metablob.new_voxel_records(4096, wide=True); records["count"] = 1
    header = np.zeros(1, dtype=metablob.HEADER_DTYPE)
    header["magic"] = b"LSV1"; header["version"] = 2; header["n_voxel_records"] = 4096
    raw = header.tobytes() + records.tobytes()
    assert compact.sparse_summary(raw) == (raw, 2)
