#!/usr/bin/env python3
"""Store R2 credentials privately on this machine, never in the repo or browser.

Run over an SSH terminal. This only writes local configuration; it does not
create buckets, change DNS, upload files, or start a paid subscription.
"""
import argparse
import getpass
import json
import os
from pathlib import Path
import re
import tempfile
from urllib.parse import urlsplit

CONFIG = Path.home() / ".config/latent-craft/r2.json"


def validate_config(value):
    if not re.fullmatch(r"[a-fA-F0-9]{32}", value.get("account_id", "")):
        raise ValueError("Account ID must be the 32-character Cloudflare account ID")
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{1,61}[a-z0-9]", value.get("bucket", "")):
        raise ValueError("Use a simple lowercase R2 bucket name")
    if not re.fullmatch(r"[a-fA-F0-9]{32}", value.get("access_key_id", "")):
        raise ValueError("Expected the R2 S3 Access Key ID, not a general API token")
    if not re.fullmatch(r"[a-fA-F0-9]{64}", value.get("secret_access_key", "")):
        raise ValueError("Expected the R2 S3 Secret Access Key")
    if value.get("public_origin"):
        url = urlsplit(value["public_origin"])
        if url.scheme != "https" or not url.hostname or url.username or url.password or url.query or url.fragment or url.path not in ("", "/"):
            raise ValueError("Public origin must be an HTTPS hostname, without credentials or a path")
    if value.get("analytics_token") and (not 20 <= len(value["analytics_token"]) <= 512 or any(c.isspace() for c in value["analytics_token"])):
        raise ValueError("Invalid Analytics token format")


def save_config(path, value):
    validate_config(value)
    path.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
    os.chmod(path.parent, 0o700)
    with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, prefix=".r2-", delete=False) as stream:
        os.fchmod(stream.fileno(), 0o600)
        json.dump(value, stream)
        stream.write("\n")
        temporary = Path(stream.name)
    temporary.replace(path)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--analytics-only", action="store_true")
    args = parser.parse_args()
    previous = json.loads(CONFIG.read_text()) if CONFIG.exists() else {}
    if previous and not args.analytics_only and input("Replace the saved R2 connection? [y/N] ").strip().lower() != "y":
        raise SystemExit("Unchanged")
    if args.analytics_only and not previous:
        raise SystemExit("Configure the R2 connection first")
    config = previous if args.analytics_only else {
        "account_id": input("Cloudflare Account ID: ").strip(),
        "bucket": input("Bucket [latent-craft]: ").strip() or "latent-craft",
        "access_key_id": getpass.getpass("R2 Access Key ID (hidden): ").strip(),
        "secret_access_key": getpass.getpass("R2 Secret Access Key (hidden): ").strip(),
        "public_origin": input("Public HTTPS origin (blank until custom domain is ready): ").strip().rstrip("/"),
    }
    token = getpass.getpass("Optional Account Analytics Read token (hidden; Enter to skip): ").strip()
    if token:
        config["analytics_token"] = token
    save_config(CONFIG, config)
    print(f"Saved private configuration to {CONFIG}. No cloud changes made.")
