"""Bounded CPU text search over the full, disk-mapped MONET IVF/PQ index.

The browser streams map/thumbnail bytes from object storage. ANN IDs are joined
to this exact 4M-trained map release through a verified, one-to-one u32 table.
No user-supplied paths, model choices, URLs, or unbounded request queues.
"""
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
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

HERE = Path(__file__).resolve().parent
ROOT = Path(os.environ.get("LC_SEARCH_ROOT", "/tmp/latent-craft-monet-search"))
STATIC = Path(os.environ.get("LC_STATIC_ROOT", "/app/static"))
THUMBS_ORIGIN = os.environ.get("LC_MONET_THUMBS_ORIGIN", "https://storage.googleapis.com/fun-data/latent-craft/monet/thumbs/full-20260908b")
STATE = {"state": "starting", "detail": "Preparing CLIP search; explore the map meanwhile."}
service = None


def fetch_file(url, target, size, digest):
    if target.exists() and target.stat().st_size == size:
        with target.open("rb") as stream:
            if hashlib.file_digest(stream, "sha256").hexdigest() == digest: return
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(target.name + ".download")
    with urllib.request.urlopen(url, timeout=120) as response, temporary.open("wb") as stream:
        h = hashlib.sha256(); written = 0
        while block := response.read(1024*1024):
            written += len(block)
            if written > size: raise ValueError("Oversized deployment artifact")
            h.update(block); stream.write(block)
    if written != size or h.hexdigest() != digest: raise ValueError("Deployment artifact checksum mismatch")
    temporary.replace(target)


class MonetService:
    def __init__(self, root):
        import faiss
        import numpy as np
        import torch
        from transformers import CLIPTextModelWithProjection, CLIPTokenizerFast
        torch.set_num_threads(2); faiss.omp_set_num_threads(2)
        self.faiss, self.np, self.torch = faiss, np, torch
        self.config = json.loads((root / "service.json").read_text())
        c = self.config
        if (c["dataset"], c["release"], c["rows"], c["identity"], c["unresolved_ann_ids"]) != (
            "monet-clip-basemap-full-4m-512", "monet-clip-basemap-full-4m-20260906a", 103816750,
            "ca437bba419cc933455eefbf2af0b797657addce8b2d886db574e7f8f94d6c5f", 0):
            raise ValueError("Search artifacts belong to another map")
        self.index = faiss.read_index(str(root / "clip-ivfpq.index"), faiss.IO_FLAG_MMAP | faiss.IO_FLAG_READ_ONLY)
        if (self.index.ntotal, self.index.d, self.index.nlist, self.index.pq.M, self.index.pq.nbits, self.index.metric_type) != (
            c["rows"], 512, 4096, 64, 8, faiss.METRIC_INNER_PRODUCT): raise ValueError("Unexpected FAISS index")
        if type(faiss.downcast_InvertedLists(self.index.invlists)).__name__ != "OnDiskInvertedLists":
            raise ValueError("FAISS did not use disk-backed inverted lists")
        self.index.nprobe = 64
        self.mapping = np.memmap(root / "ann_to_row.u32", dtype="<u4", mode="r")
        self.points = np.memmap(root / "point_index.bin", dtype=np.dtype([("thumb", "<u4"), ("subset", "u1")]), mode="r")
        self.voxels = np.memmap(root / "row_to_voxel.bin", dtype="<u4", mode="r")
        if any(len(a) != c["rows"] for a in (self.mapping, self.points, self.voxels)): raise ValueError("Map lookup row count mismatch")
        self.encoder = CLIPTextModelWithProjection.from_pretrained(root / "text-model", local_files_only=True).eval()
        self.tokenizer = CLIPTokenizerFast.from_pretrained(root / "text-model", local_files_only=True)
        self.lock = threading.Lock(); self.cache = OrderedDict()
        if not np.allclose(self.embed("a red sports car"), np.load(root / "text-check.npy"), atol=1e-5):
            raise ValueError("CLIP text export differs from verified model")

    def embed(self, query):
        with self.torch.inference_mode():
            tokens = self.tokenizer(query, truncation=True, max_length=77, return_tensors="pt")
            return self.torch.nn.functional.normalize(self.encoder(**tokens).text_embeds, dim=-1).numpy()[0]

    def search(self, query):
        if not self.lock.acquire(blocking=False): raise HTTPException(429, "Search is busy; please try again in a moment.")
        try:
            start = time.perf_counter(); cached = query in self.cache
            vector = self.cache.pop(query) if cached else self.embed(query)
            self.cache[query] = vector
            while len(self.cache) > 128: self.cache.popitem(last=False)
            embed_ms = (time.perf_counter()-start)*1000
            start = time.perf_counter(); self.faiss.omp_set_num_threads(2)
            scores, ids = self.index.search(vector[None, :], 24)
            search_ms = (time.perf_counter()-start)*1000
            results, seen = [], set()
            for ann, score in zip(ids[0], scores[0]):
                if ann < 0: continue
                if ann >= len(self.mapping): raise ValueError("Invalid ANN result")
                row = int(self.mapping[ann])
                if not 0 <= row < len(self.points) or row in seen: raise ValueError("Invalid ANN/map join")
                seen.add(row)
                packed = int(self.voxels[row]); thumb = int(self.points[row]["thumb"])
                results.append(dict(row=row, chunk=packed >> 12, local=packed & 4095, thumb=thumb,
                    score=float(score), model="CLIP ViT-B/32", thumbUrl=f"/thumbs/monet/{thumb}.webp"))
            return dict(dataset=self.config["dataset"], release=self.config["release"], identity=self.config["identity"],
                query=query, results=results, embed_ms=embed_ms, search_ms=search_ms, embedding_cached=cached,
                backend="faiss", index_storage="disk-mapped IVF4096,PQ64x8", nprobe=64)
        finally: self.lock.release()


