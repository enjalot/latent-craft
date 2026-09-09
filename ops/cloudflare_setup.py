#!/usr/bin/env python3
"""Inspect Cloudflare access; import only the R2 credentials from a local .env.

No secrets are printed. Inspection is read-only. Explicit flags are required
for the private credential import and creation of the dedicated asset bucket.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shlex
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from configure_r2 import CONFIG, save_config

# These three immutable objects exceed the CDN's 512 MB object cache limit.
# Explicitly bypass the cache so even the first request forwards Range to R2.
LARGE_RANGE_PATHS = (
    "/monet/20260908b/chunks/monet-clip-basemap-full-4m-20260906a-512-web-20260908b/spatial.bin",
    "/monet/20260908b/minimap/monet-clip-basemap-full-4m-20260906a/points/xy_id.bin",
    "/monet/20260908b/points/monet-clip-basemap-pool-20260905a/point_meta.bin",
)


def read_credentials(path):
    value = {}
    for line in path.read_text().splitlines():
        match = re.match(r"(?:export\s+)?(CLOUDFLARE_[A-Z_]+)\s*=\s*(.*)$", line.strip())
        if match:
            tokens = shlex.split(match[2], comments=True)
            value[match[1]] = tokens[0] if len(tokens) == 1 else ""
    account = value.get("CLOUDFLARE_ACCOUNT", "")
    if not re.fullmatch(r"[a-fA-F0-9]{32}", account):
        raise ValueError("CLOUDFLARE_ACCOUNT must contain the account ID")
    return value


def api(credentials, path, method="GET", data=None):
    request = Request("https://api.cloudflare.com/client/v4" + path, method=method,
        headers={"Authorization": "Bearer " + credentials["CLOUDFLARE_TOKEN"], "Content-Type": "application/json"},
        data=json.dumps(data).encode() if data is not None else None)
    try:
        with urlopen(request, timeout=30) as response:
            result = json.load(response)
    except HTTPError as error:
        result = json.load(error)
        return {"success": False, "http_status": error.code, "errors": [{"code": e.get("code"), "message": e.get("message")} for e in result.get("errors", [])]}
    return result


def require(result, label):
    if not result.get("success"):
        raise RuntimeError(f"{label} failed: " + json.dumps(result.get("errors", [])))
    return result.get("result")


def import_connection(previous, credentials, bucket, domain=None):
    """Never widen a saved bucket-only publisher key during a repeat setup."""
    account = credentials["CLOUDFLARE_ACCOUNT"]
    if previous and (previous.get("account_id"), previous.get("bucket")) != (account, bucket):
        raise ValueError("Saved credentials belong to another target; review before replacing")
    value = dict(previous, account_id=account, bucket=bucket)
    if not previous.get("publisher_token_id"):
        value.update(access_key_id=credentials["CLOUDFLARE_ACCESS_KEY_ID"],
            secret_access_key=credentials["CLOUDFLARE_SECRET_ACCESS_KEY"])
    if domain:
        origin = "https://" + domain
        if previous.get("public_origin") and previous["public_origin"] != origin:
            raise ValueError("Saved public origin differs; review before replacing")
        value["public_origin"] = origin
    return value


def configure_public(credentials, bucket, domain, zones):
    matches = [z for z in zones if domain.endswith("." + z["name"]) and z["status"] == "active"]
    if len(matches) != 1 or not re.fullmatch(r"[a-z0-9.-]+", domain):
        raise ValueError("Choose a subdomain of exactly one active account zone; apex changes are not supported")
    zone = matches[0]["id"]
    base = f'/accounts/{credentials["CLOUDFLARE_ACCOUNT"]}/r2/buckets/{bucket}'
    domains = require(api(credentials, base + "/domains/custom"), "Read bucket domains").get("domains", [])
    attached = next((d for d in domains if d["domain"] == domain), None)
    if attached is None:
        records = require(api(credentials, f"/zones/{zone}/dns_records?" + urlencode({"name": domain})), "Read target DNS")
        if records:
            raise ValueError("Target hostname already has DNS records; refusing to replace them")
        require(api(credentials, base + "/domains/custom", "POST", {"domain": domain, "zoneId": zone, "enabled": True, "minTLS": "1.2"}), "Attach public asset domain")
    elif not attached.get("enabled"):
        raise ValueError("Existing domain is disabled; review before changing it")
    rule = {"id": "latent-craft-public-ranges", "allowed": {"methods": ["GET", "HEAD"], "origins": ["*"], "headers": ["Range"]},
        "exposeHeaders": ["Content-Range", "Content-Length", "Accept-Ranges", "ETag", "Content-Encoding"], "maxAgeSeconds": 3600}
    old = api(credentials, base + "/cors")
    if not old.get("success") and old.get("http_status") != 404:
        require(old, "Read CORS")
    rules = (old.get("result") or {}).get("rules", [])
    owned = next((r for r in rules if r.get("id") == rule["id"]), None)
    if owned is not None and owned != rule:
        raise ValueError("Owned CORS policy changed; review before replacing")
    if owned is None:
        require(api(credentials, base + "/cors", "PUT", {"rules": rules + [rule]}), "Configure range CORS")
    cache_rule = {"ref": "latent_craft_static_assets", "description": "Cache immutable latent-craft MONET assets",
        "expression": f'(http.host eq "{domain}" and starts_with(http.request.uri.path, "/monet/"))',
        "action": "set_cache_settings", "action_parameters": {"cache": True, "edge_ttl": {"mode": "respect_origin"}, "browser_ttl": {"mode": "respect_origin"}}, "enabled": True}
    endpoint = f"/zones/{zone}/rulesets/phases/http_request_cache_settings/entrypoint"
    current = api(credentials, endpoint)
    if current.get("http_status") == 404:
        require(api(credentials, f"/zones/{zone}/rulesets", "POST", {"name": "latent-craft static asset cache", "kind": "zone",
            "phase": "http_request_cache_settings", "rules": [cache_rule]}), "Create dedicated cache rule")
    else:
        entry = require(current, "Read cache rules")
        owned = next((r for r in entry.get("rules", []) if r.get("ref") == cache_rule["ref"]), None)
        if owned is None:
            require(api(credentials, f'/zones/{zone}/rulesets/{entry["id"]}/rules', "POST", cache_rule), "Add dedicated cache rule")
        elif any(owned.get(k) != v for k, v in cache_rule.items()):
            raise ValueError("Owned cache rule changed; review before replacing")
    return {"domain": domain, "bucket": bucket, "zone": matches[0]["name"], "cors": "GET/HEAD public ranges", "cache": "immutable MONET paths; respects origin TTL"}


def create_scoped_tokens(credentials, bucket):
    account = credentials["CLOUDFLARE_ACCOUNT"]
    base = f"/accounts/{account}/tokens"
    groups = require(api(credentials, base + "/permission_groups"), "Read token permission groups")
    by_name = {group["name"]: group["id"] for group in groups}
    config = json.loads(CONFIG.read_text())
    if config["account_id"] != account or config["bucket"] != bucket:
        raise ValueError("Private configuration belongs to another target")
    plans = [
        ("analytics_token_id", "latent-craft-local-usage-read", "Account Analytics Read", {f"com.cloudflare.api.account.{account}": "*"}),
        ("publisher_token_id", "latent-craft-bucket-publisher", "Workers R2 Storage Bucket Item Write", {f"com.cloudflare.edge.r2.bucket.{account}_default_{bucket}": "*"}),
    ]
    for key, name, group, resources in plans:
        if config.get(key):
            print(json.dumps({"scoped_token": name, "state": "already configured; unchanged"}))
            continue
        token = require(api(credentials, base, "POST", {"name": name, "policies": [{"effect": "allow", "resources": resources,
            "permission_groups": [{"id": by_name[group]}]}]}), "Create scoped token")
        config[key] = token["id"]
        if key == "analytics_token_id":
            config["analytics_token"] = token["value"]
        else:
            config["access_key_id"] = token["id"]
            config["secret_access_key"] = hashlib.sha256(token["value"].encode()).hexdigest()
        save_config(CONFIG, config)
        print(json.dumps({"scoped_token": name, "permission": group, "state": "created and saved privately"}))


def large_range_rule(domain):
    if not re.fullmatch(r"[a-z0-9.-]+", domain):
        raise ValueError("Invalid public asset hostname")
    paths = " ".join(json.dumps(path) for path in LARGE_RANGE_PATHS)
    return {"ref": "latent_craft_large_range_objects", "description": "Preserve cold byte ranges for oversized MONET objects",
        "expression": f'(http.host eq "{domain}" and http.request.uri.path in {{{paths}}})',
        "action": "set_cache_settings", "action_parameters": {"cache": False}, "enabled": True}


def configure_large_ranges(credentials, domain, zones):
    matches = [z for z in zones if domain.endswith("." + z["name"]) and z["status"] == "active"]
    if len(matches) != 1:
        raise ValueError("Choose an asset subdomain of one active account zone")
    zone = matches[0]["id"]
    entry = require(api(credentials, f"/zones/{zone}/rulesets/phases/http_request_cache_settings/entrypoint"), "Read cache rules")
    rule = large_range_rule(domain)
    rules = entry.get("rules", [])
    owned = next((r for r in rules if r.get("ref") == rule["ref"]), None)
    if owned is None:
        # Last matching rule wins. Append this exception after the normal cache
        # rule without replacing or reordering any existing account rules.
        require(api(credentials, f'/zones/{zone}/rulesets/{entry["id"]}/rules', "POST", rule), "Add oversized-object range exception")
    elif any(owned.get(k) != v for k, v in rule.items()) or any(r.get("ref") == "latent_craft_static_assets" for r in rules[rules.index(owned)+1:]):
        raise ValueError("Owned large-object rule changed or is ordered incorrectly; review before replacing")
    return {"domain": domain, "bypassed_paths": list(LARGE_RANGE_PATHS), "other_assets": "cache policy unchanged"}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", type=Path, default=Path.home() / "code/.env")
    parser.add_argument("--bucket", default="latent-craft")
    parser.add_argument("--import-credentials", action="store_true")
    parser.add_argument("--create-bucket", action="store_true")
    parser.add_argument("--public-domain", help="Explicitly attach this asset subdomain and add scoped CORS/cache rules")
    parser.add_argument("--create-scoped-tokens", action="store_true", help="Create private bucket-only upload and account-read-only analytics credentials")
    parser.add_argument("--large-range-domain", help="Add an exact-path CDN bypass for oversized MONET range objects on this asset domain")
    args = parser.parse_args()
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{1,61}[a-z0-9]", args.bucket):
        raise ValueError("Invalid dedicated bucket name")
    credentials = read_credentials(args.env_file)
    account = credentials["CLOUDFLARE_ACCOUNT"]
    base = f"/accounts/{account}/r2/buckets"
    buckets = api(credentials, base)
    if buckets.get("success"):
        print(json.dumps({"buckets": [{k: b.get(k) for k in ("name", "location", "storageClass")} for b in buckets["result"].get("buckets", [])]}))
    else:
        print(json.dumps({"bucket_access": buckets}))
    zones = api(credentials, "/zones?" + urlencode({"account.id": account, "per_page": 50}))
    if zones.get("success"):
        print(json.dumps({"zones": [{k: z.get(k) for k in ("id", "name", "status")} for z in zones["result"]]}))
    else:
        print(json.dumps({"zone_access": zones}))
    if args.create_bucket:
        if not buckets.get("success"):
            raise SystemExit("Need R2 bucket-management API access before creating a bucket")
        existing = next((b for b in buckets["result"].get("buckets", []) if b["name"] == args.bucket), None)
        if existing:
            print(json.dumps({"bucket_creation": "already exists; unchanged"}))
        else:
            created = api(credentials, base, "POST", {"name": args.bucket, "storageClass": "Standard", "locationHint": "enam"})
            if not created.get("success"):
                raise SystemExit(json.dumps({"bucket_creation": created}))
            print(json.dumps({"bucket_creation": created["result"]}))
    if args.public_domain:
        if not zones.get("success"):
            raise SystemExit("Need zone read access to resolve the domain safely")
        result = configure_public(credentials, args.bucket, args.public_domain, zones["result"])
        print(json.dumps({"public_assets": result}))
    if args.import_credentials:
        previous = json.loads(CONFIG.read_text()) if CONFIG.exists() else {}
        save_config(CONFIG, import_connection(previous, credentials, args.bucket, args.public_domain))
        print(json.dumps({"credentials": "Saved privately; source .env unchanged"}))
    if args.create_scoped_tokens:
        create_scoped_tokens(credentials, args.bucket)
    if args.large_range_domain:
        if not zones.get("success"):
            raise SystemExit("Need zone read access to resolve the domain safely")
        print(json.dumps({"large_ranges": configure_large_ranges(credentials, args.large_range_domain, zones["result"])}))
