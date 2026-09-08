import importlib.util
import json
from pathlib import Path

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq
import pytest


def test_source_ids_require_shards_and_hash_collisions_are_never_guessed(tmp_path):
    pytest.importorskip("duckdb")
    path = Path(__file__).resolve().parents[1] / "scripts/build_monet_search_identity.py"
    spec = importlib.util.spec_from_file_location("monet_identity", path)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    mapping, hashes, catalog = [tmp_path / f"{name}.parquet" for name in ("map", "ann", "catalog")]
    pq.write_table(pa.table({"row": [0, 1, 2, 3], "shard": [0, 1, 0, 0], "id": ["A", "A", "B", "C"]}), mapping)
    pq.write_table(pa.table({"row_id": [0, 1, 2, 3], "hash_perceptual": ["h2", "collision", "h1", "collision"]}), hashes)
    pq.write_table(pa.table({"id": ["A", "A", "B", "C"], "local_path": ["one", "two", "one", "one"],
                            "hash_perceptual": ["h1", "h2", "collision", "collision"]}), catalog)
    output, scratch = tmp_path / "output", tmp_path / "scratch"; scratch.mkdir()
    report = module.join_identity(mapping, ["v1.2.0/one", "v1.2.0/two"], hashes, catalog, output, scratch, 4)
    assert np.fromfile(output / "ann_to_row.u32", dtype="<u4").tolist() == [1, 0xffffffff, 0, 0xffffffff]
    assert json.loads((output / "ambiguous.json").read_text()) == {"1": [2, 3], "3": [2, 3]}
    assert report["exact_source_join"] and report["ambiguous_ann_ids"] == 2
