import json
import os
from pathlib import Path
import sys
import time

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "ops"))
from cloudflare_setup import import_connection, read_credentials
import cloudflare_setup
from configure_r2 import save_config
from usage_dashboard import allowed_request, local_progress, modal_summary, summarize_metrics
from publish_when_ready import prerequisites, sha, verify_snapshot
import publish_when_ready


def credentials():
    return dict(account_id="a"*32, bucket="latent-craft", access_key_id="b"*32, secret_access_key="c"*64)


def test_private_storage_and_validation(tmp_path):
    path = tmp_path / "config" / "r2.json"
    value = credentials()
    save_config(path, value)
    assert path.stat().st_mode & 0o777 == 0o600
    assert path.parent.stat().st_mode & 0o777 == 0o700
    with pytest.raises(ValueError):
        save_config(path, {**value, "public_origin": "https://secret:password@example.com"})
    assert json.loads(path.read_text()) == value


def test_env_reader_does_not_execute_shell_or_import_other_keys(tmp_path):
    path = tmp_path / ".env"
    path.write_text('export CLOUDFLARE_ACCOUNT="' + 'a'*32 + '" # account\nCLOUDFLARE_TOKEN=\'$(not-a-command)\'\nUNRELATED_KEY=secret\n')
    value = read_credentials(path)
    assert value == {"CLOUDFLARE_ACCOUNT": "a"*32, "CLOUDFLARE_TOKEN": "$(not-a-command)"}


def test_repeat_setup_preserves_bucket_scoped_credentials():
    old = {**credentials(), "publisher_token_id": "b"*32, "analytics_token": "read-only"}
    incoming = {"CLOUDFLARE_ACCOUNT": "a"*32, "CLOUDFLARE_ACCESS_KEY_ID": "d"*32, "CLOUDFLARE_SECRET_ACCESS_KEY": "e"*64}
    assert import_connection(old, incoming, "latent-craft") == old
    with pytest.raises(ValueError, match="another target"):
        import_connection(old, incoming, "different-bucket")


def test_modal_decimal_cost_is_not_rounded_before_aggregation():
    result = modal_summary([{"Description": "app", "Cost": ".00004"}] * 10)
    assert result["gross_usd"] == .0004
    assert modal_summary([])["gross_usd"] == 0


def point(value, day):
    return {"interval": {"endTime": f"2026-09-{day:02d}T00:00:00Z"}, "value": {"int64Value": str(value)}}


def test_daily_storage_gauges_sum_latest_per_class_with_actual_timestamps():
    series = [{"metric": {"labels": {"storage_class": "standard"}}, "points": [point(20, 6), point(30, 7)]},
        {"metric": {"labels": {"storage_class": "nearline"}}, "points": [point(5, 5), point(8, 6)]}]
    result = summarize_metrics(series, gauge=True)
    assert result == dict(value=38, observed_at="2026-09-07T00:00:00Z", oldest_sample_at="2026-09-06T00:00:00Z")
    # A time series can span result pages; do not double-count it.
    assert summarize_metrics(series + [series[0]], gauge=True) == result
    assert summarize_metrics(series)["value"] == 63
    assert summarize_metrics([], gauge=True)["value"] is None


@pytest.mark.parametrize("client,host,allowed", [("127.0.0.1", "localhost:5310", True), ("192.168.1.30", "gsv.local:5310", True),
    ("192.168.1.30", "192.168.1.2:5310", True), ("192.168.1.30", "evil.test:5310", False),
    ("8.8.8.8", "gsv.local", False), ("192.168.1.30", "gsv.local.attacker.test", False), ("::1", "[::1]:5310", True)])
def test_lan_access_and_dns_rebinding_guard(client, host, allowed):
    assert allowed_request(client, host) is allowed


def test_progress_never_confuses_missing_stale_or_failed_with_complete(tmp_path):
    path = tmp_path / "progress.json"
    assert local_progress(path)["state"] == "not started"
    path.write_text('{"state":"uploading"}')
    os.utime(path, (time.time()-300, time.time()-300))
    assert local_progress(path)["stale"]
    path.write_text('{"state":"complete"}')
    os.utime(path, (time.time()-300, time.time()-300))
    assert not local_progress(path)["stale"]
    path.write_text('invalid')
    assert local_progress(path)["state"] == "status unavailable"


