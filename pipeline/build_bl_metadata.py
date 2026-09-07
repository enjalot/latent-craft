"""Build a read-only, release-bound metadata sidecar; never modifies map packs."""
import argparse
import csv
import hashlib
import json
import re
import sqlite3
from pathlib import Path

import numpy as np
import pyarrow.parquet as pq


def build(points_path, catalog_dir, pack, output):
    output = Path(output)
    if output.exists():
        raise FileExistsError(output)
    manifest = json.loads((pack / "manifest.json").read_text())
    points = pq.read_table(points_path).to_pydict()
    n = len(points["row_id"])
    assert points["row_id"] == list(range(n)) and n == manifest["point_source"]["n_points"]
    identity = (pack / manifest["row_to_voxel"]["path"]).read_bytes()
    assert hashlib.sha256(identity).hexdigest() == manifest["row_to_voxel"]["sha256"]
    mapping = np.frombuffer(identity, dtype=np.dtype([("chunk", "<u4"), ("local", "<u2"), ("pad", "<u2")]))
    assert len(mapping) == n
    positions = np.full(n, -1, dtype=np.int32)
    for chunk in manifest["chunks"]:
        meta = (pack / chunk["meta_path"]).read_bytes()
        assert int.from_bytes(meta[4:6], "little") == 2
        records = np.frombuffer(meta, dtype="<u4", offset=32).reshape(-1, 4)
        postings = np.fromfile(pack / chunk["postings"]["path"], dtype="<u4")
        for local in np.flatnonzero(records[:, 0]):
            count, offset = map(int, records[local, :2])
            rows = postings[offset:offset + count]
            assert len(rows) == count and np.all(rows < n)
            assert np.all(positions[rows] == -1) and np.all(mapping["chunk"][rows] == chunk["chunk_id"]) and np.all(mapping["local"][rows] == local)
            positions[rows] = np.arange(count)
    assert np.all(positions >= 0)
    books = {}
    for file in sorted(catalog_dir.glob("*.tsv")):
        with file.open(newline="") as stream:
            for row in csv.DictReader(stream, delimiter="\t"):
                book = row["book_identifier"].zfill(9)
                value = (row["title"], row["first_author"], row["publisher"], row["pubplace"], row["ARK_id_of_book"])
                if book in books:
                    assert books[book][0] == value[0], f"Conflicting title: {book}"
                else:
                    books[book] = value
    flickr_path = catalog_dir.parent / "fname_to_flickr.parquet"
    flickr = pq.read_table(flickr_path, columns=["fname", "image_type", "volume", "page", "flickr_page_url"]).to_pydict()
    source = {}
    for i, fname in enumerate(flickr["fname"]):
        key = (fname, flickr["image_type"][i])
        assert key not in source
        source[key] = (str(flickr["volume"][i]), str(flickr["page"][i]), flickr["flickr_page_url"][i])
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = output.with_suffix(".building.sqlite")
    if staging.exists():
        raise FileExistsError(staging)
    db = sqlite3.connect(staging)
    db.executescript("""
      CREATE TABLE info (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE books (id TEXT PRIMARY KEY, title TEXT, author TEXT, publisher TEXT, place TEXT, ark TEXT);
      CREATE TABLE images (row_id INTEGER PRIMARY KEY, subset TEXT, local_idx INTEGER, book TEXT,
        year INTEGER, chunk INTEGER, voxel INTEGER, position INTEGER, fname TEXT, volume TEXT, page TEXT, flickr TEXT);
    """)
    db.executemany("INSERT INTO books VALUES (?,?,?,?,?,?)", ((key, *value) for key, value in books.items()))
    def images():
        for i in range(n):
            fname, subset = points["fname"][i], points["subset"][i]
            match = re.match(r"^(\d{9})_", fname)
            if not match:
                raise ValueError(f"Missing book identity at row {i}")
            date = str(points["date"][i])
            yield (i, subset, int(points["global_idx"][i]), match[1], int(date) if re.fullmatch(r"\d{4}", date) else None,
                   int(mapping["chunk"][i]), int(mapping["local"][i]), int(positions[i]), fname,
                   *source.get((fname, points["image_type"][i]), (None, None, None)))
    db.executemany("INSERT INTO images VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", images())
    db.executescript("""
      CREATE INDEX images_type_year ON images(subset, year);
      CREATE INDEX images_year ON images(year);
      CREATE INDEX images_book ON images(book);
      CREATE UNIQUE INDEX images_voxel ON images(chunk, voxel, position);
      ANALYZE;
    """)
    info = {"dataset": manifest["dataset_id"], "identity": manifest["row_to_voxel"]["sha256"], "rows": n,
            "voxelsPerChunk": manifest["world"]["voxels_per_chunk"], "chunksPerAxis": manifest["world"]["chunks_per_axis"],
            "sourceRevision": "ceb28b9cbdb06ab33b90072cf38d2f4a0c813ea0"}
    db.executemany("INSERT INTO info VALUES (?,?)", ((key, json.dumps(value)) for key, value in info.items()))
    db.commit()
    assert db.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    db.close()
    staging.rename(output)
    print(json.dumps({**info, "bytes": output.stat().st_size, "path": str(output)}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--points", type=Path, required=True)
    parser.add_argument("--catalog", type=Path, required=True)
    parser.add_argument("--pack", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    build(args.points, args.catalog, args.pack, args.output)
