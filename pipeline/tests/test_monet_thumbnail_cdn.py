import importlib.util
import json
from pathlib import Path
import struct
import pytest

spec = importlib.util.spec_from_file_location("thumbnail_cdn", Path(__file__).parents[1] / "scripts/prepare_monet_thumbnail_cdn.py")
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)


def test_index_preserves_shard_order_and_rejects_corrupt_spans(tmp_path):
    source = tmp_path / "source"; (source / "shards").mkdir(parents=True)
    (source / "manifest-full.json").write_text(json.dumps(dict(n_shards=2, n_shards_done=2, validity=dict(total_rows_done=5))))
    for shard, offsets in enumerate(([0,0,12], [0,5,8,10])):
        base = source / "shards" / f"{shard:04d}"
        base.with_suffix(".done").touch()
        base.with_suffix(".offsets.u64").write_bytes(struct.pack(f"<{len(offsets)}Q", *offsets))
        base.with_suffix(".blob").write_bytes(b"x" * offsets[-1])
    result = module.prepare(source, tmp_path / "release", link_shards=True)
    assert result["shards"] == [[2,12], [3,10]] and result["rows"] == 5
    assert (tmp_path / "release/shards").resolve() == source / "shards"
    with pytest.raises(FileExistsError): module.prepare(source, tmp_path / "release")
    with pytest.raises(ValueError): module.prepare(source, source / "nested")
    (source / "shards/0001.offsets.u64").write_bytes(struct.pack("<4Q", 0,9,8,10))
    with pytest.raises(ValueError, match="offsets"): module.prepare(source, tmp_path / "bad")
    assert not (tmp_path / "bad").exists()
