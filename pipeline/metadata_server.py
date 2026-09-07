"""Optional local metadata API. Static imagery remains byte-range streamed.

SQLite is opened read-only, requests are serialized and bounded, and no ML
runtime is imported. Filter snapshots use a stateless predicate (no expiring
server session). A deployment may route /api/metadata here independently.
"""
import argparse
import gzip
import json
import re
import sqlite3
import struct
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, quote, urlsplit

TYPES = ("covers", "medium", "embellishments", "plates")


def predicate(value):
    if not isinstance(value, dict) or set(value) - {"type", "minYear", "maxYear", "includeUnknown", "book"}:
        raise ValueError("Invalid filter fields")
    clauses, params = [], []
    if value.get("type"):
        if value["type"] not in TYPES:
            raise ValueError("Invalid image type")
        clauses.append("subset = ?"); params.append(value["type"])
    for key, op in (("minYear", ">="), ("maxYear", "<=")):
        if value.get(key) is not None:
            year = value[key]
            if type(year) is not int or not 0 <= year <= 2100:
                raise ValueError("Invalid recorded year")
            clauses.append(f"(year {op} ?" + (" OR year IS NULL)" if value.get("includeUnknown", False) else ")"))
            params.append(year)
    if value.get("minYear") is not None and value.get("maxYear") is not None and value["minYear"] > value["maxYear"]:
        raise ValueError("Start year must not exceed end year")
    if "includeUnknown" in value and type(value["includeUnknown"]) is not bool:
        raise ValueError("Invalid unknown-year choice")
    if value.get("book"):
        if not isinstance(value["book"], str) or not re.fullmatch(r"\d{9}", value["book"]):
            raise ValueError("Book ID must have nine digits")
        clauses.append("book = ?"); params.append(value["book"])
    return " AND ".join(clauses) or "1", params


class MetadataStore:
    def __init__(self, path):
        self.db = sqlite3.connect(f"file:{quote(str(path))}?mode=ro", uri=True)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA cache_size = -16384")
        self.info = {r[0]: json.loads(r[1]) for r in self.db.execute("SELECT * FROM info")}
        self.cache = OrderedDict()

    def schema(self):
        bounds = self.db.execute("SELECT min(year), max(year) FROM images").fetchone()
        return {**self.info, "fields": [
            {"key": "type", "label": "Image type", "kind": "category", "options": list(TYPES)},
            {"key": "year", "label": "Recorded publication year", "kind": "range", "min": bounds[0], "max": bounds[1]},
            {"key": "book", "label": "Book title or ID", "kind": "lookup"}],
            "note": "Minimap shows the full collection. Search filters the 24 retrieved candidates, not the entire ANN index."}

    def detail(self, row):
        record = self.db.execute("SELECT i.*, b.title, b.author, b.publisher, b.place, b.ark FROM images i LEFT JOIN books b ON i.book=b.id WHERE row_id=?", (row,)).fetchone()
        if record is None:
            raise ValueError("Unknown image row")
        r = dict(record)
        title = r["title"] or r["fname"]
        fields = [("Book ID", r["book"]), ("Author", r["author"]), ("Publication year (recorded)", r["year"]),
                  ("Publisher", r["publisher"]), ("Place", r["place"]), ("Volume", r["volume"]), ("Page", r["page"]), ("Image type", r["subset"])]
        url = f'https://huggingface.co/datasets/biglam/british-library-book-images/viewer/{r["subset"]}/train?row={r["local_idx"]}'
        links = [{"label": "Hugging Face source row ↗", "url": url}]
        if r["flickr"]:
            links.append({"label": "British Library on Flickr ↗", "url": r["flickr"]})
        return {"row": row, "identity": self.info["identity"], "title": title,
                "provenance": "Catalog title" if r["title"] else "Source filename · catalog title unavailable",
                "fields": [{"label": k, "value": str(v)} for k, v in fields if v is not None and v != ""],
                "links": links, "filter": {"book": r["book"]}}

    def books(self, query):
        query = query.strip()
        if not 2 <= len(query) <= 120:
            return []
        if re.fullmatch(r"\d{9}", query):
            rows = self.db.execute("SELECT DISTINCT i.book id, COALESCE(b.title,i.book) title FROM images i LEFT JOIN books b ON i.book=b.id WHERE i.book=? LIMIT 20", (query,))
        else:
            escaped = query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            rows = self.db.execute("SELECT id,title FROM books b WHERE title LIKE ? ESCAPE '\\' AND EXISTS (SELECT 1 FROM images i WHERE i.book=b.id) ORDER BY title LIMIT 20", (f"%{escaped}%",))
        return [dict(row) for row in rows]

    def snapshot(self, value):
        where, params = predicate(value)
        key = (where, tuple(params))
        if key in self.cache:
            self.cache.move_to_end(key)
            return self.cache[key]
        bits = bytearray((self.info["rows"] + 7) // 8)
        counts = {}
        total = 0
        for row, chunk, voxel in self.db.execute(f"SELECT row_id,chunk,voxel FROM images WHERE {where}", params):
            bits[row >> 3] |= 1 << (row & 7)
            counts[(chunk, voxel)] = counts.get((chunk, voxel), 0) + 1
            total += 1
        # 64-byte header: magic, rows, matching rows, occupied voxels, SHA-256,
        # mask byte length, version, reserved. Sparse records: chunk/local/count.
        header = struct.pack("<4sIII32sIIII", b"LCMF", self.info["rows"], total, len(counts), bytes.fromhex(self.info["identity"]), len(bits), 1, 0, 0)
        body = header + bits + b"".join(struct.pack("<III", chunk, voxel, count) for (chunk, voxel), count in sorted(counts.items()))
        result = gzip.compress(body, mtime=0)
        self.cache[key] = result
        while len(self.cache) > 8:
            self.cache.popitem(last=False)
        return result


def handler(store):
    class Handler(BaseHTTPRequestHandler):
        def setup(self):
            super().setup()
            self.connection.settimeout(10)

        def reply(self, status, body, compressed=False):
            payload = body if compressed else json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/octet-stream" if compressed else "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            if compressed:
                self.send_header("Content-Encoding", "gzip")
            self.end_headers()
            self.wfile.write(payload)

        def do_GET(self):
            path = urlsplit(self.path)
            prefix = "/api/metadata/bl-20260907a"
            try:
                if path.path == prefix + "/schema":
                    return self.reply(200, store.schema())
                if path.path == prefix + "/books":
                    return self.reply(200, store.books(parse_qs(path.query).get("q", [""])[0]))
                match = re.fullmatch(re.escape(prefix) + r"/rows/(\d{1,10})", path.path)
                if match:
                    return self.reply(200, store.detail(int(match[1])))
                self.reply(404, {"error": "Not found"})
            except ValueError as error:
                self.reply(400, {"error": str(error)})

        def do_POST(self):
            if self.path != "/api/metadata/bl-20260907a/filter":
                return self.reply(404, {"error": "Not found"})
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= 2048:
                    raise ValueError("Invalid request size")
                value = json.loads(self.rfile.read(length))
                self.reply(200, store.snapshot(value), compressed=True)
            except (ValueError, TypeError) as error:
                self.reply(400, {"error": str(error)})
    return Handler


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", required=True)
    parser.add_argument("--port", type=int, default=8805)
    args = parser.parse_args()
    HTTPServer(("127.0.0.1", args.port), handler(MetadataStore(args.db))).serve_forever()