def test_publication_waits_for_all_receipts_and_stops_on_failure(tmp_path):
    config = {"thumbnail_release": str(tmp_path), "static_status": str(tmp_path / "static.json")}
    assert not prerequisites(config)[0]
    (tmp_path / "progress.json").write_text(json.dumps(dict(state="complete", completed_rows=103816750, completed_shards=10880)))
    (tmp_path / "upload-progress.json").write_text(json.dumps(dict(state="complete", files_done=10, files_total=10, prefix="monet/thumbs/full-128-20260908a")))
    (tmp_path / "static.json").write_text(json.dumps(dict(state="uploading", files_done=3, files_total=8, prefix="monet/20260908b")))
    assert not prerequisites(config)[0]
    (tmp_path / "static.json").write_text(json.dumps(dict(state="complete", files_done=8, files_total=8, prefix="monet/20260908b")))
    assert prerequisites(config)[0]
    (tmp_path / "static.json").write_text('{"state":"failed"}')
    with pytest.raises(ValueError, match="failed"):
        prerequisites(config)


def test_frozen_publisher_cannot_silently_change_while_waiting(tmp_path):
    path = tmp_path / "app.py"
    path.write_text("approved code")
    config = dict(version=1, space="enjalot/latent-craft-monet", files=[dict(path="app.py", sha256=sha(path))], inputs=[])
    verify_snapshot(tmp_path, config)
    path.write_text("later work")
    with pytest.raises(ValueError, match="changed"):
        verify_snapshot(tmp_path, config)


def test_new_publication_waits_for_its_frontend_not_previous_healthy_space(tmp_path, monkeypatch):
    job = tmp_path / "new-job"
    (job / "frontend/dist").mkdir(parents=True)
    (job / "frontend/dist/index.html").write_bytes(b"new frontend")
    state = tmp_path / "deployment.json"
    state.write_text(json.dumps(dict(state="complete", job=str(tmp_path / "old-job"))))
    (job / "job.json").write_text(json.dumps(dict(state=str(state), search_assets="unused")))
    monkeypatch.setattr(publish_when_ready, "verify_snapshot", lambda *_: None)
    monkeypatch.setattr(publish_when_ready, "prerequisites", lambda *_: (True, "ready"))
    monkeypatch.setattr(publish_when_ready.time, "sleep", lambda *_: None)
    class Process:
        returncode = 0
        def poll(self): return 0
    monkeypatch.setattr(publish_when_ready.subprocess, "Popen", lambda *args, **kw: Process())
    requests = []
    responses = iter([b"old frontend", b"new frontend", b'{"state":"ready"}'])
    monkeypatch.setattr(publish_when_ready, "public_bytes", lambda path: requests.append(path) or next(responses))
    monkeypatch.setattr(publish_when_ready, "verify_search", lambda *_: dict(results_checked=24))
    publish_when_ready.run(job)
    assert requests == ["/", "/", "/api/monet/status"]
    assert json.loads(state.read_text())["state"] == "complete"
    with pytest.raises(ValueError, match="Already published"):
        publish_when_ready.run(job)


def test_large_range_bypass_is_exact_scoped_append_only_and_idempotent(monkeypatch):
    normal = {"id": "normal", "ref": "latent_craft_static_assets", "action_parameters": {"cache": True}}
    unrelated = {"id": "other", "ref": "another_site", "expression": 'http.host eq "elsewhere.test"'}
    entry = {"id": "ruleset", "rules": [unrelated, normal]}
    writes = []
    def api(_credentials, path, method="GET", data=None):
        if method == "GET": return {"success": True, "result": entry}
        assert method == "POST" and path == "/zones/zone/rulesets/ruleset/rules"
        writes.append(data)
        entry["rules"].append({**data, "id": "exception"})
        return {"success": True, "result": entry}
    monkeypatch.setattr(cloudflare_setup, "api", api)
    zones = [{"id": "zone", "name": "latent.download", "status": "active"}]
    for _ in range(2): cloudflare_setup.configure_large_ranges({}, "assets.latent.download", zones)
    assert len(writes) == 1
    rule = writes[0]
    assert rule["action_parameters"] == {"cache": False}
    assert 'http.host eq "assets.latent.download"' in rule["expression"]
    assert 'http.request.uri.path in {' in rule["expression"] and 'starts_with' not in rule["expression"]
    assert len(cloudflare_setup.LARGE_RANGE_PATHS) == 3
    assert entry["rules"][:2] == [unrelated, normal]
    entry["rules"][-1]["enabled"] = False
    with pytest.raises(ValueError, match="changed"):
        cloudflare_setup.configure_large_ranges({}, "assets.latent.download", zones)
