import hashlib
import io
import json
import struct

from PIL import Image
import pytest

from lsvoxel.thumbnail_release import build_release, validate_source


@pytest.fixture
def source(tmp_path):
    root = tmp_path / "source"
    (root / "shards").mkdir(parents=True)
    raw = io.BytesIO()
    Image.new("RGB", (256, 128), "red").save(raw, format="WEBP")
    image = raw.getvalue()
    for shard in range(2):
        (root / "shards" / f"{shard:04d}.blob").write_bytes(image + image)
        (root / "shards" / f"{shard:04d}.offsets.u64").write_bytes(struct.pack("<QQQQ", 0, len(image), len(image), len(image)*2))
    (root / "manifest.json").write_text(json.dumps(dict(version=1, encoding="monet-u64-offsets", rows=6,
        shards=[[3, len(image)*2], [3, len(image)*2]])))
    return root


def test_resume_preserves_ids_missing_spans_and_source_bytes(source, tmp_path):
    output = tmp_path / "release"
    before = {p: hashlib.sha256(p.read_bytes()).hexdigest() for p in source.rglob("*") if p.is_file()}
    partial = build_release(source, output, workers=1, limit=1, expected_rows=6)
    assert partial["state"] == "partial" and not (output / "manifest.json").exists()
    first = (output / "shards/0000.blob").stat().st_mtime_ns
    complete = build_release(source, output, workers=1, expected_rows=6)
    assert complete["state"] == "complete" and complete["completed_rows"] == 6
    assert (output / "shards/0000.blob").stat().st_mtime_ns == first
    manifest = json.loads((output / "manifest.json").read_text())
    assert manifest["thumbnail_size"] == 128 and manifest["rows"] == 6
    for shard in range(2):
        data = (output / "shards" / f"{shard:04d}.blob").read_bytes()
        offsets = struct.unpack("<QQQQ", (output / "shards" / f"{shard:04d}.offsets.u64").read_bytes())
        assert offsets[0] == 0 and offsets[-1] == len(data) and offsets[1] == offsets[2]
        for row in (0, 2):
            with Image.open(io.BytesIO(data[offsets[row]:offsets[row+1]])) as image:
                assert image.size == (128, 64)
    assert before == {p: hashlib.sha256(p.read_bytes()).hexdigest() for p in before}


def test_changed_completed_output_is_not_overwritten(source, tmp_path):
    output = tmp_path / "release"
    build_release(source, output, workers=1)
    blob = output / "shards/0000.blob"
    blob.write_bytes(b"changed")
    with pytest.raises(ValueError, match="refusing to overwrite"):
        build_release(source, output, workers=1)
    assert blob.read_bytes() == b"changed"


def test_source_identity_and_bounds(source, tmp_path):
    output = tmp_path / "release"
    with pytest.raises(ValueError, match="row count"):
        build_release(source, output, expected_rows=7)
    with pytest.raises(ValueError, match="separate"):
        build_release(source, source / "nested")
    with pytest.raises(ValueError, match="Invalid worker"):
        build_release(source, output, workers=100)
    with pytest.raises(ValueError):
        validate_source(dict(version=1, encoding="monet-u64-offsets", rows=1, shards=[[1, -1]]))


def test_truncated_source_never_publishes_manifest(source, tmp_path):
    (source / "shards/0001.blob").write_bytes(b"bad")
    output = tmp_path / "release"
    with pytest.raises(ValueError, match="size changed"):
        build_release(source, output, workers=1)
    assert not (output / "manifest.json").exists()
    assert json.loads((output / "progress.json").read_text())["state"] == "failed"
