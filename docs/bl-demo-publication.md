# latent-craft: British Library demo publication

## Published pieces

- [HF Space](https://huggingface.co/spaces/enjalot/latent-craft-bl)
  ([direct app](https://enjalot-latent-craft-bl.hf.space/)): compiled BL-only UI,
  CPU text embedding/search, permanent-thumbnail fallback endpoint.
- [HF search artifacts](https://huggingface.co/datasets/enjalot/latent-craft-bl-search):
  7.885 GB of text-model, Lance/FAISS finalists and map identity arrays, loaded
  into the worker from a pinned Hub commit with per-file SHA-256 verification.
- GCS: `gs://fun-data/latent-craft/bl/20260907a`, 7,827,080,918 bytes of visual
  assets (plus the small release receipt), 1,655 files. This is a new prefix in
  the existing bucket; its IAM/CORS settings were not changed.

The local repository is `/home/enjalot/code/latent-craft`. The previous
`latent-scope-3d` path is a compatibility symlink; immutable data paths and saved
game identities were deliberately not mass-renamed. Package/browser names use
latent-craft. This repository has no GitHub remote yet. A permissive code license
still needs the owner's choice; publication of the Space does not by itself
make the reusable application an MIT/Apache-licensed open-source release.

## What lives where

| Component | Stored by | Loaded by / lifetime |
|---|---|---|
| Frontend JS, Basis transcoder, runtime app | Small HF Space repository / Docker image | Browser / page |
| Google text tower + tokenizer | Dedicated HF artifact dataset | Worker / warm process |
| FAISS SQ8 + Lance float16/SQ8 table | Dedicated HF artifact dataset | Worker local disk, bounded query caches / process |
| Compact atlases, occupied voxel metadata, hierarchy | GCS immutable release | Browser / nearby chunks and proxy working set |
| Packed WebP thumbnails | GCS immutable release | Browser / exact image byte ranges |
| Posting lists, row/voxel lookups, original URLs | GCS immutable release | Browser / paged or exact small reads |
| Mined inventory and settings | Browser localStorage / optional CSV | Per browser and dataset release |

Ordinary display thumbnails **do not pass through the search worker**. A subset
has one 8-byte offset/length record per image and blobs of 2,048 concatenated
WebPs. The browser requests the image's bytes, not the whole blob. Saved/exported
URLs stay permanent `/thumbs/bl/<subset>/<id>.webp` URLs, never temporary `blob:`
addresses. The Space endpoint resolves those permanent URLs using the same
packed offsets for fallback and CSV consumers. Original-image metadata is also
read directly from the static binary file; it does not require the old data server.

The GCS endpoint is a public object-storage origin with immutable cache headers;
we have **not** provisioned a separate Cloud CDN/load-balancer product. Anonymous
range requests were verified to return `206`, exact `Content-Range`/length, and
the CORS headers needed by the browser. Large files are never accepted as a
fallback response to a range request that unexpectedly returns `200`.

Search is one bounded request at a time: up to 400 characters, 64 model tokens,
24 results, a 128-entry text-query cache, and one worker process. Requests while
busy get a retryable message/429 rather than an unbounded queue. The UI polls
startup status while warming; map rendering/mining remain independent. The
index-cache budget is 512 MiB plus 32 MiB metadata, **not** total worker RSS.

The Space uses existing-account CPU Basic: **2 vCPU, 16 GB RAM, 50 GB ephemeral
runtime disk, $0 hourly compute**. No paid hardware or persistent volume was
requested. HF rejected the first attempt to put the 7.9 GB search bundle in the
Space repository with an explicit **1 GB repository limit**. The separate
artifact dataset resolves that limit; it is not a runtime-RAM problem.
[HF hardware documentation](https://huggingface.co/docs/hub/spaces-overview).

The live combined worker used 5.224 GB RSS after a 64-prompt/two-backend sweep.
Median uncached-phrase round trips were 425 ms (FAISS) and 648 ms (Lance).
See the [experiment](bl-search-experiment.md#actual-hf-cpu-basic-measurements)
for retrieval-only timings, percentiles and measurement limitations.

## Cost intuition

At standard US multi-region pricing, 7.29 GiB of visual assets is approximately
**$0.19/month at rest**. Internet transfer commonly starts at **$0.12/GiB**
(destination/allowances matter), and standard GET operations are about
**$0.40 per million**. The initial multi-region upload also has a small replication
charge. These are list-price calculations, not an invoice or a guarantee that
the account has no other costs. [GCS pricing](https://cloud.google.com/storage/pricing).

For intuition, 1,000 sessions each transferring 50 MiB of uncached visual assets
would be about 48.8 GiB, or **$5.86 transfer** before allowances, plus requests.
That is an example workload, not a measured average session. Client caching,
movement, high-resolution thumbnails and mining duration change it substantially.

The worker's 7.885 GB bundle comes from HF rather than GCS. Had it come from GCS,
a complete fresh download would be roughly **$0.88** at $0.12/GiB. Ephemeral
storage is not a persistence guarantee: a fresh worker may need the full download
and model warmup. Keeping all thumbnails on GCS while placing search artifacts
on HF avoids that repeated GCS transfer cost without sending vectors to browsers.

## Run the BL publication profile locally

```bash
cd frontend
VITE_DEMO_DATASET=bl-160 \
VITE_DATA_ORIGIN=https://storage.googleapis.com/fun-data/latent-craft/bl/20260907a \
VITE_THUMBS_ORIGIN='' \
VITE_THUMB_PACK_URL=https://storage.googleapis.com/fun-data/latent-craft/bl/20260907a/thumbs/bl/manifest.json \
npm run build
```

Run `deploy/bl-space/app.py` with Uvicorn, setting `LC_STATIC_ROOT` to that
absolute `frontend/dist` path. `LC_SEARCH_ROOT` selects the local artifact cache.
The checked-in `assets.json` pins the public verified bundle; startup downloads
missing files and serves the map immediately. See the Dockerfile for exact CPU
runtime dependencies. The local prototype uses port 8804, which Vite proxies
for `/api/bl`; ordinary non-demo development still defaults to MONET.

`package_bl_demo.py` produces visual release artifacts. `package_bl_search.py`
packages only the search finalists and text model, not the source vectors,
full exact-ground-truth index, failed configurations or local experiment logs.
`publish_bl_space.py` builds an explicit staging allowlist; it never uploads
the repository/history, credentials or arbitrary working-directory contents.
Use `--search-assets` only for a new verified bundle. A normal subsequent publish
reuses the pinned manifest. New visual/model releases should use new immutable
IDs, never overwrite old objects with year-long cache headers.

## BL versus MONET: the next separation to discuss

Do not fork the game engine into a BL-specific repository. A useful next boundary
is a dataset descriptor plus an independent visual theme:

- **Data descriptor:** dataset/map release, coordinates, static origins,
  thumbnail resolver, attribution, search endpoint/model and capabilities.
- **Theme:** semantic material palette, block-edge texture set, lighting/environment
  preset, skybox/environment asset, HUD CSS tokens and panel decorations.
- **Shared core:** streaming budgets, proxy hierarchy, voxel addressing, mining,
  inventory/save contracts, camera/navigation and search-result identity checks.
- **Demo deployment:** a small dataset whitelist and chosen descriptor/theme,
  compiled into the shared frontend, with a separate optional search service.

Wood grain borders and a wood skeuomorphic HUD belong to the theme; neither
should affect binary packs, inventory identity or retrieval configuration.
A British Library interior belongs to the environment preset, with appropriate
image rights/provenance or a clearly labeled generated interpretation. Keep it
separate from dataset geometry and provide a cheaper lighting/environment tier.
The existing HUD tokens are a starting point, not a completed theme API.

No wood/library skin or broad architectural refactor was implemented in this
experiment. Those choices remain the next discussion, as requested.

## Attribution, privacy, and verification

The visible About panel and Space card credit BL Labs, Daniel van Strien's
[dataset mirror](https://huggingface.co/datasets/biglam/british-library-book-images),
and Google's SigLIP 2 model. This is an independent demo, not an official BL
product. Public Domain Mark / no-known-restrictions image provenance and
Apache-2.0 model terms are documented separately. The complete Apache license
accompanies the exported model. The browser distribution includes
`THIRD_PARTY_NOTICES.txt` for Three.js, instanced-mesh, bvh.js and the Basis
transcoder. Historical content warnings are visible.

No credentials are embedded in the Docker image or frontend. Query history is
not intentionally persisted by the application; queries go to the worker.
GCS and original-image providers receive their corresponding network requests.
Inventory persists only in that browser unless the user exports it.

Verification emphasizes unit contracts and a small real-browser check, not a
large E2E suite: binary bounds/identity, thumbnail shard boundaries, cancellation,
static original-URL metadata, artifact checksum validation, input limits, and
search readiness. The live browser check covers map/atlas rendering, 24 search
thumbnails, hover/click navigation, mining and local saves using direct GCS ranges.
Software-rendered headless FPS is **not** a measurement of users' GPU performance.

Final unit runs passed **104 frontend tests** and **92 pipeline/runtime tests**;
TypeScript and the BL production build passed. The usual lightweight pipeline
environment skips optional tests when dependencies are absent; the full run used
the isolated search dependencies and exercised those tests too.
