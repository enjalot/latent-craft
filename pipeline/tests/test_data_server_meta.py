"""scripts/data_server.py's `/meta/<points_id>/<row_id>` route, exercised over HTTP
against the real handler on a temp root: JSON for a valid row, 404 for a missing
store / out-of-range row / malformed id, and the static tree still served."""
from __future__ import annotations

import importlib.util
import json
import threading
import urllib.error
import urllib.request
from functools import partial
from http.server import ThreadingHTTPServer
from pathlib import Path

import pytest

from lsvoxel.point_meta import write_point_meta

SERVER_PY = Path(__file__).resolve().parents[1] / "scripts" / "data_server.py"


def _load_server_module():
    spec = importlib.util.spec_from_file_location("data_server_under_test", SERVER_PY)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def server(tmp_path):
    root = tmp_path / "root"
    (root / "points" / "demo-1").mkdir(parents=True)
    (root / "hello.txt").write_text("static still works\n")
    write_point_meta(
        root / "points" / "demo-1" / "point_meta.bin",
        ["https://例え.テスト/画像.jpg", None, "http://farm4.staticflickr.com/x_o.jpg"],
        [640, 0, 1539],
        [480, 0, 2565],
    )
    module = _load_server_module()
    module.configure(str(root))
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), partial(module.CORSRequestHandler, directory=str(root)))
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{httpd.server_address[1]}"
    finally:
        httpd.shutdown()
        httpd.server_close()


def _get(url: str):
    try:
        with urllib.request.urlopen(url, timeout=5) as resp:
            return resp.status, resp.headers, resp.read()
    except urllib.error.HTTPError as err:
        return err.code, err.headers, err.read()


def test_command_line_help_documents_compatible_arguments():
    module = _load_server_module()
    help_text = module.build_parser().format_help()
    assert "[port] [root]" in help_text
    assert "--bind" in help_text
    assert module.build_parser().parse_args([]).port == 8802


def test_meta_route(server):
    status, headers, body = _get(f"{server}/meta/demo-1/0")
    assert status == 200
    assert headers["Content-Type"].startswith("application/json")
    assert headers["Access-Control-Allow-Origin"] == "*"
    assert json.loads(body) == {"row_id": 0, "url": "https://例え.テスト/画像.jpg", "width": 640, "height": 480}

    status, _, body = _get(f"{server}/meta/demo-1/1")
    assert status == 200 and json.loads(body) == {"row_id": 1, "url": None, "width": 0, "height": 0}

    status, _, body = _get(f"{server}/meta/demo-1/2?cache=bust")
    assert status == 200 and json.loads(body)["url"] == "http://farm4.staticflickr.com/x_o.jpg"

    assert _get(f"{server}/meta/demo-1/3")[0] == 404
    assert _get(f"{server}/meta/demo-1/1000000000")[0] == 404
    assert _get(f"{server}/meta/nope/0")[0] == 404
    # ids outside [a-z0-9-] don't match the route at all, so they fall to the static
    # tree (and 404 there) — nothing can be resolved outside points/
    assert _get(f"{server}/meta/../hello.txt/0")[0] == 404
    assert _get(f"{server}/meta/Demo_1/0")[0] == 404
    assert _get(f"{server}/meta/demo-1/x")[0] == 404

    status, _, body = _get(f"{server}/hello.txt")
    assert status == 200 and body == b"static still works\n"


def test_meta_route_reopens_after_a_rebuild(server, tmp_path):
    path = tmp_path / "root" / "points" / "demo-1" / "point_meta.bin"
    assert json.loads(_get(f"{server}/meta/demo-1/0")[2])["width"] == 640
    write_point_meta(path, ["https://new/0.jpg"], [1], [1])  # rename swaps the inode
    assert json.loads(_get(f"{server}/meta/demo-1/0")[2]) == {"row_id": 0, "url": "https://new/0.jpg", "width": 1, "height": 1}
    assert _get(f"{server}/meta/demo-1/1")[0] == 404
