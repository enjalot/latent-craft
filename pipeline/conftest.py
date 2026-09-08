"""Small shared catalog fixture for local and deployed metadata contracts."""
import json
import sqlite3
import pytest


@pytest.fixture
def catalog_store(tmp_path):
    from metadata_server import MetadataStore
    path = tmp_path / "metadata.sqlite"
    db = sqlite3.connect(path)
    db.executescript("""
      CREATE TABLE info(key TEXT, value TEXT);
      CREATE TABLE books(id TEXT, title TEXT, author TEXT, publisher TEXT, place TEXT, ark TEXT);
      CREATE TABLE images(row_id INTEGER, subset TEXT, local_idx INTEGER, book TEXT, year INTEGER,
        chunk INTEGER, voxel INTEGER, position INTEGER, fname TEXT, volume TEXT, page TEXT, flickr TEXT);
    """)
    db.executemany("INSERT INTO info VALUES (?,?)", [(k, json.dumps(v)) for k, v in {"identity": "ab" * 32, "rows": 8}.items()])
    db.execute("INSERT INTO books VALUES ('000000001', 'A 100% book', 'Author', '', 'London', '')")
    for i in range(8):
        db.execute("INSERT INTO images VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", (i, "covers" if i < 4 else "plates", i % 4,
                   "000000001" if i < 4 else "000000002", None if i == 0 else 1800 + i, i // 4, i % 2, i // 2, f"00000000{1 if i < 4 else 2}_source", "0", "000022", None))
    db.commit(); db.close()
    instance = MetadataStore(path)
    yield instance
    instance.db.close()
