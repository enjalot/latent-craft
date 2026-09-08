"""Range identity, response bounds and resize correctness, without cloud writes."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import struct
import pytest


@pytest.fixture
def runtime():
    pytest.importorskip("fastapi")
    path = Path(__file__).resolve().parents[2] / "deploy/thumbnail-pilot/server.py"
    spec = importlib.util.spec_from_file_location("thumbnail_runtime", path)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


@pytest.fixture
def client(runtime, tmp_path):
    from fastapi.testclient import TestClient
    (tmp_path / "256").mkdir()
    files = []
    for name, data in [("256/0001.blob", b"0123456789"), ("256/0001.offsets.u64", struct.pack("<QQQ", 0, 3, 10))]:
        (tmp_path / name).write_bytes(data)
        files.append({"path": name, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()})
    (tmp_path / "manifest.json").write_text(json.dumps({"rows": 2, "files": files, "shards": {"0001": {"rows": 2, "256": 10}}}))
    return TestClient(runtime.create_app(tmp_path))


def test_range_headers_and_resolved_image_agree(client):
    response = client.get("/packs/256/0001.blob", headers={"Range": "bytes=3-9", "Origin": "http://gsv.local:5300"})
    assert response.status_code == 206
    assert response.content == b"3456789"
    assert response.headers["content-range"] == "bytes 3-9/10"
    assert response.headers["content-length"] == "7"
    assert response.headers["access-control-allow-origin"] == "*"
    assert response.headers["accept-ranges"] == "bytes"
    assert float(response.headers["x-read-ms"]) >= 0
    assert client.get("/thumbs/256/65537.webp").content == response.content
    offsets = client.get("/packs/256/0001.offsets.u64", headers={"Range": "bytes=8-23"})
    assert offsets.status_code == 206 and offsets.content == struct.pack("<QQ", 3, 10)
    head = client.head("/packs/256/0001.blob")
    assert head.status_code == 200 and head.content == b"" and head.headers["content-length"] == "10"


def test_ranges_are_bounded_and_missing_ids_do_not_escape_files(client, runtime):
    for value in (None, "bytes=10-11", "bytes=8-7", "bytes=-0", "bytes=0-1,3-5", "bytes=" + "9"*100 + "-"):
        response = client.get("/packs/256/0001.blob", headers={"Range": value} if value else {})
        assert response.status_code == 416
        assert response.headers["content-range"] == "bytes */10"
    assert runtime.byte_range("bytes=-3", 10) == (7, 3)
    assert runtime.byte_range("bytes=8-100", 10) == (8, 2)
    with pytest.raises(Exception) as error: runtime.byte_range("bytes=0-", runtime.MAX_RANGE+1)
    assert error.value.status_code == 416
    for path in ("/thumbs/256/65538.webp", "/thumbs/256/-1.webp", "/thumbs/256/4294967296.webp", "/packs/32/0001.blob", "/packs/256/secret", "/packs/256/0002.blob"):
        assert client.get(path).status_code == 404


def test_resize_preserves_aspect_and_bounds_without_upscaling():
    from PIL import Image
    from lsvoxel.thumbnail_quality import resize_thumbnail
    for size, expected in [((256, 128), (128, 64)), ((100, 200), (64, 128)), ((64, 32), (64, 32))]:
        src = io.BytesIO(); Image.new("RGB", size, "red").save(src, format="WEBP")
        data = resize_thumbnail(src.getvalue())
        with Image.open(io.BytesIO(data)) as output:
            assert output.size == expected and output.mode == "RGB" and output.format == "WEBP"
    with pytest.raises(ValueError): resize_thumbnail(b"", 128)
    with pytest.raises(ValueError): resize_thumbnail(b"fake", 256)
    large = io.BytesIO(); Image.new("RGB", (300, 300)).save(large, format="WEBP")
    with pytest.raises(ValueError): resize_thumbnail(large.getvalue())