def warm():
    global service
    try:
        if (HERE / "assets.json").exists():
            manifest = json.loads((HERE / "assets.json").read_text())
            STATE.update(state="downloading", detail="Downloading verified disk index; map streaming remains independent.")
            def download(item):
                path = Path(item["path"])
                if path.is_absolute() or ".." in path.parts: raise ValueError("Invalid artifact path")
                fetch_file(f'{manifest["base_url"]}/{path.as_posix()}', ROOT / path, item["bytes"], item["sha256"])
            with ThreadPoolExecutor(max_workers=3) as pool: list(pool.map(download, manifest["files"]))
        STATE.update(state="loading", detail="Opening the disk index and CLIP text encoder.")
        service = MonetService(ROOT)
        STATE.update(state="ready", detail="CLIP search is ready.")
    except Exception as error:
        STATE.update(state="failed", detail="Search could not start; the map remains available.")
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
    backend: str = Field(default="faiss", pattern="^faiss$")


@app.get("/api/monet/status")
def status():
    memory = {}
    for line in Path("/proc/self/status").read_text().splitlines():
        if line.startswith(("VmRSS:", "VmHWM:")):
            key, value, _unit = line.split(); memory[key.rstrip(":")] = int(value)*1024
    return {**STATE, "memory_bytes": memory, "search_threads": 2,
            "index_storage": "disk-mapped inverted lists; OS page cache is not a fixed RAM budget"}


@app.post("/api/monet/search")
def search(body: SearchRequest):
    if service is None: raise HTTPException(503, STATE["detail"])
    query = body.query.strip()
    if not query: raise HTTPException(422, "Enter a search phrase")
    return service.search(query)


thumb_lock = threading.BoundedSemaphore(8)


def read_range(url, start, length, size):
    if not 0 <= start < size or not 0 < length <= 1024*1024 or start+length > size: raise HTTPException(404)
    request = urllib.request.Request(url, headers={"Range": f"bytes={start}-{start+length-1}"})
    with urllib.request.urlopen(request, timeout=15) as response:
        if response.status != 206 or response.headers.get("Content-Range") != f"bytes {start}-{start+length-1}/{size}":
            raise HTTPException(502, "Invalid thumbnail range response")
        payload = response.read(length+1)
        if len(payload) != length: raise HTTPException(502, "Invalid thumbnail range length")
        return payload


@app.get("/thumbs/monet/{filename}")
def thumbnail(filename: str):
    if not re.fullmatch(r"\d{1,10}\.webp", filename): raise HTTPException(404)
    ref = int(filename[:-5])
    if ref >= 2**32: raise HTTPException(404)
    if not thumb_lock.acquire(blocking=False): raise HTTPException(429)
    try:
        manifest = json.loads((HERE / "thumbs.json").read_text())
        shard, local = ref >> 16, ref & 65535
        if shard >= len(manifest["shards"]): raise HTTPException(404)
        rows, size = manifest["shards"][shard]
        if local >= rows: raise HTTPException(404)
        base = f"{THUMBS_ORIGIN}/shards/{shard:04d}"
        start, end = struct.unpack("<QQ", read_range(base + ".offsets.u64", local*8, 16, (rows+1)*8))
        payload = read_range(base + ".blob", start, end-start, size)
        return Response(payload, media_type="image/webp", headers={"Cache-Control": "public,max-age=86400"})
    finally: thumb_lock.release()


if STATIC.exists(): app.mount("/", StaticFiles(directory=STATIC, html=True), name="ui")
