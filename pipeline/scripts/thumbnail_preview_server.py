#!/usr/bin/env python3
"""Local 128px preview only. No writes to original images and no URL fetching."""
import argparse
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import re
import sys
import threading
from urllib.parse import urlsplit, parse_qs

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from lsvoxel.monet_thumbs import MonetThumbStore
from lsvoxel.thumbnail_quality import resize_thumbnail

MONET = re.compile(r"/api/thumb-preview/monet/(\d{1,10})\.webp")
BL = re.compile(r"/api/thumb-preview/bl/(covers|medium|embellishments|plates)/(\d{8})\.webp")


class PreviewHandler(BaseHTTPRequestHandler):
    store = None
    bl_root = Path("/data/images/british-library-book-images/thumbs")
    cache = OrderedDict()
    lock = threading.Lock()
    slots = threading.BoundedSemaphore(4)

    def do_GET(self):
        route = urlsplit(self.path)
        monet, bl = MONET.fullmatch(route.path), BL.fullmatch(route.path)
        if not (monet or bl) or parse_qs(route.query) != {"size": ["128"]}:
            self.send_error(404); return
        # Limits both encoding and pending response bytes. Never recompute the corpus.
        if not self.slots.acquire(timeout=5): self.send_error(503, "Preview encoder busy"); return
        try:
            with self.lock:
                data = self.cache.get(route.path)
                if data: self.cache.move_to_end(route.path)
            if data is None:
                original = self.store.read_packed(int(monet[1])) if monet else (self.bl_root / bl[1] / f"{bl[2]}.webp").read_bytes()
                if not original: self.send_error(404); return
                data = resize_thumbnail(original)
                with self.lock:
                    self.cache[route.path] = data
                    while len(self.cache) > 512: self.cache.popitem(last=False)
            self.send_response(200)
            self.send_header("Content-Type", "image/webp")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "public, max-age=3600")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers(); self.wfile.write(data)
        except (ValueError, IndexError, OSError):
            self.send_error(404, "Thumbnail unavailable")
        finally: self.slots.release()

    def log_message(self, *_args): pass


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8808)
    args = parser.parse_args()
    PreviewHandler.store = MonetThumbStore()
    print(f"Thumbnail preview: http://127.0.0.1:{args.port}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", args.port), PreviewHandler).serve_forever()
