#!/usr/bin/env python3
"""Static file server for /data/latent-scope-3d. The Vite development server
proxies the frontend's same-origin pack requests here; CORS remains enabled for
direct clients and production arrangements that use a separate data origin.
Same "static files, no backend" pattern as mapviewer's gsv:8800 host.

Two dynamic routes sit alongside the static tree:

    GET /thumbs/monet/<packed_global_idx>.webp
    GET /meta/<points_id>/<row_id>

MONET's thumbnails aren't files — they're byte ranges inside per-HF-shard packed
blobs (`/data2/monet/pool-20m-thumbs256/shards/`), so they can't be symlinked into
the static tree the way BL's per-file thumbs are (`/thumbs/bl` ->
/data/images/british-library-book-images/thumbs). `<packed_global_idx>` is the u32
this project carries per point in `point_index.bin`'s `local_idx`; unpacking it to
`(shard_idx, local_row)` and reading the span is `lsvoxel.monet_thumbs`' job — the
same module the chunk-pack atlas builder reads through, so there is exactly one
implementation of the lookup.

`/meta/<points_id>/<row_id>` answers the lightbox's "where is the full-resolution
original?" with one row of `<root>/points/<points_id>/point_meta.bin` as JSON —
`{"row_id", "url" (null when there is none), "width", "height"}` (0 == unknown).
The per-row table is far too big to ship to the client, and a lightbox opens one
point at a time, so it's a two-`pread` lookup here (`lsvoxel.point_meta`). 404 when
the points id has no `point_meta.bin` or the row is out of range; `<points_id>` is
`[a-z0-9-]+` only and resolves under the served root's `points/`, so the route can
name nothing else.

Everything not matching those routes falls through to plain static file serving,
unchanged.

NOTE: this runs under `/usr/bin/python3` (see its systemd unit), which has NO numpy
or pandas — `lsvoxel.monet_thumbs` and `lsvoxel.point_meta`'s reader are deliberately
stdlib-only so they can be imported here. Don't add a numpy/pandas import to this
file or to those modules.

Run ``python3 data_server.py --help`` for options.
"""
from __future__ import annotations

import argparse
import functools
import json
import os
import re
import sys
import threading
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

try:
    from lsvoxel.monet_thumbs import MonetThumbStore
except Exception as exc:  # noqa: BLE001 — the static server must come up regardless
    MonetThumbStore = None  # type: ignore[assignment]
    _MONET_IMPORT_ERROR: str | None = f"{type(exc).__name__}: {exc}"
else:
    _MONET_IMPORT_ERROR = None

try:
    from lsvoxel.point_meta import PointMetaStore
except Exception as exc:  # noqa: BLE001 — same: one broken route must not take the server down
    PointMetaStore = None  # type: ignore[assignment]
    _META_IMPORT_ERROR: str | None = f"{type(exc).__name__}: {exc}"
else:
    _META_IMPORT_ERROR = None

#: `/thumbs/monet/<packed>.webp`. Anchored and digits-only, so nothing else under
#: /thumbs (BL's static tree included) is affected.
#: Digit runs are bounded (a u32 has 10 digits) so a pathological request can't
#: push `int()` past Python's 4300-digit limit and drop the connection with a
#: traceback — anything longer simply doesn't match and falls through to 404.
MONET_THUMB_ROUTE = re.compile(r"^/thumbs/monet/(\d{1,10})\.webp$")
#: `/meta/<points_id>/<row_id>`. The id charset is the whole path-safety argument:
#: no dots, no slashes, so `points/<id>` can't escape the served root.
POINT_META_ROUTE = re.compile(r"^/meta/([a-z0-9-]+)/(\d{1,10})$")


