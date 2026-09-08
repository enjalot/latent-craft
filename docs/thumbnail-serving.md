# Thumbnail serving and source-resolution experiments

The production data format is independent of the HTTP host. MONET thumbnails
are packed WebP byte spans with `(rows + 1)` little-endian u64 offsets per source
shard. Preserve both source shard and row identity when making another size.
Never decompress/recompress blob objects in a range-serving proxy.

## Local 128px comparison

Run with the pipeline environment, including Pillow:

```bash
python pipeline/scripts/thumbnail_preview_server.py --port 8808
```

Vite proxies `/api/thumb-preview` to this loopback-only server. Add
`?thumbSize=128` to a development map URL or use Settings → Thumbnail source.
Choose 256px to restore the existing source. A reload retains the saved camera,
inventory and settings. The query flag and encoder control are disabled in
production builds; original-image links and CSV thumbnail identities never
change. Atlas faces remain 32px and nearby GPU preview textures remain 128px.

The encoder uses existing <=256px thumbnails, RGB, Lanczos, longest-side 128px,
WebP quality 80 and method 4. It preserves aspect ratio and never enlarges small
sources. Four encoding slots and a 512-image memory cache bound local work.
This adds another lossy encode; the comparison is not an original-image resize.

## Small Modal pilot

`deploy/thumbnail-pilot/app.py` mounts a dedicated Volume read-only and serves
pre-encoded files, without an ML model or image encoder. The deployment requests
0.25 physical core and 512 MiB, caps at one core/768 MiB/one container, accepts
32 concurrent inputs and scales to zero after a 60-second idle window. Region
selection is US. The app and Volume are named `latent-craft-thumbnail-pilot`.

Preparation and publication are deliberately separate:

```bash
python pipeline/scripts/prepare_thumbnail_pilot.py VERIFIED_THUMB_PACK NEW_PILOT_DIRECTORY --workers 4
python pipeline/scripts/upload_thumbnail_pilot.py NEW_PILOT_DIRECTORY
modal deploy deploy/thumbnail-pilot/app.py
python pipeline/scripts/benchmark_thumbnail_pilot.py ORIGIN NEW_PILOT_DIRECTORY/manifest.json RESULTS.json
```

The preparation tool picks eight source shards reproducibly, links original
files without rewriting them, and creates 128px siblings with the same row
order and missing-image spans. It refuses over 1 GiB of originals. The upload
tool checks file sizes/SHA-256, refuses over 2 GiB or twelve shards, and uploads
only the manifest's explicit files into `/pilot-20260908`. It is not a
full-corpus publisher. Use a fresh version/path for another pilot release.

HTTP endpoints:

- `GET /manifest.json`: sampled source IDs, sizes and checksums.
- `GET /health`: process RSS and container identity; this wakes a sleeping app.
- `GET /packs/{128|256}/{shard}.offsets.u64` or `.blob`: a single byte range,
  capped at 1 MiB. Returns 206 and an exact Content-Range. Whole-file GETs are
  refused; HEAD returns full file size without a body.
- `GET /thumbs/{128|256}/{packed_id}.webp`: resolves offsets in the worker and
  returns the image in one HTTP request, avoiding the two-step client lookup.

These are immutable pilot URLs, not the permanent inventory URLs used by the
production frontend. No upload/delete endpoint is exposed. A function's cold
start and a Volume/cache miss are separate latency sources. Keeping a container
warm addresses the former, not necessarily the latter. The benchmark records
both client time and in-worker read time and verifies every returned image.

Results live in [the measurement receipt](measurements/thumbnail-serving-20260908.json).
Interpret subsequent passes as cache-reusing, not independent hardware-cold
trials. Region/network path, browser multiplexing and a larger shard population
can change latency and throughput.

## Ongoing cost and cleanup

Check workspace-wide allowances before expanding storage. Included Volume
storage, monthly compute credits and included outbound traffic are different
budgets. See [Modal pricing](https://modal.com/pricing) and its
[egress policy](https://modal.com/docs/guide/network-egress-billing).

The pilot has no always-warm container. To disable serving, stop the dedicated
app in Modal. That retains its Volume. The sample Volume is about 0.80 GiB;
delete only that named Volume if its data is no longer wanted. Do not delete
pre-existing model caches or other data Volumes.
