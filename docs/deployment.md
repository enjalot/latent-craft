# Deploying the British Library profile

The frontend, text-search service, and visual assets have separate lifetimes.
The HF Docker Space serves the compiled app and a CPU search worker. Immutable
map packs and packed thumbnails are served directly from GCS with byte ranges.
Ordinary thumbnail display does not proxy image bytes through the search worker.

## Build the frontend

From `frontend/`:

```bash
npm ci
VITE_DEMO_DATASET=bl-160 \
VITE_DATA_ORIGIN=https://storage.googleapis.com/fun-data/latent-craft/bl/20260907a \
VITE_THUMBS_ORIGIN='' \
VITE_THUMB_PACK_URL=https://storage.googleapis.com/fun-data/latent-craft/bl/20260907a/thumbs/bl/manifest.json \
npm run build
```

Use the same environment with `npm run dev -- --port 5303 --strictPort` for local
preview. Vite binds to the LAN. `/api/bl` proxies to port 8804 by default; set
`LSV_BL_SEARCH_PROXY_TARGET` to use a different worker. The generic frontend
defaults to MONET and uses `LSV_DATA_PROXY_TARGET` for its local data service.

## Search worker

`deploy/bl-space/Dockerfile` pins the CPU runtime dependencies. The worker
downloads files listed in `deploy/bl-space/assets.json` from an immutable Hub
commit and verifies byte lengths and SHA-256 before loading them. Keep model,
index, map identity arrays, and release identifiers aligned.

The BL production worker serves FAISS SQ8 only. Lance remains in the experiment
archive but is not installed, downloaded, or opened by the Space. The active
search bundle is about 4.14 GB; memory-mapped inverted lists and OS page cache
do not imply a fixed total-RAM limit.

Book metadata and filters use a separately pinned 313 MB read-only SQLite file
listed in `deploy/bl-space/metadata.json`. The publisher stages the shared
`pipeline/metadata_server.py` implementation. SQLite belongs to one worker
thread, has a 16 MiB page cache, and rejects concurrent work instead of building
an unbounded queue. Filters retry automatically while metadata warms.

For a local worker, set `LC_STATIC_ROOT` to the absolute frontend build directory
and `LC_SEARCH_ROOT` to an artifact cache, then run:

```bash
uvicorn app:app --app-dir deploy/bl-space --host 127.0.0.1 --port 8804 --workers 1
```

The standalone thumbnail fallback also requires `thumbs/manifest.json` and each
subset's `offsets.bin` beside the worker. The publication script stages these.
It currently expects the packaged BL release under its configured local data
path; inspect that path before using the script on a new machine.

To run directly from this checkout, include `pipeline` on `PYTHONPATH` so the
metadata module can be imported. `LC_METADATA_PATH` can select an existing
verified metadata file; its checksum and map identity must still match the pin.

## Static-serving contract

- Preserve byte offsets: do not dynamically recompress binary pack/blob files.
- Honor byte Range requests with exact `206`, `Content-Range`, and `Content-Length`.
- Configure CORS for the frontend origin and expose those response headers.
- Give each visual release a new immutable prefix. Never overwrite objects that
  clients may cache independently.
- Store large search artifacts on the server, not in frontend public assets.
- Keep credentials out of all `VITE_*` values and uploaded files.

The client rejects a `200` response to a range request instead of downloading
the whole object. GCS is the object-storage origin; this deployment does not
require a separate Cloud CDN load balancer. Persistent worker storage is optional;
an empty cache requires artifact download and model warmup.

## Publication

Build and verify locally before running `pipeline/scripts/publish_bl_space.py`.
That command performs external writes to the selected HF Space. Its explicit
staging list includes the runtime, frontend build, licenses, and thumbnail lookup
files, not the repository history or arbitrary local files. Use `--search-assets`
only for a new verified artifact bundle; use fresh immutable IDs for data changes.

Keep dataset/model attribution and historical-content notices in the application
and Space card. Dataset images, model weights, dependencies, and project source
have distinct license/provenance records; do not imply a blanket license for the
mixed deployment. See [dataset provenance](dataset-provenance.md).

For the full-corpus CLIP profile, see [MONET disk-search deployment](monet-demo.md).
