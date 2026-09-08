#!/usr/bin/env python3
"""Read-only LAN usage dashboard. Provider polling never wakes demo containers.

Credentials stay server-side. Usage is not an invoice: each provider labels its
scope, observation time, missing data and estimation assumptions separately.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import ipaddress
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import threading
import time
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, urlopen
from urllib.error import HTTPError

HERE = Path(__file__).resolve().parent
UTC = timezone.utc


def stamp(value=None):
    return (value or datetime.now(UTC)).isoformat().replace("+00:00", "Z")


def month_start(now):
    return now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)


def command(args):
    result = subprocess.run(args, capture_output=True, text=True, timeout=60)
    if result.returncode:
        raise RuntimeError("Provider CLI failed; verify login and API access in the setup guide")
    return result.stdout


def fetch_json(url, headers=None, data=None):
    request = Request(url, headers=headers or {}, data=json.dumps(data).encode() if data is not None else None)
    with urlopen(request, timeout=25) as response:
        body = response.read(8 * 1024**2 + 1)
    if len(body) > 8 * 1024**2:
        raise ValueError("Provider response exceeded dashboard bound")
    return json.loads(body)


def modal_summary(rows):
    by_app = {}
    for row in rows:
        name = row["Description"]
        cost = Decimal(row["Cost"])
        by_app[name] = by_app.get(name, Decimal(0)) + cost
    return dict(gross_usd=float(sum(by_app.values())), apps=[dict(name=k, usd=float(v)) for k, v in sorted(by_app.items())],
        scope="Workspace-wide month-to-date report, before credits and reservations",
        note="Provider-reported usage cost, not a final invoice. The stated $30 credit is not subtracted; remaining credit is not exposed here.")


def collect_modal(modal_cli):
    return modal_summary(json.loads(command([modal_cli, "billing", "report", "--for", "this month", "--json"])))


def collect_hf(repos):
    token_path = Path.home() / ".cache/huggingface/token"
    headers = {"Authorization": "Bearer " + token_path.read_text().strip()} if token_path.exists() else {}
    spaces = []
    for repo in repos:
        try:
            runtime = fetch_json(f"https://huggingface.co/api/spaces/{repo}/runtime", headers)
            hardware = runtime.get("hardware") or {}
            current = hardware.get("current") or hardware.get("requested")
            spaces.append(dict(repo=repo, stage=runtime.get("stage"), hardware=current,
                hourly_compute_usd=0 if current == "cpu-basic" else None))
        except HTTPError as error:
            if error.code != 404:
                raise
            spaces.append(dict(repo=repo, stage="not deployed", hardware=None, hourly_compute_usd=None))
    return dict(spaces=spaces, scope="Configured latent-craft Spaces only",
        note="Runtime is read from the Hub control plane; no Space wakeups. CPU Basic compute is free. Account invoices, storage and unrelated HF services are not included.")


def point_value(point):
    value = point.get("value", {})
    for key in ("int64Value", "doubleValue"):
        if key in value:
            return float(value[key])
    raise ValueError("Unexpected metric value")


def summarize_metrics(series, gauge=False):
    """Daily gauges are snapshots, not a mean aligned to the query end time."""
    latest_by_series, points = {}, []
    for item in series:
        identity = json.dumps([item.get("metric"), item.get("resource")], sort_keys=True)
        for point in item.get("points", []):
            points.append(point)
            previous = latest_by_series.get(identity)
            if previous is None or point["interval"]["endTime"] > previous["interval"]["endTime"]:
                latest_by_series[identity] = point
    selected = list(latest_by_series.values()) if gauge else points
    if not selected:
        return dict(value=None, observed_at=None, oldest_sample_at=None)
    times = [p["interval"]["endTime"] for p in selected]
    return dict(value=sum(point_value(p) for p in selected), observed_at=max(times), oldest_sample_at=min(times))


def collect_gcp(cli, project, bucket):
    token = command([cli, "auth", "print-access-token"]).strip()
    headers = {"Authorization": "Bearer " + token, "x-goog-user-project": project}
    now = datetime.now(UTC)
    def metric(kind, gauge=False):
        # Align deltas to UTC hours, not a moving query-end offset that can
        # drop a different partial first hour on every poll.
        end = now if gauge else now.replace(minute=0, second=0, microsecond=0)
        query = {
            "filter": f'metric.type="storage.googleapis.com/{kind}" AND resource.type="gcs_bucket" AND resource.labels.bucket_name="{bucket}"',
            "interval.startTime": stamp(now-timedelta(days=3) if gauge else month_start(now)),
            "interval.endTime": stamp(end), "pageSize": 1000,
        }
        if not gauge:
            query.update({"aggregation.alignmentPeriod": "3600s", "aggregation.perSeriesAligner": "ALIGN_SUM",
                "aggregation.crossSeriesReducer": "REDUCE_SUM"})
        series = []
        for _ in range(8):
            value = fetch_json(f"https://monitoring.googleapis.com/v3/projects/{project}/timeSeries?" + urlencode(query), headers)
            series.extend(value.get("timeSeries", []))
            if not value.get("nextPageToken"):
                break
            query["pageToken"] = value["nextPageToken"]
        else:
            raise ValueError("GCP metric result exceeded dashboard bound")
        return summarize_metrics(series, gauge)
    specs = [("storage/total_bytes", True), ("storage/object_count", True), ("network/sent_bytes_count", False), ("api/request_count", False)]
    with ThreadPoolExecutor(max_workers=4) as pool:
        values = list(pool.map(lambda spec: metric(*spec), specs))
    return dict(bucket=bucket, project=project, storage_bytes=values[0], objects=values[1], sent_bytes=values[2], requests=values[3],
        scope=f"Cloud Monitoring: {bucket} bucket, all projects/destinations served by that bucket",
        billed_usd=None, note="Bytes sent are not the same as billable Internet egress. Storage is the latest reported gauge; traffic is month-to-date through the last complete UTC hour. Billing-export data is not connected; no zero-cost assumption.")


def collect_r2():
    path = Path.home() / ".config/latent-craft/r2.json"
    if not path.exists():
        return dict(connection="setup required", scope="R2 bucket", note="Create the account/bucket, then run the private credential prompt. Nothing has been uploaded.")
    if path.stat().st_mode & 0o077:
        raise ValueError("R2 configuration must have private file permissions")
    config = json.loads(path.read_text())
    if not config.get("analytics_token"):
        return dict(connection="analytics token required", bucket=config["bucket"], note="The S3 upload key is separate from Account Analytics Read. No metrics are assumed to be zero.")
    now = datetime.now(UTC)
    query = '''query Usage($account: string!, $bucket: string, $start: Time, $recent: Time, $end: Time) {
      viewer { accounts(filter: {accountTag: $account}) {
        operations: r2OperationsAdaptiveGroups(limit: 10000, filter: {bucketName: $bucket, datetime_geq: $start, datetime_leq: $end}) {
          sum {requests} dimensions {actionType actionStatus}
        }
        storage: r2StorageAdaptiveGroups(limit: 1, filter: {bucketName: $bucket, datetime_geq: $recent, datetime_leq: $end}, orderBy: [datetime_DESC]) {
          max {objectCount uploadCount payloadSize metadataSize} dimensions {datetime}
        }
      }}
    }'''
    value = fetch_json("https://api.cloudflare.com/client/v4/graphql",
        {"Authorization": "Bearer " + config["analytics_token"], "Content-Type": "application/json"},
        {"query": query, "variables": {"account": config["account_id"], "bucket": config["bucket"],
            "start": stamp(month_start(now)), "recent": stamp(now-timedelta(days=1)), "end": stamp(now)}})
    if value.get("errors"):
        raise RuntimeError("Cloudflare Analytics returned an error; check Account Analytics Read permission")
    accounts = value["data"]["viewer"]["accounts"]
    if not accounts:
        raise ValueError("No accessible Cloudflare account")
    data = accounts[0]
    if len(data["operations"]) >= 10000:
        raise ValueError("R2 operations need pagination before totals can be shown")
    return dict(connection="connected", bucket=config["bucket"], operations=data["operations"], storage=data["storage"],
        scope="R2 origin operations and storage for the configured bucket",
        note="Cloudflare adaptive analytics, not an invoice. CDN cache hits are not R2 origin operations. HeadObject userError includes expected missing-object checks before uploads, not just permission errors. Free allowances are account-wide; no whole-account total is inferred from one bucket.")


def allowed_request(client, host):
    try:
        address = ipaddress.ip_address(client)
        name = urlsplit("//" + host).hostname
        if name in ("gsv.local", "localhost"):
            return address.is_private or address.is_loopback
        return (address.is_private or address.is_loopback) and ipaddress.ip_address(name).is_private
    except (ValueError, TypeError):
        return False


def local_progress(path):
    try:
        if path.stat().st_size > 1024**2:
            raise ValueError("Progress file exceeds bound")
        value = json.loads(path.read_text())
        age = max(0, time.time() - path.stat().st_mtime)
        value.update(progress_age_seconds=round(age), stale=age > 120 and value.get("state") not in ("complete", "failed", "not started"))
        return value
    except FileNotFoundError:
        return {"state": "not started"}
    except (ValueError, OSError):
        return {"state": "status unavailable", "stale": True}


class Dashboard:
    def __init__(self, args):
        self.args = args
        self.lock = threading.Lock()
        self.providers = {}
        args.state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(args.state_dir, 0o700)
        self.database = args.state_dir / "usage.sqlite"

    def poll(self):
        with sqlite3.connect(self.database) as db:
            db.execute("CREATE TABLE IF NOT EXISTS snapshots (at REAL, provider TEXT, payload TEXT)")
            db.execute("CREATE INDEX IF NOT EXISTS snapshots_at ON snapshots(at)")
            os.chmod(self.database, 0o600)
            while True:
                calls = {"modal": lambda: collect_modal(self.args.modal), "hf": lambda: collect_hf(self.args.spaces),
                    "gcp": lambda: collect_gcp(self.args.gcloud, self.args.gcp_project, self.args.gcp_bucket), "r2": collect_r2}
                def collect(item):
                    provider, call = item
                    try:
                        return provider, dict(state="ok", checked_at=stamp(), data=call())
                    except Exception as error:
                        return provider, dict(state="unavailable", checked_at=stamp(), error=f"{type(error).__name__}" + (f" ({error.code})" if isinstance(error, HTTPError) else ""))
                with ThreadPoolExecutor(max_workers=4) as pool:
                    for provider, result in pool.map(collect, calls.items()):
                        with self.lock:
                            previous = self.providers.get(provider, {})
                            if result["state"] == "unavailable" and "data" in previous:
                                result["data"] = previous["data"]
                                result["last_success_at"] = previous.get("last_success_at", previous["checked_at"])
                            self.providers[provider] = result
                        db.execute("INSERT INTO snapshots VALUES (?, ?, ?)", (time.time(), provider, json.dumps(result)))
                # Local history is bounded; provider receipts and credentials are never public repo files.
                db.execute("DELETE FROM snapshots WHERE at < ?", (time.time()-31*86400,))
                db.commit()
                time.sleep(self.args.interval)

    def snapshot(self):
        with self.lock:
            value = dict(at=stamp(), providers=dict(self.providers), refresh_seconds=self.args.interval)
        for key, filename in (("build", "progress.json"), ("upload", "upload-progress.json")):
            path = self.args.thumbnail_release / filename
            value[key] = local_progress(path)
        value["static_upload"] = local_progress(self.args.static_upload_status)
        value["deployment"] = local_progress(self.args.deployment_status)
        return value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=5310)
    parser.add_argument("--bind", default="127.0.0.1")
    parser.add_argument("--interval", type=int, default=900)
    parser.add_argument("--gcloud", default=str(Path.home() / "google-cloud-sdk/bin/gcloud"))
    parser.add_argument("--modal", default=str(Path.home() / ".local/bin/modal"))
    parser.add_argument("--gcp-project", default="enjasets")
    parser.add_argument("--gcp-bucket", default="fun-data")
    parser.add_argument("--spaces", nargs="+", default=["enjalot/latent-craft-bl", "enjalot/latent-craft-monet"])
    parser.add_argument("--state-dir", type=Path, default=Path("/data/latent-craft/ops/state"))
    parser.add_argument("--thumbnail-release", type=Path, default=Path("/data/latent-craft/releases/monet-thumbs128-20260908a"))
    parser.add_argument("--static-upload-status", type=Path, default=Path("/data/latent-craft/ops/monet-static-upload.json"))
    parser.add_argument("--deployment-status", type=Path, default=Path("/data/latent-craft/ops/monet-deployment.json"))
    args = parser.parse_args()
    if args.interval < 300:
        raise ValueError("Provider polls must be at least five minutes apart")
    dashboard = Dashboard(args)
    threading.Thread(target=dashboard.poll, daemon=True).start()
    assets = {"/": ("dashboard.html", "text/html"), "/dashboard.js": ("dashboard.js", "text/javascript"), "/dashboard.css": ("dashboard.css", "text/css")}
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            if not allowed_request(self.client_address[0], self.headers.get("Host", "")):
                self.send_error(403); return
            path = urlsplit(self.path).path
            if path == "/api/status":
                payload, content_type = json.dumps(dashboard.snapshot()).encode(), "application/json"
            elif path in assets:
                filename, content_type = assets[path]
                payload = (HERE / filename).read_bytes()
            else:
                self.send_error(404); return
            self.send_response(200)
            self.send_header("Content-Type", content_type + "; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'")
            self.end_headers()
            self.wfile.write(payload)
        def log_message(self, *_args):
            pass
    print(f"Read-only dashboard on {args.bind}:{args.port}; credentials remain server-side", flush=True)
    ThreadingHTTPServer((args.bind, args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
