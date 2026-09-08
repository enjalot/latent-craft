"""Bounded 128px WebP experiment, downsampled from existing 256px sources."""
import io
from PIL import Image


def resize_thumbnail(data: bytes, size=128) -> bytes:
    if size != 128: raise ValueError("Only the 128px experiment is supported")
    if not 0 < len(data) <= 1024**2: raise ValueError("Invalid thumbnail size")
    with Image.open(io.BytesIO(data)) as source:
        if max(source.size) > 256: raise ValueError("Expected an existing <=256px thumbnail")
        image = source.convert("RGB")
        image.thumbnail((size, size), Image.Resampling.LANCZOS)
        output = io.BytesIO()
        image.save(output, format="WEBP", quality=80, method=4)
        return output.getvalue()