class CORSRequestHandler(SimpleHTTPRequestHandler):
    def send_head(self):
        """Single byte ranges; never materialize a large file in handler memory."""
        self._range_remaining = None
        requested = self.headers.get("Range")
        path = Path(self.translate_path(self.path))
        # Only non-ranged JSON uses gzip sidecars. Binary offsets always refer
        # to original bytes; even Range+Accept-Encoding:gzip stays identity.
        encodings = {}
        for item in self.headers.get("Accept-Encoding", "").split(","):
            parts = [p.strip().lower() for p in item.split(";")]
            try:
                encodings[parts[0]] = float(next((p[2:] for p in parts[1:] if p.startswith("q=")), "1"))
            except ValueError:
                encodings[parts[0]] = 0
        compressed = path.with_suffix(path.suffix + ".gz")
        self._json_varies = path.suffix == ".json" and path.is_file() and compressed.is_file()
        if not requested and self._json_varies and encodings.get("gzip", encodings.get("*", 0)) > 0:
            source = compressed.open("rb")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Encoding", "gzip")
            self.send_header("Content-Length", str(os.fstat(source.fileno()).st_size))
            self.end_headers()
            return source
        # RFC 9110 §14.2 only defines Range for GET; HEAD describes the full resource.
        if self.command != 'GET' or not requested or not requested.startswith('bytes=') or not path.is_file():
            return super().send_head()
        source = path.open("rb")
        stat = os.fstat(source.fileno())
        size = stat.st_size
        etag = f'"{stat.st_ino:x}-{size:x}-{stat.st_mtime_ns:x}"'
        if self.headers.get("If-Range", etag) != etag:
            source.close()
            return super().send_head()
        match = re.fullmatch(r"bytes=(\d*)-(\d*)", requested)
        try:
            if not match or not any(match.groups()):
                raise ValueError("invalid range")
            left, right = match.groups()
            if left:
                start, end = int(left), min(int(right) if right else size - 1, size - 1)
            else:
                suffix = int(right)
                if suffix <= 0:
                    raise ValueError("empty suffix")
                start, end = max(0, size - suffix), size - 1
            if start > end or start >= size:
                raise ValueError("unsatisfiable")
        except ValueError:
            source.close()
            self.send_response(416)
            self.send_header("Content-Range", f"bytes */{size}")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return None
        source.seek(start)
        self._range_remaining = end - start + 1
        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(str(path)))
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(self._range_remaining))
        self.send_header("ETag", etag)
        self.send_header("Last-Modified", self.date_time_string(stat.st_mtime))
        self.end_headers()
        return source

    def copyfile(self, source, outputfile):
        remaining = getattr(self, "_range_remaining", None)
        if remaining is None:
            return super().copyfile(source, outputfile)
        while remaining:
            block = source.read(min(64 * 1024, remaining))
            if not block:
                break
            outputfile.write(block)
            remaining -= len(block)

    #: Shared across handler threads; MonetThumbStore is internally locked. Set once
    #: in main(), left None if the import above failed.
    monet_store = None
    #: `<root>/points`, set by `configure()`. None disables the /meta route.
    points_root: Path | None = None
    #: points_id -> open PointMetaStore, filled lazily on first request. Stores are
    #: internally locked; this lock only guards the dict itself.
    _meta_stores: dict = {}
    _meta_lock = threading.Lock()

    def do_GET(self):
        path = urlsplit(self.path).path
        match = MONET_THUMB_ROUTE.match(path)
        if match:
            return self._serve_monet_thumb(int(match.group(1)))
        match = POINT_META_ROUTE.match(path)
        if match:
            return self._serve_point_meta(match.group(1), int(match.group(2)))
        return super().do_GET()

    # -- /meta -------------------------------------------------------------

    @classmethod
    def _meta_store_for(cls, points_id: str):
        """The cached store for a points id, opened on first use; None when there is
        no `point_meta.bin` for it (not cached — the file may land later, and the
        miss costs one `stat`).

        Tables get rebuilt in place (tmp + rename), and this process runs for weeks,
        so a cached store is checked against the current inode on every request and
        reopened when a rebuild has replaced the file — one `stat` per request, and no
        service restart needed to pick up a rebuilt table.
        """
        if cls.points_root is None:
            return None
        path = cls.points_root / points_id / "point_meta.bin"
        with cls._meta_lock:
            store = cls._meta_stores.get(points_id)
            if store is not None:
                if store.is_current():
                    return store
                del cls._meta_stores[points_id]
                store.close()
            if not path.is_file():
                return None
            store = PointMetaStore(path)
            cls._meta_stores[points_id] = store
            return store

    def _serve_point_meta(self, points_id: str, row_id: int) -> None:
        if PointMetaStore is None:
            self.send_error(503, f"point meta store unavailable ({_META_IMPORT_ERROR})")
            return
        try:
            store = self._meta_store_for(points_id)
        except (ValueError, OSError) as exc:
            # A file that exists but fails header validation is a build problem, not
            # a missing row: say so rather than 404.
            self.send_error(500, f"point_meta.bin for {points_id!r} unreadable: {exc}")
            return
        if store is None:
            self.send_error(404, f"no point_meta.bin for points id {points_id!r}")
            return
        try:
            record = store.lookup(row_id)
        except IndexError:
            self.send_error(404, f"row_id {row_id} out of range for {points_id!r}")
            return
        except (ValueError, OSError) as exc:
            self.send_error(500, f"point_meta.bin for {points_id!r} unreadable: {exc}")
            return
        body = json.dumps({"row_id": row_id, **record}, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # -- /thumbs/monet -----------------------------------------------------

    def _serve_monet_thumb(self, packed: int) -> None:
        store = type(self).monet_store
        if store is None:
            self.send_error(503, f"monet thumbnail store unavailable ({_MONET_IMPORT_ERROR})")
            return
        try:
            data = store.read_packed(packed)
        except (ValueError, IndexError, OSError):
            # Out-of-range ref, or a shard file that vanished/short-read mid-request:
            # for a thumbnail endpoint these are all "no image here".
            data = b""
        if not data:
            # Shard not pulled yet, or a decode-failed row (zero-length span).
            self.send_error(404, "thumbnail not available")
            return
        self.send_response(200)
        self.send_header("Content-Type", "image/webp")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def end_headers(self):
        if getattr(self, "_json_varies", False):
            self.send_header("Vary", "Accept-Encoding")
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Access-Control-Expose-Headers", "Content-Range, Content-Length, ETag, Accept-Ranges")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, format, *args):
        pass  # keep the service log quiet; systemd journal still has stderr on crash


def configure(root: str) -> None:
    """Wire the dynamic routes to `root` (the static tree's root). Split out of
    `main()` so a test can stand the same handler up on a temp root."""
    if MonetThumbStore is not None:
        CORSRequestHandler.monet_store = MonetThumbStore()
    else:
        print(f"WARNING: /thumbs/monet route disabled ({_MONET_IMPORT_ERROR})", flush=True)
    if PointMetaStore is not None:
        CORSRequestHandler.points_root = Path(root) / "points"
    else:
        print(f"WARNING: /meta route disabled ({_META_IMPORT_ERROR})", flush=True)


def _port(value: str) -> int:
    port = int(value)
    if not 1 <= port <= 65535:
        raise argparse.ArgumentTypeError("port must be between 1 and 65535")
    return port


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Serve latent-scope-3d packs, metadata, and MONET thumbnails.",
        epilog=(
            "Positional order remains compatible with the original script: "
            "data_server.py [port] [root]."
        ),
    )
    parser.add_argument("port", nargs="?", type=_port, default=8802, help="TCP port (default: 8802)")
    parser.add_argument(
        "root",
        nargs="?",
        default="/data/latent-scope-3d",
        help="static data root (default: /data/latent-scope-3d)",
    )
    parser.add_argument("--bind", default="0.0.0.0", help="listen address (default: 0.0.0.0)")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    configure(args.root)
    handler = functools.partial(CORSRequestHandler, directory=args.root)
    httpd = ThreadingHTTPServer((args.bind, args.port), handler)
    print(f"serving {args.root} on {args.bind}:{args.port} (CORS enabled)", flush=True)
    httpd.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
