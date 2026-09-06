# Text navigation: projection versus retrieval

Local prototype, September 6, 2026. Open [the comparison map](http://gsv.local:5300/?dataset=monet-clip-basemap-training-512&query=a%20red%20sports%20car).

The new panel below Settings has two actions for the same prompt:

- **Project & fly:** CLIP text embedding → trained 2D/3D basemap heads → fly toward the predicted 3D position. A cyan marker shows the prediction; the minimap marks the 2D prediction. No vector index is loaded or queried by this action, and the position is not snapped to occupied space.
- **Search images:** the same normalized text embedding → exact cosine retrieval of 24 images. Hover a thumbnail to highlight its voxel and aim the camera without moving; click to fly closer. The block gets that result's sharp image, even when its usual atlas representative is a different image. Clicking the scene clears the search highlight and returns to normal exploration.

This comparison uses **2,008,321 images**, dataset `monet-clip-basemap-training-512`, release `monet-clip-basemap-training-20260905a`. It does not query the publisher's 103.8M-image IVFPQ index. An exact FAISS `IndexFlatIP` is a useful local baseline because approximation and out-of-subset results cannot explain differences between the two experiences. Existing dataset defaults are unchanged; unsupported datasets link to this map.

## Is projection cheaper?

Yes in incremental resources: projection needs only fixed-size models, not a growing image-vector index. With these same heads, 100M mapped images do not make a single text projection more expensive. This does **not** remove the map's voxel/chunk/thumbnail assets or their CDN transfer costs. Flying to a new region still streams those assets.

| Resource | Projection path | Optional exact retrieval baseline |
| --- | ---: | ---: |
| CLIP text encoder weights, float32 | 242 MiB | shared |
| Both 2D and 3D projection heads | 92 MiB | shared for comparison |
| Image-vector index payload in RAM | none | 3.83 GiB for 2.01M rows |
| Additional persisted search index | none | none; rebuilt from existing source vectors |

These are tensor/index payloads, **not total process RAM or current checkpoint download size**. Python, PyTorch, temporary tensors and index-building buffers add memory. The current cached CLIP checkpoint includes the unused image tower; a production text-only export would avoid distributing it. A 3D-only service would need one approximately 46 MiB head instead of two, bringing combined float32 weight payload to about 288 MiB.

The local comparison server validates map lookup records and reads training-vector samples on startup. That is a correctness guard for this experiment, not a requirement for an eventual standalone projection service. The projection request itself never scans image vectors. First search builds its index asynchronously with progress shown in the panel; once built it stays resident until server restart. Projection still does not consult it.

For scale intuition, this *exact float32 baseline* would require `N × 512 × 4` bytes: 38.15 GiB at 20M or 190.73 GiB at 100M. Those are not recommendations or estimates for compressed ANN. The existing publisher's 103.8M IVFPQ64 index is only about 6.97 GiB on disk; see [the hosting investigation](clip-search-hosting-review.md). Projection eliminates that index too, but cannot necessarily reduce an already-free HF CPU instance's monthly hardware bill below zero. No cloud services were provisioned for this prototype.

## Local timings

Measured on the shared Ryzen 9950X CPU host, two inference/FAISS threads. Twelve sequential prompt pairs, projection first then search; the second action reuses the cached text embedding. Research jobs and a browser check were also active, so this is a small exploratory sample, not an isolated benchmark or latency guarantee. [Raw measurements](benchmarks/text-navigation-20260906.json).

| Server stage | Median | p95 |
| --- | ---: | ---: |
| Text encoding, uncached | 28.2 ms | 67.9 ms |
| Both projection heads | 5.7 ms | 9.9 ms |
| Full project request | 34.8 ms | 74.0 ms |
| Exact 2.01M search stage alone | 133.3 ms | 173.7 ms |
| Full search request, **cached text embedding** | 146.2 ms | 184.4 ms |

Do not treat the last two full-request rows as matched cold-query timings: search skips encoding in this paired run. The panel distinguishes server stages from browser elapsed time and marks cached embeddings. Network, thumbnail loading, chunk streaming and camera animation are outside the server measurements.

## What to look for when comparing

Try a red sports car, a dog playing in snow, a plate of pasta, and a blue ceramic bowl. Look at whether direct projection lands among recognizable matches, how much empty space surrounds the marker, and how dispersed the actual top search results are.

For “a red sports car,” the direct prediction and the top retrieved image landed in visibly different neighborhoods; the prediction was much sparser. This can be a real limitation, not a coordinate bug: the heads were trained on **image** embeddings. CLIP text and image embeddings can occupy different regions despite sharing a similarity space ([Liang et al., *Mind the Gap*, 2022](https://arxiv.org/abs/2203.02053)). It is therefore plausible that the image-trained head generalizes poorly to some text inputs; this observation alone does not establish the cause of each bad landing. Projection is navigation, not a promise of nearest-neighbor retrieval.

The prototype deliberately does not snap predictions to the nearest occupied voxel or secretly retrieve a destination. Out-of-frame predictions are flagged rather than clamped. If projection-only quality is insufficient, a later experiment could compare a small landmark index or a text-calibrated head, but neither is implemented here.

## Identity and lifecycle checks

Both modes use cached `openai/clip-vit-base-patch32` and normalized 512-dimensional embeddings. The configured cache snapshot is `3d74acf9a28c67741b2f4f2ea7635f0aaf6f0268`. Startup checks the release, 512-grid/16-voxel chunk layout, lookup lengths and **every row's packed source identity** against training-shard order. Search IDs are local training rows, not publisher index IDs.

Both head checkpoints must reproduce 64 sampled training coordinates within `1e-3`; observed maximum absolute error was `7.63e-6`. The coordinate files must match the published provenance SHA-256 hashes. Projection uses the published fixed frame, never a query-fitted extent. Search uses published row-to-voxel and thumbnail records. Editing the query, clearing, or unloading the panel aborts pending work and rejects stale responses even when an underlying fetch ignores cancellation.

## Run locally

From this repository, using the existing sibling inference environment:

```bash
/home/enjalot/code/latent-basemap/.venv/bin/python pipeline/scripts/search_compare_server.py
```

The API binds only `127.0.0.1:8803`. The existing Vite frontend proxies `/api/explore` there; override with `LSV_SEARCH_PROXY_TARGET` if needed. Keep the existing data/thumbnail server running. This is a local research service, not a production deployment recipe. Paths can be overridden with the server's `--help` options. Required model/data artifacts must already exist; the server does not download models or modify research outputs.

```bash
curl http://127.0.0.1:8803/api/explore/status
/home/enjalot/code/latent-basemap/.venv/bin/python pipeline/scripts/benchmark_search_compare.py --out /tmp/text-navigation.json
PYTHONPATH=pipeline/src /home/enjalot/code/latent-basemap/.venv/bin/python -m pytest pipeline/tests -q
```

Tests cover frame/outlier handling, request validation, exact cosine ordering, source identity rejection, lazy index isolation, stale-response suppression, explicit search-image selection support and camera standoff. A focused browser check verified both actions, 24 loaded thumbnails, hover without translation, click-to-fly, the exact searched-row sharp preview, and no JavaScript/WebGL errors. No full e2e suite was added.
