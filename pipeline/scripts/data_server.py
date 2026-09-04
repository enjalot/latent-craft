#!/usr/bin/env python3
"""Static file server for /data/latent-scope-3d, with CORS enabled so the frontend
(served from a different port by Vite) can fetch chunk manifests/atlases/meta.bin
directly. Same "static files, no backend" pattern as mapviewer's gsv:8800 host.

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

Usage: python3 data_server.py [port] [root]
"""
from __future__ import annotations

import functools
import json
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


def main() -> int:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8802
    root = sys.argv[2] if len(sys.argv) > 2 else "/data/latent-scope-3d"
    configure(root)
    handler = functools.partial(CORSRequestHandler, directory=root)
    httpd = ThreadingHTTPServer(("0.0.0.0", port), handler)
    print(f"serving {root} on 0.0.0.0:{port} (CORS enabled)", flush=True)
    httpd.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
