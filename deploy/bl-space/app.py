"""Public BL demo: static UI is available while the CPU search worker warms.

No credentials, user-selected URLs, arbitrary datasets, or unbounded searches.
Normal thumbnails travel browser → GCS; the thumbnail endpoint only supports
permanent exported URLs and fallback for a failed client-side range request.
"""
from __future__ import annotations
from collections import OrderedDict
from contextlib import asynccontextmanager
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
from pathlib import Path
import re
import struct
import threading
import time
import urllib.request

from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

ROOT = Path(os.environ.get("LC_SEARCH_ROOT", "/tmp/latent-craft-search"))
STATIC = Path(os.environ.get("LC_STATIC_ROOT", "/app/static"))
ASSET_ORIGIN = "https://storage.googleapis.com/fun-data/latent-craft/bl/20260907a"
HERE = Path(__file__).resolve().parent
STATE = {"state": "starting", "detail": "Preparing SigLIP search; the map is already available."}
service = None


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
        import lancedb
        import numpy as np
        import torch
        from transformers import AutoTokenizer, Siglip2TextModel
        torch.set_num_threads(2)
        faiss.omp_set_num_threads(2)
        self.faiss = faiss
        self.np, self.torch = np, torch
        self.encoder = Siglip2TextModel.from_pretrained(root / "text-model", local_files_only=True).eval()
        self.tokenizer = AutoTokenizer.from_pretrained(root / "text-model", local_files_only=True)
        self.session = lancedb.Session(index_cache_size_bytes=512*1024**2, metadata_cache_size_bytes=32*1024**2)
        self.db = lancedb.connect(root / "lance", session=self.session)
        self.config = json.loads((root / "service.json").read_text())
        self.tables = {key: self.db.open_table(value["table"]) for key, value in self.config["backends"].items() if "table" in value}
        for table in self.tables.values():
            if table.count_rows() != 1080814: raise ValueError("Index row count mismatch")
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
            if backend == "faiss":
                self.faiss.omp_set_num_threads(2)
                self.flat.nprobe = config["nprobes"]
                scores, ids = self.flat.search(vector[None, :], 24)
                matches = [{"row_id": int(row), "_distance": float(1-score)} for row, score in zip(ids[0], scores[0]) if row >= 0]
            else:
                q = self.tables[backend].search(vector).metric(config.get("metric", "cosine")).nprobes(config["nprobes"]).limit(24).select(["row_id", "_distance"])
                if config.get("refine"): q = q.refine_factor(config["refine"])
                matches = q.to_list()
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


@asynccontextmanager
async def lifespan(app):
    threading.Thread(target=warm, daemon=True).start()
    yield


app = FastAPI(lifespan=lifespan)


@app.middleware("http")
async def limits(request, call_next):
    if request.method == "POST":
        length = request.headers.get("content-length")
        if not length or not length.isdigit() or int(length) > 4096: return Response(status_code=413)
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    return response


class SearchRequest(BaseModel):
    query: str = Field(min_length=1, max_length=400)
    backend: str = Field(default="faiss", pattern="^(sq8|faiss)$")


@app.get("/api/bl/status")
def status():
    memory = {}
    for line in Path("/proc/self/status").read_text().splitlines():
        if line.startswith(("VmRSS:", "VmHWM:")):
            key, value, _unit = line.split(); memory[key.rstrip(":")] = int(value) * 1024
    return {**STATE, "memory_bytes": memory, "search_threads": 2, "index_cache_bytes": 512*1024**2}


@app.post("/api/bl/search")
def search(body: SearchRequest):
    if service is None: raise HTTPException(503, STATE["detail"])
    query = body.query.strip()
    if not query: raise HTTPException(422, "Enter a search phrase")
    return service.search(query, body.backend)


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
