"""Small local fixtures only: no credentials, bucket, network or corpus required."""
import hashlib
import importlib.util
from pathlib import Path
import sys

import pytest

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))
from upload_thumbnail_release_r2 import checked_upload, load_connection


class FakeS3:
    def __init__(self, existing=None):
        self.object = existing
        self.puts = []

    def head_object(self, **kwargs):
        if self.object is None:
            from botocore.exceptions import ClientError
            raise ClientError({"Error": {"Code": "404"}}, "HeadObject")
        return self.object

    def put_object(self, **kwargs):
        self.puts.append(dict(kwargs, Body=kwargs["Body"].read()))
        self.object = {"ContentLength": kwargs["ContentLength"], "Metadata": kwargs["Metadata"]}


@pytest.fixture
def artifact(tmp_path):
    pytest.importorskip("botocore")
    path = tmp_path / "0000.blob"
    path.write_bytes(b"RIFF tiny test fixture")
    return path, hashlib.sha256(path.read_bytes()).hexdigest(), path.stat().st_size


def test_conditional_verified_range_safe_put_and_resume(artifact):
    path, digest, size = artifact
    client = FakeS3()
    assert checked_upload(client, "bucket", "release/0000.blob", path, digest, size) == "uploaded"
    put = client.puts[0]
    assert put["IfNoneMatch"] == "*"
    assert put["Body"] == path.read_bytes() and put["ContentLength"] == size
    assert put["ContentMD5"] and put["Metadata"] == {"sha256": digest}
    assert "no-transform" in put["CacheControl"] and "ContentEncoding" not in put
    assert checked_upload(client, "bucket", "release/0000.blob", path, digest, size) == "existing"
    assert len(client.puts) == 1


@pytest.mark.parametrize("bad", [{"ContentLength": 0}, {"Metadata": {"sha256": "other"}}, {"ContentEncoding": "gzip"}])
def test_never_overwrites_conflicting_remote_object(artifact, bad):
    path, digest, size = artifact
    client = FakeS3({"ContentLength": size, "Metadata": {"sha256": digest}, **bad})
    with pytest.raises(FileExistsError):
        checked_upload(client, "bucket", "release/file", path, digest, size)
    assert not client.puts


def test_local_corruption_stops_before_cloud_calls(artifact):
    path, digest, size = artifact
    path.write_bytes(b"different")
    with pytest.raises(ValueError, match="changed"):
        checked_upload(None, "bucket", "release/file", path, digest, size)


def test_reject_public_credentials_before_loading_s3(tmp_path):
    path = tmp_path / "credentials.json"
    path.write_text("{}")
    path.chmod(0o644)
    with pytest.raises(ValueError, match="private"):
        load_connection(path)


def test_pinned_hub_artifacts_require_exact_commit_and_release():
    pytest.importorskip("huggingface_hub")
    spec = importlib.util.spec_from_file_location("monet_publisher", SCRIPTS / "publish_monet_space.py")
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    manifest = {"files": [{"path": "index", "bytes": 5, "sha256": "ab" * 32}]}
    prefix = "https://huggingface.co/datasets/test/search/resolve/"
    module.validate_pinned({**manifest, "base_url": prefix + "a" * 40 + "/release"}, manifest, "test/search", "release")
    for suffix in ("main/release", "a" * 40 + "/different", "a" * 40 + "/release?download=true"):
        with pytest.raises(ValueError, match="immutable"):
            module.validate_pinned({**manifest, "base_url": prefix + suffix}, manifest, "test/search", "release")
