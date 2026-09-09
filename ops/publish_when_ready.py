#!/usr/bin/env python3
"""Freeze an approved MONET build, then publish only after R2 jobs complete.

Preparation is local. --run performs the authorized HF publication on free
default hardware. It never edits DNS, starts uploads, changes source, or retries
a failed publication indefinitely. Status is consumed by the LAN dashboard.
"""
import argparse
import fcntl
import hashlib
import io
import json
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

REPOSITORY = Path(__file__).resolve().parents[1]
SPACE = "enjalot/latent-craft-monet"
ORIGIN = "https://enjalot-latent-craft-monet.hf.space"
IDENTITY = "ca437bba419cc933455eefbf2af0b797657addce8b2d886db574e7f8f94d6c5f"
USER_AGENT = "latent-craft-release-check/1.0 (+https://github.com/enjalot/latent-craft)"


def sha(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".partial")
    temporary.write_text(json.dumps(value, separators=(",", ":")) + "\n")
    temporary.replace(path)


def prepare(args):
    if args.job.exists():
        raise ValueError("Use a fresh job directory; never overwrite a frozen release")
    profile = json.loads((args.frontend_dist / "build-profile.json").read_text())
    if (profile["dataset"], profile["dataOrigin"], profile["monetThumbnailPack"]) != (
        "monet-clip-basemap-full-4m-512", "https://assets.latent.download/monet/20260908b",
        "https://assets.latent.download/monet/thumbs/full-128-20260908a/manifest.json"):
        raise ValueError("Build the approved R2 MONET profile first")
    if profile.get("thumbnailOrigin") != "":
        raise ValueError("Build with VITE_THUMBS_ORIGIN='' for permanent thumbnail URLs")
    sources = [(p, Path("frontend/dist") / p.relative_to(args.frontend_dist)) for p in args.frontend_dist.rglob("*") if p.is_file()]
    sources += [(REPOSITORY / "deploy/monet-space" / name, Path("deploy/monet-space") / name)
        for name in ("app.py", "Dockerfile", ".dockerignore", "README.md", "CLIP-LICENSE.txt")]
    sources += [(REPOSITORY / name, Path(name)) for name in ("pipeline/scripts/publish_monet_space.py", "ops/publish_when_ready.py")]
    if sum(p.stat().st_size for p, _ in sources) > 100 * 1024**2:
        raise ValueError("Frontend/runtime staging exceeds its 100 MiB bound")
    args.job.mkdir(parents=True)
    files = []
    for source, relative in sources:
        target = args.job / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        files.append({"path": str(relative), "sha256": sha(target)})
    inputs = [{"path": str(args.search_assets / name), "sha256": sha(args.search_assets / name)} for name in ("assets.json", "assets-hf.json")]
    config = dict(version=1, space=SPACE, files=files, inputs=inputs, thumbnail_release=str(args.thumbnail_release.resolve()),
        static_status=str(args.static_status.resolve()), search_assets=str(args.search_assets.resolve()), state=str(args.state.resolve()))
    save(args.job / "job.json", config)
    print(json.dumps({"state": "prepared", "files": len(files), "job": str(args.job)}))


def verify_snapshot(job, config):
    if config["version"] != 1 or config["space"] != SPACE:
        raise ValueError("Unexpected publication target")
    for entry in config["files"]:
        path = Path(entry["path"])
        if path.is_absolute() or ".." in path.parts or sha(job / path) != entry["sha256"]:
            raise ValueError("Frozen release changed; prepare a new job")
    for entry in config["inputs"]:
        if sha(Path(entry["path"])) != entry["sha256"]:
            raise ValueError("Search manifest changed since preparation")


def prerequisites(config):
    root = Path(config["thumbnail_release"])
    values = []
    for path in (root / "progress.json", root / "upload-progress.json", Path(config["static_status"])):
        if not path.exists():
            return False, "waiting for local jobs"
        value = json.loads(path.read_text())
        if value["state"] in ("failed", "partial"):
            raise ValueError("A prerequisite job failed or produced a partial release")
        if value["state"] != "complete" and time.time() - path.stat().st_mtime > 1800:
            raise ValueError("A prerequisite has not reported progress for 30 minutes")
        values.append(value)
    build, upload, static = values
    if all(v["state"] == "complete" for v in values):
        if (build["completed_rows"], build["completed_shards"]) != (103816750, 10880):
            raise ValueError("Incomplete thumbnail corpus")
        if any(v["files_done"] != v["files_total"] for v in (upload, static)):
            raise ValueError("Incomplete upload receipts")
        if upload["prefix"] != "monet/thumbs/full-128-20260908a" or static["prefix"] != "monet/20260908b":
            raise ValueError("Unexpected R2 release prefixes")
        return True, "all local upload receipts complete"
    return False, "waiting for complete conversion, thumbnails and map uploads"


def public_bytes(path, payload=None, bound=1024**2):
    headers = {"User-Agent": USER_AGENT}
    if payload is not None:
        headers["Content-Type"] = "application/json"
    request = Request(ORIGIN + path, headers=headers, data=json.dumps(payload).encode() if payload is not None else None)
    with urlopen(request, timeout=60) as response:
        body = response.read(bound+1)
    if len(body) > bound:
        raise ValueError("Space response exceeded release-check bound")
    return body


