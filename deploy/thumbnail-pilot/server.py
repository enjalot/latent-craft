"""Bounded read-only thumbnail service. Range and resolved-image paths share files."""
import hashlib
import json
import os
from pathlib import Path
import re
import struct
import time
import uuid

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response

MAX_RANGE = 1024**2


def byte_range(value: str | None, size: int) -> tuple[int, int]:
    """Single, bounded RFC byte range. Large/full blob downloads are not a pilot API."""
    headers = {"Content-Range": f"bytes */{size}", "Accept-Ranges": "bytes"}
    match = re.fullmatch(r"bytes=(\d{0,20})-(\d{0,20})", value or "")
    if not match or not any(match.groups()): raise HTTPException(416, "A single byte range is required", headers=headers)
    left, right = match.groups()
    if left:
        start, end = int(left), min(int(right) if right else size - 1, size - 1)
    else:
        length = int(right)
        if length < 1: raise HTTPException(416, "Empty suffix", headers=headers)
        start, end = max(0, size - length), size - 1
    if start > end or start >= size or end - start + 1 > MAX_RANGE:
        raise HTTPException(416, "Range is outside the file or exceeds 1 MiB", headers=headers)
    return start, end - start + 1


def read_span(path: Path, start: int, length: int) -> bytes:
    with path.open("rb", buffering=0) as f:
        data = os.pread(f.fileno(), length, start)
    if len(data) != length: raise HTTPException(503, "Truncated pilot artifact")
    return data


def create_app(root: Path) -> FastAPI:
    manifest_bytes = (root / "manifest.json").read_bytes()
    manifest = json.loads(manifest_bytes)
    files = {f["path"]: f for f in manifest["files"]}
    container_id = uuid.uuid4().hex[:12]
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["GET", "HEAD"], allow_headers=["Range", "If-Range"],
        expose_headers=["Content-Range", "Content-Length", "Accept-Ranges", "ETag", "X-Read-Ms", "X-Container"])

    def headers(started, etag):
        return {"Cache-Control": "public, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff",
            "X-Read-Ms": f"{(time.perf_counter()-started)*1000:.3f}", "X-Container": container_id, "ETag": f'"{etag}"'}

    @app.get("/health")
    def health():
        rss = next((int(line.split()[1])*1024 for line in Path("/proc/self/status").read_text().splitlines() if line.startswith("VmRSS:")), 0)
        return {"container": container_id, "rows": manifest["rows"], "files": len(files), "rss_bytes": rss, "max_range_bytes": MAX_RANGE}

    @app.get("/manifest.json")
    def info():
        return Response(manifest_bytes, media_type="application/json", headers={"Cache-Control": "public, max-age=3600"})

    @app.api_route("/packs/{size}/{filename}", methods=["GET", "HEAD"])
    def packed(size: int, filename: str, request: Request):
        started = time.perf_counter()
        if size not in (128, 256) or not re.fullmatch(r"\d{4,5}\.(blob|offsets\.u64)", filename): raise HTTPException(404)
        item = files.get(f"{size}/{filename}")
        if item is None: raise HTTPException(404)
        h = headers(started, item["sha256"]); h["Accept-Ranges"] = "bytes"
        if request.method == "HEAD":
            h["Content-Length"] = str(item["bytes"])
            return Response(headers=h, media_type="application/octet-stream")
        start, length = byte_range(request.headers.get("range"), item["bytes"])
        data = read_span(root / item["path"], start, length)
        h.update(headers(started, item["sha256"]))
        h["Content-Range"] = f'bytes {start}-{start + length - 1}/{item["bytes"]}'
        return Response(data, status_code=206, media_type="application/octet-stream", headers=h)

    @app.get("/thumbs/{size}/{ref}.webp")
    def thumbnail(size: int, ref: int):
        started = time.perf_counter()
        if size not in (128, 256) or not 0 <= ref < 2**32: raise HTTPException(404)
        shard, row = f"{ref >> 16:04d}", ref & 65535
        info = manifest["shards"].get(shard)
        if info is None or row >= info["rows"]: raise HTTPException(404)
        start, end = struct.unpack("<QQ", read_span(root / str(size) / f"{shard}.offsets.u64", row * 8, 16))
        if not 0 <= start < end <= info[str(size)] or end - start > MAX_RANGE: raise HTTPException(404)
        data = read_span(root / str(size) / f"{shard}.blob", start, end - start)
        return Response(data, media_type="image/webp", headers=headers(started, hashlib.sha256(data).hexdigest()))

    return app
