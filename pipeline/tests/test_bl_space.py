"""Public runtime boundary checks; no model download or cloud writes."""
import importlib.util
from pathlib import Path
import hashlib
import pytest


@pytest.fixture
def runtime():
    pytest.importorskip("fastapi")
    path = Path(__file__).resolve().parents[2] / "deploy/bl-space/app.py"
    spec = importlib.util.spec_from_file_location("bl_runtime", path)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


def test_search_validation(runtime):
    from pydantic import ValidationError
    assert runtime.SearchRequest(query="a map").backend == "faiss"
    for payload in [{"query": ""}, {"query": "a" * 401}, {"query": "map", "backend": "arbitrary-table"}]:
        with pytest.raises(ValidationError): runtime.SearchRequest(**payload)


def test_download_checks_and_reuses_verified_file(runtime, tmp_path, monkeypatch):
    source = tmp_path / "source"; source.write_bytes(b"verified test bytes")
    target = tmp_path / "target"
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    runtime.fetch_file(source.as_uri(), target, source.stat().st_size, digest)
    assert target.read_bytes() == source.read_bytes()
    monkeypatch.setattr(runtime.urllib.request, "urlopen", lambda *a, **k: pytest.fail("Verified cache must not download"))
    runtime.fetch_file(source.as_uri(), target, source.stat().st_size, digest)


def test_bad_checksum_never_publishes_target(runtime, tmp_path):
    source = tmp_path / "source"; source.write_bytes(b"wrong")
    target = tmp_path / "target"
    with pytest.raises(ValueError, match="checksum"):
        runtime.fetch_file(source.as_uri(), target, 5, "0" * 64)
    assert not target.exists()


def test_no_search_before_ready_and_no_arbitrary_thumbnail(runtime):
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as error:
        runtime.search(runtime.SearchRequest(query="a map"))
    assert error.value.status_code == 503
    for subset, filename in [("../../private", "00000000.webp"), ("plates", "../model"), ("plates", "1.webp")]:
        with pytest.raises(HTTPException) as error: runtime.thumbnail(subset, filename)
        assert error.value.status_code == 404
