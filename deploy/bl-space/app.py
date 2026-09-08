"""Public BL demo: static UI is available while the CPU search worker warms.

No credentials, user-selected URLs, arbitrary datasets, or unbounded searches.
Normal thumbnails travel browser → GCS; the thumbnail endpoint only supports
permanent exported URLs and fallback for a failed client-side range request.
"""
from __future__ import annotations
from collections import OrderedDict
from contextlib import asynccontextmanager
from concurrent.futures import ThreadPoolExecutor
import asyncio
import hashlib
import json
import os
from pathlib import Path
import re
import struct
import threading
import time
import urllib.request

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

ROOT = Path(os.environ.get("LC_SEARCH_ROOT", "/tmp/latent-craft-search"))
STATIC = Path(os.environ.get("LC_STATIC_ROOT", "/app/static"))
ASSET_ORIGIN = "https://storage.googleapis.com/fun-data/latent-craft/bl/20260907a"
HERE = Path(__file__).resolve().parent
STATE = {"state": "starting", "detail": "Preparing SigLIP search; the map is already available."}
service = None
metadata = None
METADATA_STATE = "starting"


def fetch_file(url, target, size, digest):
    if target.exists() and target.stat().st_size == size:
        with target.open("rb") as f:
            if hashlib.file_digest(f, "sha256").hexdigest() == digest: return
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(target.name + ".download")
    with urllib.request.urlopen(url, timeout=120) as response, temporary.open("wb") as stream:
        h = hashlib.sha256(); written = 0
        while block := response.read(1024 * 1024):
            written += len(block)
            if written > size: raise ValueError("Oversized deployment artifact")
            h.update(block); stream.write(block)
    if written != size or h.hexdigest() != digest: raise ValueError("Deployment artifact checksum mismatch")
    temporary.replace(target)


class BLService:
    def __init__(self, root):
        import faiss
        import numpy as np
        import torch
        from transformers import AutoTokenizer, Siglip2TextModel
        torch.set_num_threads(2)
        faiss.omp_set_num_threads(2)
        self.faiss = faiss
        self.np, self.torch = np, torch
        self.encoder = Siglip2TextModel.from_pretrained(root / "text-model", local_files_only=True).eval()
        self.tokenizer = AutoTokenizer.from_pretrained(root / "text-model", local_files_only=True)
        self.config = json.loads((root / "service.json").read_text())
        self.flat = faiss.read_index(str(root / "faiss-sq8.index"), faiss.IO_FLAG_MMAP | faiss.IO_FLAG_READ_ONLY)
        if self.flat.ntotal != 1080814 or self.flat.d != 1152: raise ValueError("FAISS identity mismatch")
        self.points = np.memmap(root / "point_index.bin", mode="r", dtype=np.dtype([("subset", "u1"), ("pad", "u1"), ("thumb", "<u4"), ("pad2", "<u2")]))
        self.voxels = np.memmap(root / "row_to_voxel.bin", mode="r", dtype=np.dtype([("chunk", "<u4"), ("local", "<u2"), ("pad", "<u2")]))
        if len(self.points) != 1080814 or len(self.voxels) != 1080814: raise ValueError("Map identity length mismatch")
        self.query_cache = OrderedDict()
        self.lock = threading.Lock()
        # Verify the text-only export matches the exact benchmark query space.
        expected = np.load(root / "text-check.npy")
        actual = self.embed("a map of London")
        if not np.allclose(expected, actual, atol=1e-5): raise ValueError("Text encoder differs from benchmark")

    def embed(self, query):
        with self.torch.inference_mode():
            output = self.encoder(**self.tokenizer(query, padding="max_length", truncation=True, max_length=64, return_tensors="pt")).pooler_output
            return self.torch.nn.functional.normalize(output, dim=-1).numpy()[0]

    def search(self, query, backend):
        if backend != "faiss": raise HTTPException(422, "Only FAISS SQ8 is served by this demo")
        if not self.lock.acquire(blocking=False): raise HTTPException(429, "Search is busy; please try again in a moment.")
        try:
            start = time.perf_counter(); cached = query in self.query_cache
            if cached: vector = self.query_cache.pop(query)
            else: vector = self.embed(query)
            self.query_cache[query] = vector
            while len(self.query_cache) > 128: self.query_cache.popitem(last=False)
            embed_ms = 1000*(time.perf_counter()-start)
            config = self.config["backends"][backend]
            start = time.perf_counter()
            self.faiss.omp_set_num_threads(2)
            self.flat.nprobe = config["nprobes"]
            scores, ids = self.flat.search(vector[None, :], 24)
            matches = [{"row_id": int(row), "_distance": float(1-score)} for row, score in zip(ids[0], scores[0]) if row >= 0]
            search_ms = 1000*(time.perf_counter()-start)
            results = []
            subsets = ["covers", "medium", "embellishments", "plates"]
            for hit in matches:
                row = int(hit["row_id"])
                if not 0 <= row < len(self.points): raise ValueError("Index returned invalid row")
                point, voxel = self.points[row], self.voxels[row]
                subset, thumb = subsets[int(point["subset"])], int(point["thumb"])
                results.append(dict(row=row, chunk=int(voxel["chunk"]), local=int(voxel["local"]), thumb=thumb,
                    score=float(1-hit["_distance"]), model="SigLIP 2", thumbUrl=f"/thumbs/bl/{subset}/{thumb:08d}.webp"))
            return dict(dataset="bl-160", release="bl-20260907a", query=query, results=results, backend=backend, embed_ms=embed_ms, search_ms=search_ms, embedding_cached=cached)
        finally: self.lock.release()


