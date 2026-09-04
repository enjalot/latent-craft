#!/usr/bin/env python3
"""Build `point_meta.bin` (+ `point_meta.json`) for one points table from its
`image_url` / `image_width` / `image_height` columns, then verify the written file
through the same stdlib reader the data server uses: header, row count, and a random
sample of rows compared back against the parquet. Idempotent — re-running rewrites
the same bytes (atomically, so the server can keep serving through it).

Run it after every `lsvoxel build-points` rebuild: the file mirrors the table row for
row, and `scripts/data_server.py` reopens it on the next request (inode check), no
restart needed.

Usage: .venv/bin/python scripts/build_point_meta.py <points_id> [n_verify=1000]
  e.g. .venv/bin/python scripts/build_point_meta.py monet-random
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import numpy as np  # noqa: E402
import pyarrow.parquet as pq  # noqa: E402

from lsvoxel.config import point_meta_path, points_table_path  # noqa: E402
from lsvoxel.point_meta import PointMetaStore, write_point_meta  # noqa: E402

#: Same charset the data server's /meta route accepts — an id that can't be served
#: shouldn't get a file.
POINTS_ID = re.compile(r"^[a-z0-9-]+$")
COLUMNS = ("row_id", "image_url", "image_width", "image_height")


def main() -> int:
    if len(sys.argv) not in (2, 3):
        print(__doc__, file=sys.stderr)
        return 2
    points_id = sys.argv[1]
    n_verify = int(sys.argv[2]) if len(sys.argv) == 3 else 1000
    if not POINTS_ID.match(points_id):
        print(f"[build_point_meta] points id must match {POINTS_ID.pattern}", file=sys.stderr)
        return 2
    table_path = points_table_path(points_id)
    out_path = point_meta_path(points_id)
    if not table_path.is_file():
        print(f"[build_point_meta] no points table at {table_path}", file=sys.stderr)
        return 1

    print(f"[build_point_meta] reading {table_path}", flush=True)
    table = pq.read_table(table_path, columns=list(COLUMNS))
    n = table.num_rows
    row_id = table.column("row_id").to_numpy()
    if not np.array_equal(row_id, np.arange(n, dtype=row_id.dtype)):
        print("[build_point_meta] points table is not dense row_id-ordered", file=sys.stderr)
        return 1

    summary = write_point_meta(
        out_path,
        table.column("image_url"),
        table.column("image_width").to_numpy(),
        table.column("image_height").to_numpy(),
    )
    print(f"[build_point_meta] wrote {out_path}: {summary}", flush=True)

    # Verify through the stdlib reader against the parquet — the reader is what the
    # server trusts, so its answers are what has to match.
    urls = table.column("image_url").to_pylist() if n <= n_verify else None
    widths = table.column("image_width").to_numpy()
    heights = table.column("image_height").to_numpy()
    rng = np.random.default_rng(0)
    sample = np.arange(n) if n <= n_verify else np.sort(rng.choice(n, size=n_verify, replace=False))
    with PointMetaStore(out_path) as store:
        if store.n_rows != n:
            print(f"[build_point_meta] reader sees {store.n_rows} rows, table has {n}", file=sys.stderr)
            return 1
        url_col = table.column("image_url")
        for i in sample.tolist():
            rec = store.lookup(i)
            expect_url = urls[i] if urls is not None else url_col[i].as_py()
            if not expect_url:
                expect_url = None
            expect = {
                "url": expect_url,
                "width": int(min(max(int(widths[i]), 0), 0xFFFF)),
                "height": int(min(max(int(heights[i]), 0), 0xFFFF)),
            }
            if rec != expect:
                print(f"[build_point_meta] row {i}: reader {rec} != table {expect}", file=sys.stderr)
                return 1
    print(
        f"[build_point_meta] verified {len(sample):,} of {n:,} rows via the stdlib reader "
        f"({summary['n_with_url']:,} rows with a url, {summary['bytes']:,} bytes)",
        flush=True,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
