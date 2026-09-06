#!/usr/bin/env python3
"""Local-only comparison API. Run with the latent-basemap inference venv."""
import argparse
import json
import os
from pathlib import Path
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

os.environ.setdefault("OMP_NUM_THREADS", "2")
os.environ.setdefault("OPENBLAS_NUM_THREADS", "2")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from lsvoxel.search_compare import CompareService, validate_query


class Handler(BaseHTTPRequestHandler):
    service = None
    slots = threading.BoundedSemaphore(2)

    def reply(self, status, body):
        data = json.dumps(body, allow_nan=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_GET(self):
        if self.path == "/api/explore/status":
            self.reply(200, self.service.status())
        else:
            self.reply(404, {"error": "Not found"})

    def do_POST(self):
        if self.path != "/api/explore/query":
            return self.reply(404, {"error": "Not found"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 8192:
                return self.reply(413, {"error": "Request too large or empty"})
            self.connection.settimeout(5)
            query, mode = validate_query(json.loads(self.rfile.read(length)))
        except (ValueError, UnicodeError, TimeoutError):
            return self.reply(400, {"error": "Invalid query, mode, dataset or release"})
        if not self.slots.acquire(blocking=False):
            return self.reply(429, {"error": "Search service busy; try again"})
        try:
            result = self.service.query(query, mode)
            if result is None:
                return self.reply(503, {"error": "Index is preparing", "resources": self.service.status()})
            self.reply(200, result)
        except Exception as error:
            print(f"Query failed: {type(error).__name__}: {error}", file=sys.stderr, flush=True)
            self.reply(500, {"error": "Local inference failed; see server log"})
        finally:
            self.slots.release()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8803)
    parser.add_argument("--data-root", type=Path, default=Path("/data/latent-scope-3d"))
    parser.add_argument("--research-root", type=Path, default=Path("/data/latent-basemap/sandbox"))
    parser.add_argument("--basemap-repo", type=Path, default=Path(__file__).resolve().parents[3] / "latent-basemap")
    parser.add_argument("--training-root", type=Path, default=Path("/data2/monet/random-2m"))
    parser.add_argument("--pool-root", type=Path, default=Path("/data2/monet/pool-20m"))
    parser.add_argument("--model-cache", type=Path, default=Path("/data/hf/hub/models--openai--clip-vit-base-patch32/snapshots/3d74acf9a28c67741b2f4f2ea7635f0aaf6f0268"))
    args = parser.parse_args()
    Handler.service = CompareService(args.data_root, args.research_root, args.basemap_repo,
        args.training_root, args.pool_root, args.model_cache)
    print(json.dumps({"ready": True, **Handler.service.status()}), flush=True)
    with ThreadingHTTPServer(("127.0.0.1", args.port), Handler) as server:
        server.serve_forever()


if __name__ == "__main__":
    main()
