#!/usr/bin/env python3
"""Publish verified MONET search artifacts, then an explicitly staged CPU Space.

--artifacts-only prepares the pinned bundle without exposing an incomplete map.
Space publication requires the built profile and public byte-range assets to
pass preflight. This command never selects paid hardware or uploads a corpus.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import tempfile
import urllib.request

from huggingface_hub import HfApi

MAP_ORIGIN = "https://storage.googleapis.com/fun-data/latent-craft/monet/20260908b"
THUMBS = "https://storage.googleapis.com/fun-data/latent-craft/monet/thumbs/full-20260908b/manifest.json"


def range_probe(url, length, size):
    request = urllib.request.Request(url, headers={"Range": f"bytes=0-{length-1}"})
    with urllib.request.urlopen(request, timeout=30) as response:
        if response.status != 206 or response.headers.get("Content-Range") != f"bytes 0-{length-1}/{size}":
            raise ValueError("Static origin does not preserve byte ranges")
        if len(response.read(length+1)) != length: raise ValueError("Invalid static range length")


def preflight(root):
    profile = json.loads((root / "frontend/dist/build-profile.json").read_text())
    if profile["dataset"] != "monet-clip-basemap-full-4m-512" or profile["dataOrigin"] != MAP_ORIGIN or profile["monetThumbnailPack"] != THUMBS:
        raise ValueError("Build the MONET publication profile before publishing this Space")
    base = MAP_ORIGIN + "/chunks/monet-clip-basemap-full-4m-20260906a-512-web-20260908b"
    with urllib.request.urlopen(base + "/manifest.json", timeout=30) as response: manifest = json.load(response)
    if manifest["row_to_voxel"]["sha256"] != "ca437bba419cc933455eefbf2af0b797657addce8b2d886db574e7f8f94d6c5f":
        raise ValueError("Static map belongs to another release")
    ref = manifest["row_to_voxel"]; range_probe(base + "/" + ref["path"], 4, ref["bytes"])
    with urllib.request.urlopen(THUMBS, timeout=30) as response: thumbs = json.load(response)
    if thumbs["rows"] != 103816750 or len(thumbs["shards"]) != 10880: raise ValueError("Incomplete thumbnail corpus")
    for i in (0, len(thumbs["shards"])-1):
        rows, size = thumbs["shards"][i]
        path = THUMBS.rsplit("/", 1)[0] + f"/shards/{i:04d}"
        range_probe(path + ".offsets.u64", 16, (rows+1)*8); range_probe(path + ".blob", 16, size)
    return thumbs


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", default="enjalot/latent-craft-monet")
    parser.add_argument("--artifact-repo", default="enjalot/latent-craft-monet-search")
    parser.add_argument("--search-assets", type=Path, required=True)
    parser.add_argument("--artifacts-only", action="store_true")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    thumbs = None if args.artifacts_only else preflight(root)
    api = HfApi(token=(Path.home() / ".cache/huggingface/token").read_text().strip())
    if api.whoami()["name"] != args.repo.split("/")[0] or args.artifact_repo.split("/")[0] != args.repo.split("/")[0]:
        raise ValueError("Unexpected publishing account")
    manifest = json.loads((args.search_assets / "assets.json").read_text())
    for item in manifest["files"]:
        name = Path(item["path"])
        if name.is_absolute() or ".." in name.parts: raise ValueError("Invalid artifact path")
        path = args.search_assets / name
        with path.open("rb") as stream: digest = hashlib.file_digest(stream, "sha256").hexdigest()
        if path.stat().st_size != item["bytes"] or digest != item["sha256"]: raise ValueError("Artifact changed since packaging")
    api.create_repo(args.artifact_repo, repo_type="dataset", private=False, exist_ok=True)
    card = """---
license: other
license_name: mixed-artifact-licenses
license_link: https://huggingface.co/datasets/enjalot/latent-craft-monet-search/blob/main/README.md
pretty_name: latent-craft MONET 100M disk search
---
# latent-craft MONET search artifacts

Deployment artifacts for [latent-craft](https://github.com/enjalot/latent-craft), an independent MONET explorer.
The publisher's IVF4096/PQ64x8 index comes from [Jasper MONET](https://huggingface.co/datasets/jasperai/monet)
(dataset release declared Apache-2.0). The text-only [OpenAI CLIP ViT-B/32](https://huggingface.co/openai/clip-vit-base-patch32)
export, revision 3d74acf9a28c67741b2f4f2ea7635f0aaf6f0268, is MIT licensed; see CLIP-LICENSE.txt.
These separate terms do not imply a blanket license for source images or project code.

Contains the read-only disk index, a verified one-to-one ANN/map ID join, compact map lookups and text tower/tokenizer.
All 103,816,750 source IDs were joined; all 198 hash-collision entries were disambiguated using exact stored IVF/PQ
codes, and 1,026 additional code/embedding samples agreed. The frontend uses the 4M-trained CLIP basemap release,
not the DINO map. No source embedding matrix, original image files, user queries or credentials are included.
The worker verifies sizes and SHA-256 from an immutable Hub commit. Browsers never download these search artifacts.
"""
    api.upload_file(repo_id=args.artifact_repo, repo_type="dataset", path_in_repo="README.md", path_or_fileobj=card.encode(), commit_message="Document full-corpus search identity and model provenance")
    api.upload_file(repo_id=args.artifact_repo, repo_type="dataset", path_in_repo="CLIP-LICENSE.txt", path_or_fileobj=root / "deploy/monet-space/CLIP-LICENSE.txt", commit_message="Include CLIP model license")
    commit = api.upload_folder(repo_id=args.artifact_repo, repo_type="dataset", folder_path=args.search_assets,
        path_in_repo=args.search_assets.name, allow_patterns=[item["path"] for item in manifest["files"]],
        commit_message="Publish verified disk FAISS index and complete ANN-to-map join")
    manifest["base_url"] = f"https://huggingface.co/datasets/{args.artifact_repo}/resolve/{commit.oid}/{args.search_assets.name}"
    (args.search_assets / "assets-hf.json").write_text(json.dumps(manifest, indent=2))
    print(json.dumps({"artifact_base_url": manifest["base_url"], "files": len(manifest["files"])}), flush=True)
    if args.artifacts_only: return
    api.create_repo(args.repo, repo_type="space", space_sdk="docker", private=False, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="latent-craft-monet-space-") as folder:
        stage = Path(folder)
        for name in ("app.py", "Dockerfile", ".dockerignore", "README.md", "CLIP-LICENSE.txt"):
            shutil.copyfile(root / "deploy/monet-space" / name, stage / name)
        (stage / "assets.json").write_text(json.dumps(manifest, indent=2))
        (stage / "thumbs.json").write_text(json.dumps(thumbs, separators=(",", ":")))
        shutil.copytree(root / "frontend/dist", stage / "static")
        api.upload_folder(repo_id=args.repo, repo_type="space", folder_path=stage, commit_message="Publish streaming MONET 100M CLIP explorer with disk FAISS search")
    print(f"https://huggingface.co/spaces/{args.repo}")


if __name__ == "__main__": main()