def verify_search(config):
    from PIL import Image
    result = json.loads(public_bytes("/api/monet/search", {"query": "a red sports car"}))
    if (result["dataset"], result["identity"]) != ("monet-clip-basemap-full-4m-512", IDENTITY) or not result["results"]:
        raise ValueError("Published search belongs to another map")
    root = Path(config["search_assets"])
    with (root / "row_to_voxel.bin").open("rb") as voxels, (root / "point_index.bin").open("rb") as points:
        for image in result["results"]:
            row = image["row"]
            if not 0 <= row < 103816750:
                raise ValueError("Published search returned an invalid row")
            voxels.seek(row * 4); packed, = struct.unpack("<I", voxels.read(4))
            points.seek(row * 5); thumb, _subset = struct.unpack("<IB", points.read(5))
            if (image["chunk"], image["local"], image["thumb"]) != (packed >> 12, packed & 4095, thumb):
                raise ValueError("Published search/image identity mismatch")
    # Check the image resolver used by permanent inventory exports too. Known
    # missing spans may occur; examine at most five candidates, never all rows.
    for image in result["results"][:5]:
        try:
            body = public_bytes(f'/thumbs/monet/{image["thumb"]}.webp')
        except HTTPError as error:
            if error.code == 404:
                continue
            raise
        with Image.open(io.BytesIO(body)) as decoded:
            decoded.load()
            if decoded.format != "WEBP" or not 0 < max(decoded.size) <= 128:
                raise ValueError("Published thumbnail is not the 128px release")
        return dict(results_checked=len(result["results"]), embed_ms=result["embed_ms"], search_ms=result["search_ms"],
            thumbnail_bytes=len(body), thumbnail_id=image["thumb"])
    raise ValueError("No verifiable thumbnail among five search results")


def run(job):
    config = json.loads((job / "job.json").read_text())
    state_path = Path(config["state"])
    state = {"state": "waiting", "phase": "checking frozen release", "started_at": time.time(), "job": str(job)}
    def report(**updates):
        state.update(updates, updated_at=time.time())
        save(state_path, state)
    with (job / ".run.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if state_path.exists():
            previous = json.loads(state_path.read_text())
            if previous.get("state") == "complete" and previous.get("job") == str(job):
                raise ValueError("Already published; prepare a fresh job for a new deployment")
        try:
            verify_snapshot(job, config)
            deadline = time.monotonic() + 12*3600
            while True:
                ready, phase = prerequisites(config)
                report(phase=phase)
                if ready:
                    break
                if time.monotonic() > deadline:
                    raise TimeoutError("Publication prerequisites exceeded 12 hours")
                time.sleep(30)
            verify_snapshot(job, config)
            report(state="publishing", phase="public range preflight and HF upload")
            with (job / "publish.log").open("a") as log:
                process = subprocess.Popen([sys.executable, str(job / "pipeline/scripts/publish_monet_space.py"),
                    "--search-assets", config["search_assets"], "--reuse-pinned-assets", "--preflight-report", str(job / "preflight.json")], stdout=log, stderr=subprocess.STDOUT)
                deadline = time.monotonic() + 1800
                try:
                    while process.poll() is None:
                        if time.monotonic() > deadline:
                            raise TimeoutError("HF publication exceeded 30 minutes")
                        report(); time.sleep(10)
                    if process.returncode:
                        report_path = job / "preflight.json"
                        if report_path.exists() and report_path.stat().st_size < 8192:
                            preflight = json.loads(report_path.read_text())
                            if preflight.get("state") == "failed":
                                raise RuntimeError("Static preflight failed: " + preflight.get("detail", "unknown response"))
                        raise RuntimeError("Publisher failed; inspect private publish.log")
                finally:
                    if process.poll() is None:
                        process.terminate()
                        try: process.wait(timeout=10)
                        except subprocess.TimeoutExpired: process.kill(); process.wait()
            report(state="verifying", phase="waiting for HF build and disk search startup")
            deadline = time.monotonic() + 90*60
            expected_frontend = sha(job / "frontend/dist/index.html")
            while time.monotonic() < deadline:
                try:
                    # An update can still serve the old healthy app while HF
                    # builds its replacement. Verify the new UI before readiness.
                    current_frontend = hashlib.sha256(public_bytes("/")).hexdigest()
                    status = json.loads(public_bytes("/api/monet/status")) if current_frontend == expected_frontend else {"state": "building new frontend"}
                except (HTTPError, URLError, TimeoutError, ValueError):
                    status = {"state": "building"}
                if status["state"] == "failed":
                    raise RuntimeError("Published search startup failed")
                report(phase="HF search: " + status["state"])
                if status["state"] == "ready":
                    break
                time.sleep(30)
            else:
                raise TimeoutError("HF build/search startup exceeded 90 minutes")
            checks = verify_search(config)
            report(state="complete", phase="range preflight, search/image identities and 128px resolver verified",
                checks=checks, url=f"https://huggingface.co/spaces/{SPACE}")
        except BaseException as error:
            report(state="failed", error=type(error).__name__, detail=str(error))
            raise


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--prepare", action="store_true")
    action.add_argument("--run", action="store_true")
    parser.add_argument("--job", type=Path, required=True)
    parser.add_argument("--frontend-dist", type=Path, default=REPOSITORY / "frontend/dist")
    parser.add_argument("--thumbnail-release", type=Path, default=Path("/data/latent-craft/releases/monet-thumbs128-20260908a"))
    parser.add_argument("--static-status", type=Path, default=Path("/data/latent-craft/ops/monet-static-upload.json"))
    parser.add_argument("--state", type=Path, default=Path("/data/latent-craft/ops/monet-deployment.json"))
    parser.add_argument("--search-assets", type=Path, default=Path("/data/latent-craft/releases/monet-clip-search-20260908c"))
    args = parser.parse_args()
    prepare(args) if args.prepare else run(args.job.resolve())
