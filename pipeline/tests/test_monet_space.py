import importlib.util
from pathlib import Path
from collections import OrderedDict
import threading

import numpy as np
import pytest


@pytest.fixture
def runtime():
    pytest.importorskip("fastapi")
    path = Path(__file__).resolve().parents[2] / "deploy/monet-space/app.py"
    spec = importlib.util.spec_from_file_location("monet_runtime", path)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


def test_release_result_join_cache_and_admission(runtime):
    from fastapi import HTTPException
    from types import SimpleNamespace
    s = runtime.MonetService.__new__(runtime.MonetService)
    s.lock = threading.Lock(); s.cache = OrderedDict()
    s.config = {"dataset": "test", "release": "release", "identity": "ab" * 32}
    s.mapping = np.array([1, 0], dtype="uint32")
    s.voxels = np.array([7 << 12 | 6, 32000 << 12 | 4095], dtype="uint32")
    s.points = np.array([(10, 0), (712976143, 8)], dtype=[("thumb", "<u4"), ("subset", "u1")])
    calls = []
    s.embed = lambda q: calls.append(q) or np.ones(512, dtype="float32")
    s.faiss = SimpleNamespace(omp_set_num_threads=lambda n: None)
    s.index = SimpleNamespace(search=lambda q, k: (np.array([[.3, .2]]), np.array([[0, 1]])))
    result = s.search("hello")
    assert result["results"][0] == dict(row=1, chunk=32000, local=4095, thumb=712976143, score=.3,
        model="CLIP ViT-B/32", thumbUrl="/thumbs/monet/712976143.webp")
    assert s.search("hello")["embedding_cached"] and calls == ["hello"]
    s.lock.acquire()
    with pytest.raises(HTTPException) as error: s.search("busy")
    assert error.value.status_code == 429
    s.lock.release()
    s.mapping[0] = 0xffffffff
    with pytest.raises(ValueError, match="join"): s.search("invalid")
    assert not s.lock.locked()


def test_bounded_input_and_no_arbitrary_thumbnail_requests(runtime):
    from pydantic import ValidationError
    from fastapi import HTTPException
    for payload in [{"query": ""}, {"query": "a" * 401}, {"query": "map", "backend": "other"}]:
        with pytest.raises(ValidationError): runtime.SearchRequest(**payload)
    with pytest.raises(HTTPException) as error: runtime.search(runtime.SearchRequest(query="map"))
    assert error.value.status_code == 503
    for filename in ("../model", "https://example.com", "4294967296.webp"):
        with pytest.raises(HTTPException) as error: runtime.thumbnail(filename)
        assert error.value.status_code == 404


def test_ranges_never_fall_back_to_whole_object(runtime, monkeypatch):
    from fastapi import HTTPException
    class WholeObject:
        status = 200
        headers = {}
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def read(self, n): pytest.fail("Must reject 200 before reading its body")
    monkeypatch.setattr(runtime.urllib.request, "urlopen", lambda *a, **k: WholeObject())
    with pytest.raises(HTTPException) as error: runtime.read_range("https://example.test/file", 8, 16, 1000)
    assert error.value.status_code == 502


def test_encoded_range_is_rejected_before_reading(runtime, monkeypatch):
    from fastapi import HTTPException
    class Encoded:
        status = 206
        headers = {"Content-Range": "bytes 8-23/1000", "Content-Encoding": "gzip"}
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def read(self, n): pytest.fail("Do not read transformed byte ranges")
    monkeypatch.setattr(runtime.urllib.request, "urlopen", lambda *a, **k: Encoded())
    with pytest.raises(HTTPException) as error:
        runtime.read_range("https://example.test/file", 8, 16, 1000)
    assert error.value.status_code == 502
