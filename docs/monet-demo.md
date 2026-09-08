# MONET: full-corpus CLIP and disk FAISS

The `monet-clip-basemap-full-4m-512` profile contains 103,816,750 images,
projected with paired 4M-trained CLIP basemap heads. Its compact map is audited
and its full-corpus search runs locally. The [search artifact bundle](https://huggingface.co/datasets/enjalot/latent-craft-monet-search)
is published. Public map deployment is pending publication of the shared static
thumbnail store; do not advertise a live MONET Space until that preflight passes.

## Storage versus runtime

| Component | Logical stored bytes | Browser behavior |
| --- | ---: | --- |
| Compact 4M CLIP map, including atlases, hierarchy and spatial index | 3,923,972,996 | Nearby chunks, proxy bricks, byte ranges |
| Shared initial-pool original URL metadata | 1,887,424,406 | A record and URL only when needed |
| Shared full-corpus WebP image bytes | 828,415,235,818 | One selected image range |
| Shared thumbnail u64 offsets | 830,621,040 | A 16-byte extent pair per cold image |
| Text-search worker bundle | 9,090,751,801 | Never loaded in browser |

The compact map is 1,042,287,473 bytes smaller than its original streaming pack.
Its 2,318,931 occupied voxels and 103.8M image identities are unchanged. Separate
CLIP and DINO maps reuse the same WebP store and original URL table. Original
URLs cover the initial 19.34M pool; other rows use thumbnail fallback.

Of the worker bundle, 7,483,751,844 bytes are the existing IVF4096/PQ64x8 index.
An additional 415,267,000-byte u32 table maps ANN IDs to map rows. Compact row
lookups and a 253,735,728-byte CLIP text tower complete the main runtime inputs.
These fit on CPU Basic's ephemeral disk; a fresh worker must download them again.

FAISS opens `OnDiskInvertedLists` with `IO_FLAG_MMAP | IO_FLAG_READ_ONLY`.
Two CPU threads, `nprobe=64`, 24 results, one admitted search and a 128-query
embedding cache bound application work. OS disk cache is reclaimable but is not
a fixed RAM limit. See [FAISS on-disk documentation](https://github.com/facebookresearch/faiss/wiki/Indexes-that-do-not-fit-in-RAM).

A local gsv 36-query check measured 35.3 ms median retrieval, 51.5 ms p95,
40.0 ms median HTTP round trip and 2.32 GB worker RSS after the sweep. The first
query took 50.9 ms retrieval after best-effort eviction of the task-owned index
copy's clean pages. This is neither guaranteed hardware-cold performance nor an
HF CPU Basic measurement. No global cache was dropped.

## Prepare search artifacts

Install the `monet-search` pipeline extras. The identity builder uses 8 GB of
DuckDB working memory and bounded disk scratch; it does not need the 200+ GB
float32 embedding matrix in RAM. Source ID extraction streams light shards.

```bash
pipeline/.venv/bin/python pipeline/scripts/build_monet_search_identity.py \
  --output /path/to/new-identity-release --scratch /path/to/new-scratch

pipeline/.venv/bin/python pipeline/scripts/package_monet_search.py \
  --identity /path/to/new-identity-release \
  --pack /path/to/compact-4m-clip-pack \
  --model /path/to/pinned-clip-model-cache \
  --output /path/to/new-search-release
```

The current builder uses the repository's existing `/data2/monet` substrate
layout; adapt those explicit input paths on another machine. Outputs must be
fresh directories. The publisher index and map rows are not in the same order.
Hash collisions are resolved with exact IVF/PQ code comparisons, followed by a
full permutation check; the packager refuses unresolved identities.

`deploy/monet-space/app.py` serves the same-origin `/api/monet` routes. For local
development, run one Uvicorn worker on port 8807 and set `LC_SEARCH_ROOT` to the
packaged release. Vite proxies the API. Missing models never block map rendering.

## Static publication and Space preflight

Expected visual origin:
`https://storage.googleapis.com/fun-data/latent-craft/monet/20260908b`

Publish the compact pack under `chunks/`, the registered minimap under `minimap/`,
and the shared initial-pool `point_meta.bin` under its registered `points/` path.
The thumbnail manifest and existing `.blob` / `.offsets.u64` shards go under
`gs://fun-data/latent-craft/monet/thumbs/full-20260908b` once, not once per map.
Verify every upload's completion before exposing the app. Use immutable object
names, public range-capable CORS, and no dynamic compression of binary objects.
JSON can use the prepared gzip sidecars with correct content-encoding headers.

The approximately 772.3 GiB shared thumbnail store is around $20/month at US
multi-region Standard list prices, plus about $16 initial replication and viewer
traffic (commonly $0.12/GiB, destination/allowance dependent). This is a storage
publication decision, not a browser download. [GCS pricing](https://cloud.google.com/storage/pricing).

Build after static assets are ready:

```bash
cd frontend
VITE_DEMO_DATASET=monet-clip-basemap-full-4m-512 \
VITE_DATA_ORIGIN=https://storage.googleapis.com/fun-data/latent-craft/monet/20260908b \
VITE_MONET_THUMB_PACK_URL=https://storage.googleapis.com/fun-data/latent-craft/monet/thumbs/full-20260908b/manifest.json \
npm run build
```

Then run `pipeline/scripts/publish_monet_space.py --search-assets /path/to/release`.
It verifies the build profile, map identity and sampled public ranges before
creating/updating `enjalot/latent-craft-monet`. The script stages only the runtime,
compiled UI, thumbnail manifest and notices. Search artifacts are pinned in a
separate HF dataset, not baked into Docker layers. `--artifacts-only` uploads
that bundle without exposing a map whose static assets are not yet available.

No paid hardware is selected. After startup, verify the live status API,
anonymous search, direct thumbnail ranges, exact-result collection, and a mobile
consent/load check before linking the Space from the README.
