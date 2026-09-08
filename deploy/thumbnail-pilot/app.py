"""Small scale-to-zero Modal pilot. Deploy only after uploading verified samples."""
from pathlib import Path
import modal

HERE = Path(__file__).resolve().parent
app = modal.App("latent-craft-thumbnail-pilot")
volume = modal.Volume.from_name("latent-craft-thumbnail-pilot")
image = (modal.Image.debian_slim(python_version="3.12")
    .pip_install("fastapi==0.135.1")
    .add_local_file(HERE / "server.py", "/root/thumb_server.py"))


@app.function(image=image, cpu=(0.25, 1), memory=(512, 768), region="us", min_containers=0,
    max_containers=1, scaledown_window=60, timeout=30, volumes={"/data": volume.read_only()})
@modal.concurrent(max_inputs=32)
@modal.asgi_app()
def thumbnails():
    from thumb_server import create_app
    return create_app(Path("/data/pilot-20260908"))
