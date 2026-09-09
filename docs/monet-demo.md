# MONET: full-corpus CLIP and disk FAISS

The `monet-clip-basemap-full-4m-512` profile contains 103,816,750 images,
projected with paired 4M-trained CLIP basemap heads. The [public Space](https://huggingface.co/spaces/enjalot/latent-craft-monet)
serves the UI and full-corpus disk search on CPU Basic; Cloudflare R2 serves
static assets and 128px thumbnails. The [search artifact bundle](https://huggingface.co/datasets/enjalot/latent-craft-monet-search)
is pinned separately. A cold worker downloads that bundle before search becomes
ready; the map can load meanwhile. [Open the app directly](https://enjalot-latent-craft-monet.hf.space/).

## Storage versus runtime

| Component | Logical stored bytes | Browser behavior |
| --- | ---: | --- |
| Compact 4M CLIP map, including atlases, hierarchy and spatial index | 3,923,972,996 | Nearby chunks, proxy bricks, byte ranges |
| Shared initial-pool original URL metadata | 1,887,424,406 | A record and URL only when needed |
| Shared full-corpus 128px WebP image bytes | 293,508,626,308 | One selected image range |
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

Visual origin:
`https://assets.latent.download/monet/20260908b`

Publish the compact pack under `chunks/`, the registered minimap under `minimap/`,
and the shared initial-pool `point_meta.bin` under its registered `points/` path.
The converted thumbnail manifest and `.blob` / `.offsets.u64` shards go under
`https://assets.latent.download/monet/thumbs/full-128-20260908a` once, not once per map.
Verify every upload's completion before exposing the app. Use immutable object
names, public range-capable CORS, and no dynamic compression of binary objects.
The R2 uploader skips gzip sidecars; Cloudflare may compress plain JSON but must
not transform ranged binary files. Source 256px files remain untouched locally.

The completed 128px thumbnail store plus offsets measures 294.34 GB (274.12 GiB),
compared with 829.2 GB (772.3 GiB) for the local 256px source. The static upload
plan adds 6,640,924,381 bytes for the CLIP pack, minimap and shared URL table.
Together that is roughly $4–5/month in R2 Standard storage, before requests;
the exact monthly charge depends on measured bytes, daily storage and account-wide
allowances. Three oversized index/metadata objects explicitly bypass CDN cache
to preserve first-touch byte ranges. R2 Internet egress is free; origin reads remain metered. This is
server-side storage, not a browser download. [R2 pricing](https://developers.cloudflare.com/r2/pricing/).

See [R2 publication and monitoring](r2-operations.md) for credential setup,
resumable conversion/upload commands and the completion-gated HF publisher.

Build after static assets are ready:

```bash
cd frontend
VITE_DEMO_DATASET=monet-clip-basemap-full-4m-512 \
VITE_DATA_ORIGIN=https://assets.latent.download/monet/20260908b \
VITE_THUMBS_ORIGIN='' \
VITE_MONET_THUMB_PACK_URL=https://assets.latent.download/monet/thumbs/full-128-20260908a/manifest.json \
npm run build
```

Keep `VITE_THUMBS_ORIGIN` explicitly empty: permanent `/thumbs/monet/<id>.webp`
URLs belong to the Space's resolver, while display bytes come directly from the
R2 thumbnail pack. The static map prefix has no individual WebP files. Preflight
rejects builds that omit this separation.

Then run `pipeline/scripts/publish_monet_space.py --search-assets /path/to/release`.
Add `--reuse-pinned-assets` to reuse an existing, locally verified `assets-hf.json`
without uploading its 9.1 GB bundle again. It must reference an immutable Hub commit.
It verifies the build profile, map identity and sampled public ranges before
creating/updating `enjalot/latent-craft-monet`. The script stages only the runtime,
compiled UI, thumbnail manifest and notices. Search artifacts are pinned in a
separate HF dataset, not baked into Docker layers. `--artifacts-only` uploads
that bundle without exposing a map whose static assets are not yet available.

No paid hardware is selected. After startup, verify the live status API,
anonymous search, direct thumbnail ranges, exact-result collection, and a mobile
consent/load check before linking the Space from the README.
