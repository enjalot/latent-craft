#!/usr/bin/env python3
"""Publish only the reviewed BL runtime + compiled UI to the dedicated demo Space.

Never uploads the repo/history, local logs, data sources or credentials. Uses an
existing HF login and CPU Basic; no paid hardware or persistent volume request.
"""
import argparse
import json
from pathlib import Path
import shutil
import tempfile
from huggingface_hub import HfApi


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", default="enjalot/latent-craft-bl")
    parser.add_argument("--search-assets", type=Path, help="Publish a packaged search release to the dedicated Hub dataset")
    parser.add_argument("--artifact-repo", default="enjalot/latent-craft-bl-search", help="Dedicated dataset repository; Space repositories have a 1 GB cap")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    token_path = Path.home() / ".cache/huggingface/token"
    api = HfApi(token=token_path.read_text().strip() if token_path.exists() else None)
    if api.whoami()["name"] != args.repo.split("/")[0]: raise ValueError("Unexpected publishing account")
    api.create_repo(args.repo, repo_type="space", space_sdk="docker", private=False, exist_ok=True)
    search_manifest = None
    if args.search_assets:
        # Keep Hub artifacts out of Docker layers; the running worker loads
        # checksummed files from an immutable Hub commit in the background.
        api.upload_file(repo_id=args.repo, repo_type="space", path_in_repo=".dockerignore",
                        path_or_fileobj=root / "deploy/bl-space/.dockerignore", commit_message="Separate search artifacts from Docker image")
        if args.artifact_repo.split("/")[0] != args.repo.split("/")[0]: raise ValueError("Artifact owner differs from Space owner")
        api.create_repo(args.artifact_repo, repo_type="dataset", private=False, exist_ok=True)
        card = """---
license: other
license_name: mixed-artifact-licenses
license_link: https://huggingface.co/datasets/enjalot/latent-craft-bl-search/blob/main/README.md
pretty_name: latent-craft British Library search artifacts
---
# latent-craft British Library search artifacts

Deployment artifacts for the independent [BL demo](https://huggingface.co/spaces/enjalot/latent-craft-bl), not an official British Library release.

Derived float16 vectors, SQ8 indices, and row-to-map lookups come from the public-domain [British Library Book Images dataset](https://huggingface.co/datasets/biglam/british-library-book-images), mirrored by Daniel van Strien. The text-only weights/tokenizer are an export of [Google SigLIP 2 SO400M patch16-256](https://huggingface.co/google/siglip2-so400m-patch16-256), revision e8708ab72d125807e45b36fb7d4e0aacbb59f379, under Apache-2.0. These notices apply separately; no blanket new license is asserted for the mixed bundle.

Historical content may contain offensive depictions. These are approximate-neighbor search files, not relevance labels. The browser never downloads them. The demo worker verifies every runtime file against a pinned manifest before loading. No user queries, credentials, original source images, or private data are included.
"""
        api.upload_file(repo_id=args.artifact_repo, repo_type="dataset", path_in_repo="README.md", path_or_fileobj=card.encode(), commit_message="Document BL search artifact provenance and separate licenses")
        api.upload_file(repo_id=args.artifact_repo, repo_type="dataset", path_in_repo="SIGLIP-LICENSE.txt",
                        path_or_fileobj=root / "deploy/bl-space/SIGLIP-LICENSE.txt", commit_message="Include Apache 2.0 license for Google model export")
        prefix = args.search_assets.name
        commit = api.upload_folder(repo_id=args.artifact_repo, repo_type="dataset", folder_path=args.search_assets,
            path_in_repo=prefix, ignore_patterns=["assets.json", "assets-hf.json"],
            commit_message="Add verified BL search finalists and SigLIP text-only model")
        search_manifest = json.loads((args.search_assets / "assets.json").read_text())
        search_manifest["base_url"] = f"https://huggingface.co/datasets/{args.artifact_repo}/resolve/{commit.oid}/{prefix}"
        (args.search_assets / "assets-hf.json").write_text(json.dumps(search_manifest, indent=2) + "\n")
    with tempfile.TemporaryDirectory(prefix="latent-craft-space-") as folder:
        staging = Path(folder)
        for name in ["app.py", "Dockerfile", ".dockerignore", "README.md", "SIGLIP-LICENSE.txt", "assets.json"]:
            source = root / "deploy/bl-space" / name
            if source.exists(): shutil.copyfile(source, staging / name)
        if search_manifest: (staging / "assets.json").write_text(json.dumps(search_manifest, indent=2) + "\n")
        shutil.copytree(root / "frontend/dist", staging / "static")
        thumbs = Path("/data/latent-craft/releases/bl-20260907a/thumbs/bl")
        (staging / "thumbs").mkdir()
        shutil.copyfile(thumbs / "manifest.json", staging / "thumbs/manifest.json")
        for subset in ["covers", "medium", "embellishments", "plates"]:
            (staging / "thumbs" / subset).mkdir()
            shutil.copyfile(thumbs / subset / "offsets.bin", staging / "thumbs" / subset / "offsets.bin")
        # No data, caches or credentials in this explicitly constructed staging tree.
        api.upload_folder(repo_id=args.repo, repo_type="space", folder_path=staging,
                          commit_message="Publish latent-craft British Library CPU demo")
    print(f"https://huggingface.co/spaces/{args.repo}")


if __name__ == "__main__": main()