def warm():
    global service
    try:
        if (HERE / "assets.json").exists():
            manifest = json.loads((HERE / "assets.json").read_text())
            STATE.update(state="downloading", detail="Downloading verified search artifacts; map and thumbnails remain available.")
            def download(item):
                path = Path(item["path"])
                if path.is_absolute() or ".." in path.parts: raise ValueError("Invalid artifact path")
                fetch_file(f'{manifest["base_url"]}/{path.as_posix()}', ROOT / path, item["bytes"], item["sha256"])
            with ThreadPoolExecutor(max_workers=4) as pool: list(pool.map(download, manifest["files"]))
        STATE.update(state="loading", detail="Loading the SigLIP text encoder and bounded search caches.")
        service = BLService(ROOT)
        STATE.update(state="ready", detail="SigLIP search is ready.")
    except Exception as error:
        STATE.update(state="failed", detail="Search could not start. The map is still available.")
        print(f"Search startup failed: {type(error).__name__}: {error}", flush=True)


class MetadataWorker:
    """Own SQLite on a single thread. Reject concurrent work instead of queuing.

    Cancellation keeps the admission lock until the underlying work completes;
    disconnected clients cannot accidentally build an unbounded executor queue.
    """
    def __init__(self, path, identity, rows):
        from metadata_server import MetadataStore
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="metadata")
        self.lock = threading.Lock()
        def initialize():
            self.store = MetadataStore(path)
            if self.store.info["identity"] != identity or self.store.info["rows"] != rows:
                self.store.db.close()
                raise ValueError("Metadata belongs to another map")
        try:
            self.executor.submit(initialize).result()
        except Exception:
            self.executor.shutdown(wait=True)
            raise

    async def call(self, method, *args):
        if not self.lock.acquire(blocking=False):
            raise HTTPException(429, "Metadata is busy; please try again.")
        future = asyncio.get_running_loop().run_in_executor(self.executor, getattr(self.store, method), *args)
        future.add_done_callback(lambda _future: self.lock.release())
        try:
            return await asyncio.shield(future)
        except (ValueError, TypeError) as error:
            raise HTTPException(400, str(error)) from error

    def close(self):
        self.executor.submit(self.store.db.close).result()
        self.executor.shutdown(wait=True)


def warm_metadata():
    global metadata, METADATA_STATE
    try:
        manifest = json.loads((HERE / "metadata.json").read_text())
        path = Path(os.environ.get("LC_METADATA_PATH", str(ROOT / "metadata.sqlite")))
        METADATA_STATE = "downloading"
        fetch_file(manifest["url"], path, manifest["bytes"], manifest["sha256"])
        metadata = MetadataWorker(path, manifest["identity"], manifest["rows"])
        METADATA_STATE = "ready"
    except Exception as error:
        METADATA_STATE = "failed"
        print(f"Metadata startup failed: {type(error).__name__}: {error}", flush=True)


