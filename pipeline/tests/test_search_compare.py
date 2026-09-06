from contextlib import nullcontext
import json
from types import SimpleNamespace

import numpy as np
import pytest

from lsvoxel.search_compare import CompareService, DATASET, RELEASE, normalize_projection, validate_query


def test_projection_uses_fixed_frame_and_preserves_outliers():
    assert normalize_projection([0, 5, 10], [-10, 10, 0, 10, 0, 10]) == [0, 0, 1]
    assert normalize_projection([20, 5, -5], [-10, 10, 0, 10, 0, 10]) == [2, 0, -2]
    with pytest.raises(ValueError):
        normalize_projection([float("nan"), 0], [0, 1, 0, 1])


@pytest.mark.parametrize("change", [{"dataset": "monet-sscd-512"}, {"release": "stale"},
    {"query": " "}, {"query": "x"*401}, {"query": 123}, {"mode": "unknown"}])
def test_reject_incompatible_or_invalid_queries(change):
    with pytest.raises(ValueError):
        validate_query({"dataset": DATASET, "release": RELEASE, "mode": "project", "query": "car", **change})


def test_projection_path_does_not_prepare_or_query_index():
    service = object.__new__(CompareService)
    service.index_state = "not_loaded"
    service.prepare_index = lambda: pytest.fail("Projection loaded an index")
    service.embed = lambda q: (np.ones((1, 512), np.float32), False, False, 1)
    service.torch = SimpleNamespace(inference_mode=nullcontext, from_numpy=lambda x: x)
    service.heads = [lambda x: SimpleNamespace(numpy=lambda: np.array([[0, 0]])),
                     lambda x: SimpleNamespace(numpy=lambda: np.array([[2, 0, 0]]))]
    service.manifest = {"world": {"frame": {"extent": [-1, 1, -1, 1, -1, 1]}}}
    service.status = lambda: {"index_state": service.index_state}
    result = service.query("car", "project")
    assert result["projection"]["position"] == [2, 0, 0]
    assert result["projection"]["outside_frame"]
    assert result["results"] == []
    assert result["timings"]["search_ms"] == 0


def test_index_warmup_returns_before_embedding():
    service = object.__new__(CompareService)
    service.index_state = "loading"
    service.prepare_index = lambda: None
    service.embed = lambda q: pytest.fail("Embedded a query that cannot execute yet")
    assert service.query("car", "search") is None


def test_source_row_verification_rejects_permuted_thumbnails(tmp_path):
    training = tmp_path / "training"; training.mkdir()
    pool = tmp_path / "pool"; pool.mkdir()
    (training / "manifest.json").write_text(json.dumps({"n_rows": 3, "shards": [
        {"path": "b", "rows": 2}, {"path": "a", "rows": 1}]}))
    (pool / "manifest.json").write_text(json.dumps({"shards": ["a", "b"]}))
    service = object.__new__(CompareService)
    service.n = 3
    service.point_records = np.zeros(3, dtype=[("thumb", "<u4")])
    service.point_records["thumb"] = [65536, 65537, 0]
    service._verify_rows(training, pool)
    service.point_records["thumb"] = [65537, 65536, 0]
    with pytest.raises(ValueError, match="identity mismatch"):
        service._verify_rows(training, pool)


def test_exact_index_matches_numpy_cosine_and_preserves_row_order(tmp_path):
    pytest.importorskip("faiss")
    vectors = np.random.default_rng(42).normal(size=(64, 512)).astype(np.float32)
    path = tmp_path / "vectors.npy"
    np.save(path, vectors)
    service = object.__new__(CompareService)
    service.vectors_path = path
    service.n = len(vectors)
    service._build_index()
    assert service.index_state == "ready"
    q = vectors[13:14] / np.linalg.norm(vectors[13:14])
    scores, ids = service.index.search(q, 10)
    exact = (vectors / np.linalg.norm(vectors, axis=1, keepdims=True)) @ q[0]
    expected = np.argsort(-exact)[:10]
    np.testing.assert_array_equal(ids[0], expected)
    np.testing.assert_allclose(scores[0], exact[expected], atol=1e-6)
