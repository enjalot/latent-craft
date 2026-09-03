#!/usr/bin/env python3
"""Static file server for /data/latent-scope-3d, with CORS enabled so the frontend
(served from a different port by Vite) can fetch chunk manifests/atlases/meta.bin
directly. Same "static files, no backend" pattern as mapviewer's gsv:8800 host.

Usage: python3 data_server.py [port] [root]
"""
from __future__ import annotations

import functools
import sys
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler


class CORSRequestHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, format, *args):
        pass  # keep the service log quiet; systemd journal still has stderr on crash


def main() -> int:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8802
    root = sys.argv[2] if len(sys.argv) > 2 else "/data/latent-scope-3d"
    handler = functools.partial(CORSRequestHandler, directory=root)
    httpd = ThreadingHTTPServer(("0.0.0.0", port), handler)
    print(f"serving {root} on 0.0.0.0:{port} (CORS enabled)", flush=True)
    httpd.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
