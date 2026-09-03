#!/usr/bin/env python3
"""Static file server for /data/latent-scope-3d, with CORS enabled so the frontend
(served from a different port by Vite) can fetch chunk manifests/atlases/meta.bin
directly. Same "static files, no backend" pattern as mapviewer's gsv:8800 host.

One dynamic route sits alongside the static tree:

    GET /thumbs/monet/<packed_global_idx>.webp

MONET's thumbnails aren't files — they're byte ranges inside per-HF-shard packed
blobs (`/data2/monet/pool-20m-thumbs256/shards/`), so they can't be symlinked into
the static tree the way BL's per-file thumbs are (`/thumbs/bl` ->
/data/images/british-library-book-images/thumbs). `<packed_global_idx>` is the u32
this project carries per point in `point_index.bin`'s `local_idx`; unpacking it to
`(shard_idx, local_row)` and reading the span is `lsvoxel.monet_thumbs`' job — the
same module the chunk-pack atlas builder reads through, so there is exactly one
implementation of the lookup.

Everything not matching that route falls through to plain static file serving,
unchanged.

NOTE: this runs under `/usr/bin/python3` (see its systemd unit), which has NO numpy
or pandas — `lsvoxel.monet_thumbs` is deliberately stdlib-only so it can be imported
here. Don't add a numpy/pandas import to this file or to that module.

Usage: python3 data_server.py [port] [root]
"""
from __future__ import annotations

import functools
import re
import sys
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

#: `/thumbs/monet/<packed>.webp`. Anchored and digits-only, so nothing else under
#: /thumbs (BL's static tree included) is affected.
MONET_THUMB_ROUTE = re.compile(r"^/thumbs/monet/(\d+)\.webp$")


class CORSRequestHandler(SimpleHTTPRequestHandler):
    #: Shared across handler threads; MonetThumbStore is internally locked. Set once
    #: in main(), left None if the import above failed.
    monet_store = None

    def do_GET(self):
        match = MONET_THUMB_ROUTE.match(urlsplit(self.path).path)
        if match:
            return self._serve_monet_thumb(int(match.group(1)))
        return super().do_GET()

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


def main() -> int:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8802
    root = sys.argv[2] if len(sys.argv) > 2 else "/data/latent-scope-3d"
    if MonetThumbStore is not None:
        CORSRequestHandler.monet_store = MonetThumbStore()
    else:
        print(f"WARNING: /thumbs/monet route disabled ({_MONET_IMPORT_ERROR})", flush=True)
    handler = functools.partial(CORSRequestHandler, directory=root)
    httpd = ThreadingHTTPServer(("0.0.0.0", port), handler)
    print(f"serving {root} on 0.0.0.0:{port} (CORS enabled)", flush=True)
    httpd.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
