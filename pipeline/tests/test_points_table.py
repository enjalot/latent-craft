"""points_table.write_points_table: an in-place rebuild may add columns but may never
change the rows that built packs are positional on; a refused write leaves the old
file byte-for-byte intact."""
from __future__ import annotations

import numpy as np
import pandas as pd
import pyarrow.parquet as pq
import pytest

from lsvoxel.points_table import write_points_table

CONTRACT = ("row_id", "subset", "global_idx")


def _table(n: int = 12) -> pd.DataFrame:
    return pd.DataFrame(
        {
            "row_id": np.arange(n, dtype=np.uint32),
            "subset": np.where(np.arange(n) % 2 == 0, "covers", "medium"),
            "global_idx": (np.arange(n) * 7 % 11).astype(np.int64),
            "fname": [f"f{i}.jpg" for i in range(n)],
        }
    )


def test_first_write_then_additive_rebuild(tmp_path):
    path = tmp_path / "points" / "demo" / "points.parquet"
    write_points_table(_table(), path, CONTRACT)
    assert pq.read_table(path).column_names == ["row_id", "subset", "global_idx", "fname"]

    rebuilt = _table().assign(image_url=[f"http://x/{i}" if i % 3 else None for i in range(12)])
    write_points_table(rebuilt, path, CONTRACT)
    got = pq.read_table(path)
    assert "image_url" in got.column_names
    assert got.column("image_url").null_count == 4
    assert not path.with_name("points.parquet.tmp").exists()


def test_rebuild_that_changes_rows_is_refused_and_old_file_survives(tmp_path):
    path = tmp_path / "points.parquet"
    write_points_table(_table(), path, CONTRACT)
    before = path.read_bytes()

    reordered = _table().iloc[::-1].reset_index(drop=True).assign(row_id=np.arange(12, dtype=np.uint32))
    with pytest.raises(ValueError, match="contract column 'subset' would change"):
        write_points_table(reordered, path, CONTRACT)

    shorter = _table(11)
    with pytest.raises(ValueError, match="row count would change"):
        write_points_table(shorter, path, CONTRACT)

    one_cell = _table()
    one_cell.loc[5, "global_idx"] = 999
    with pytest.raises(ValueError, match=r"'global_idx' would change in 1 of 12 rows \(first at row_id 5\)"):
        write_points_table(one_cell, path, CONTRACT)

    with pytest.raises(ValueError, match="missing contract column"):
        write_points_table(_table().drop(columns=["global_idx"]), path, CONTRACT)

    assert path.read_bytes() == before
    assert not path.with_name("points.parquet.tmp").exists()


def test_contract_compares_values_not_dtype_width(tmp_path):
    """A column read back from parquet as int64 must still match a uint32 frame column."""
    path = tmp_path / "points.parquet"
    write_points_table(_table(), path, CONTRACT)
    narrower = _table().assign(global_idx=lambda d: d["global_idx"].astype(np.uint32))
    write_points_table(narrower, path, CONTRACT)