@asynccontextmanager
async def lifespan(app):
    threading.Thread(target=warm, daemon=True).start()
    threading.Thread(target=warm_metadata, daemon=True).start()
    yield
    if metadata is not None: metadata.close()


app = FastAPI(lifespan=lifespan)


@app.middleware("http")
async def limits(request, call_next):
    if request.method == "POST":
        length = request.headers.get("content-length")
        bound = 2048 if request.url.path.startswith("/api/metadata/") else 4096
        if not length or not length.isdigit() or int(length) > bound: return Response(status_code=413)
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    return response


class SearchRequest(BaseModel):
    query: str = Field(min_length=1, max_length=400)
    backend: str = Field(default="faiss", pattern="^faiss$")


@app.get("/api/bl/status")
def status():
    memory = {}
    for line in Path("/proc/self/status").read_text().splitlines():
        if line.startswith(("VmRSS:", "VmHWM:")):
            key, value, _unit = line.split(); memory[key.rstrip(":")] = int(value) * 1024
    return {**STATE, "metadata_state": METADATA_STATE, "memory_bytes": memory, "search_threads": 2,
            "index_storage": "FAISS SQ8; memory-mapped inverted lists", "metadata_sqlite_cache_bytes": 16*1024**2}


@app.post("/api/bl/search")
def search(body: SearchRequest):
    if service is None: raise HTTPException(503, STATE["detail"])
    query = body.query.strip()
    if not query: raise HTTPException(422, "Enter a search phrase")
    return service.search(query, body.backend)


async def metadata_call(method, *args):
    if metadata is None: raise HTTPException(503, "Book metadata is warming; the map remains available.")
    return await metadata.call(method, *args)


@app.get("/api/metadata/bl-20260907a/schema")
async def metadata_schema():
    return await metadata_call("schema")


@app.get("/api/metadata/bl-20260907a/rows/{row}")
async def metadata_detail(row: int):
    if not 0 <= row < 1080814: raise HTTPException(404, "Unknown image row")
    return await metadata_call("detail", row)


@app.get("/api/metadata/bl-20260907a/books")
async def metadata_books(q: str = Query(default="", max_length=120)):
    return await metadata_call("books", q)


@app.post("/api/metadata/bl-20260907a/filter")
async def metadata_filter(body: dict):
    payload = await metadata_call("snapshot", body)
    return Response(payload, media_type="application/octet-stream",
                    headers={"Content-Encoding": "gzip", "Cache-Control": "no-store"})


thumb_lock = threading.BoundedSemaphore(8)


@app.get("/thumbs/bl/{subset}/{filename}")
def thumbnail(subset: str, filename: str):
    if subset not in ("covers", "medium", "embellishments", "plates") or not re.fullmatch(r"\d{8}\.webp", filename): raise HTTPException(404)
    if not thumb_lock.acquire(blocking=False): raise HTTPException(429)
    try:
        manifest = json.loads((HERE / "thumbs/manifest.json").read_text())
        index = int(filename[:-5]); data = manifest["subsets"][subset]
        if index >= data["count"]: raise HTTPException(404)
        with (HERE / "thumbs" / subset / "offsets.bin").open("rb") as stream:
            stream.seek(index*8); offset, length = struct.unpack("<II", stream.read(8))
        shard = index // manifest["shard_rows"]
        url = f"{ASSET_ORIGIN}/thumbs/bl/{subset}/{shard:05d}.blob"
        request = urllib.request.Request(url, headers={"Range": f"bytes={offset}-{offset+length-1}"})
        with urllib.request.urlopen(request, timeout=15) as response:
            if response.status != 206 or response.headers.get("Content-Range") != f"bytes {offset}-{offset+length-1}/{data['sizes'][shard]}": raise HTTPException(502)
            payload = response.read(length+1)
            if len(payload) != length: raise HTTPException(502)
        return Response(payload, media_type="image/webp", headers={"Cache-Control": "public,max-age=86400"})
    finally: thumb_lock.release()


if STATIC.exists(): app.mount("/", StaticFiles(directory=STATIC, html=True), name="ui")
