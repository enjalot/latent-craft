"""Writing a points table — where the row-order contract is enforced at write time.

A points table's row ORDER is frozen the moment anything is built from it: the UMAP
coordinates (row i == row_id i), every chunk pack (`point_index.bin`,
`row_to_voxel.bin`, the atlases' `repr_row_id`s), every minimap pack, and
`point_meta.bin` are all positional. Nothing downstream re-keys; row_id IS the key.

So a table may be REBUILT in place — to add a column, say — only if the rebuilt table
is the same table row for row. `write_points_table` makes that a hard check instead of
a convention: when a file already exists at the target path, the new frame must have
the same row count and identical values in the dataset's *contract columns* (the
per-row values that built packs carry or key off; each dataset module names its own),
or the write is refused and the existing file is left exactly as it was.

The write itself is tmp + `os.replace`, so a reader (the data server, a running
pack build) never sees a half-written parquet, and a build that dies mid-write never
takes the previous table down with it.
"""
from __future__ import annotations

import os
from collections.abc import Sequence
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow.parquet as pq


def write_points_table(df: pd.DataFrame, out_path: Path, contract_columns: Sequence[str]) -> None:
    """Write `df` to `out_path` atomically, refusing to replace an existing table
    whose rows the new one doesn't reproduce (see the module docstring)."""
    missing = [c for c in contract_columns if c not in df.columns]
    if missing:
        raise ValueError(f"points table is missing contract column(s) {missing}")
    if out_path.exists():
        check_rebuild_preserves_rows(df, out_path, contract_columns)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = out_path.with_name(out_path.name + ".tmp")
    try:
        df.to_parquet(tmp, index=False)
        os.replace(tmp, out_path)
    finally:
        if tmp.exists():
            tmp.unlink()


def check_rebuild_preserves_rows(
    df: pd.DataFrame, existing_path: Path, contract_columns: Sequence[str]
) -> None:
    """Raise unless `df` has the same row count as the table at `existing_path` and
    the same value in every contract column of every row. Only the contract columns
    are read from the existing file, so this costs a fraction of a full read."""
    existing = pq.read_table(existing_path, columns=list(contract_columns))
    if existing.num_rows != len(df):
        raise ValueError(
            f"refusing to rebuild {existing_path}: row count would change "
            f"{existing.num_rows:,} -> {len(df):,}, but every built pack is positional on "
            "row_id (see lsvoxel/points_table.py)"
        )
    for col in contract_columns:
        old = existing.column(col).to_numpy(zero_copy_only=False)
        new = df[col].to_numpy()
        # array_equal compares values, not dtype width, so an int64 column read back
        # against a uint32 frame column is still a match when the numbers agree.
        if not np.array_equal(old, new):
            differs = np.flatnonzero(old != new)
            first = int(differs[0]) if len(differs) else -1
            raise ValueError(
                f"refusing to rebuild {existing_path}: contract column {col!r} would change "
                f"in {len(differs):,} of {len(df):,} rows (first at row_id {first}) — the "
                "row order is frozen by the packs built from this table "
                "(see lsvoxel/points_table.py)"
            )
