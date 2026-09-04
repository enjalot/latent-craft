from __future__ import annotations

import io
from types import SimpleNamespace

import numpy as np
from PIL import Image

from lsvoxel.chunkpack import atlas


class SolidThumbnailSource:
    def __init__(self, colors):
        self.colors = colors

    def open(self, row_id: int) -> bytes:
        color = self.colors.get(row_id)
        if color is None:
            return b""
        buffer = io.BytesIO()
        Image.new("RGB", (8, 5), color).save(buffer, format="PNG")
        return buffer.getvalue()


def test_compact_atlas_uses_smallest_power_of_two_and_occupied_order():
    source = SolidThumbnailSource({10: (255, 0, 0), 20: (0, 255, 0), 30: (0, 0, 255)})
    image, blanks, side = atlas.build_compact_chunk_atlas_png(
        np.array([1, 100, 4095], dtype=np.uint16),
        np.array([10, 20, 30], dtype=np.uint32),
        source,
        tile_px=4,
        max_atlas_px=256,
    )

    assert side == 2
    assert image.size == (8, 8)
    assert blanks == 0
    assert image.getpixel((1, 1)) == (255, 0, 0)
    assert image.getpixel((5, 1)) == (0, 255, 0)
    assert image.getpixel((1, 5)) == (0, 0, 255)
    assert image.getpixel((5, 5)) == atlas.BACKGROUND_RGB


def test_compact_atlas_counts_missing_representatives():
    image, blanks, side = atlas.build_compact_chunk_atlas_png(
        np.array([12], dtype=np.uint16),
        np.array([99], dtype=np.uint32),
        SolidThumbnailSource({}),
        tile_px=4,
        max_atlas_px=256,
    )
    assert side == 1
    assert blanks == 1
    assert image.getpixel((0, 0)) == atlas.BACKGROUND_RGB


def test_ktx_encoder_does_not_request_unused_mipmaps(tmp_path, monkeypatch):
    png = tmp_path / "atlas.png"
    out = tmp_path / "atlas.ktx2"
    Image.new("RGB", (4, 4), (1, 2, 3)).save(png)
    seen = []

    monkeypatch.setattr(atlas.shutil, "which", lambda _: "/fake/basisu")

    def fake_run(command, **_kwargs):
        seen.append(command)
        out.write_bytes(b"ktx2")
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr(atlas.subprocess, "run", fake_run)
    atlas.encode_ktx2(png, out)

    assert seen and "-mipmap" not in seen[0]
