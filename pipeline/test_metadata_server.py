import gzip
import json
import sqlite3
import struct

import pytest

from metadata_server import MetadataStore, predicate


@pytest.fixture
def store(tmp_path):
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


def decode(store, query):
    body = gzip.decompress(store.snapshot(query))
    magic, rows, total, occupied, identity, size, version, _, _ = struct.unpack_from("<4sIII32sIIII", body)
    assert (magic, rows, identity, size, version) == (b"LCMF", 8, bytes.fromhex("ab" * 32), 1, 1)
    bits = body[64:65]
    counts = [struct.unpack_from("<III", body, 65 + 12 * i) for i in range(occupied)]
    assert sum(c[2] for c in counts) == total
    return [i for i in range(rows) if bits[i >> 3] & (1 << (i & 7))], counts


def test_exact_conjunction_and_unknown_year_semantics(store):
    assert decode(store, {"type": "covers"}) == ([0, 1, 2, 3], [(0, 0, 2), (0, 1, 2)])
    assert decode(store, {"type": "covers", "minYear": 1802, "maxYear": 1803})[0] == [2, 3]
    assert decode(store, {"type": "covers", "minYear": 1802, "includeUnknown": True})[0] == [0, 2, 3]
    assert decode(store, {"book": "000000002", "maxYear": 1805})[0] == [4, 5]
    assert decode(store, {"book": "000000003"}) == ([], [])


@pytest.mark.parametrize("query", [[], None, {"caption": "x"}, {"book": "1 OR 1=1"}, {"type": "unknown"},
                                    {"minYear": True}, {"minYear": -1}, {"maxYear": 9999}, {"includeUnknown": "yes"},
                                    {"minYear": 1900, "maxYear": 1800}])
def test_reject_invalid_queries(query):
    with pytest.raises(ValueError):
        predicate(query)


def test_detail_preserves_subset_local_hf_identity_and_catalog_fallback(store):
    first = store.detail(1)
    assert first["title"] == "A 100% book"
    assert first["links"][0]["url"].endswith("/covers/train?row=1")
    second = store.detail(5)
    assert second["links"][0]["url"].endswith("/plates/train?row=1")
    assert second["provenance"].startswith("Source filename")
    assert first["filter"] == {"book": "000000001"}
    with pytest.raises(ValueError):
        store.detail(99)


def test_book_lookup_is_bounded_and_escapes_wildcards(store):
    assert store.books("100%") == [{"id": "000000001", "title": "A 100% book"}]
    assert store.books("%_") == []
    assert store.books("a") == []
    assert store.books("000000002") == [{"id": "000000002", "title": "000000002"}]


def test_cache_bounded_and_read_only(store):
    first = store.snapshot({"type": "covers"})
    assert store.snapshot({"type": "covers"}) is first
    for year in range(1800, 1820):
        store.snapshot({"minYear": year})
    assert len(store.cache) == 8
    with pytest.raises(sqlite3.OperationalError):
        store.db.execute("DELETE FROM images")
