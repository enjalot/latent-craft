# CLIP search and hosting — September 5, 2026

Research, local measurements and a disposable authenticated cloud pilot. No
search UI or permanent deployment is included; existing demos and bucket objects
are unchanged. Prices are USD, before tax and credits. Monthly estimates use
730 hours. Local and hosted measurements are reported separately.

## Recommendation

Use the existing Vite/WebGL app as a **static HF Space**, with a separately
addressed search API and object storage. This keeps map startup independent of
model/index startup and allows the same build to remain on GitHub Pages.
HF supports static build commands and does not require Gradio for this frontend.
[Static Spaces](https://huggingface.co/docs/hub/spaces-sdks-static).

For this personal demo, start the API on **HF CPU Basic**: the pilot below
successfully searched the full index on its 2 vCPU / 16 GB allocation. Use CPU
Upgrade when explicit sleep controls, more memory or measured sustained-load
headroom justify it: 8 vCPU / 32 GB for $0.03/hour, or $21.90/month always running.
The account is already Pro, so its subscription is an existing expense, not
another incremental $9. A GPU is not needed for the first version.
[HF pricing](https://huggingface.co/pricing).

Keep `fun-data` as the first asset origin because its current range/CORS behavior
is verified. HF Bucket storage is a serious alternative for the large image
payloads, but should win a browser range/cache benchmark before replacing it.
Do not send all atlas and image traffic through the inference container.

## What already exists

- MONET maps use normalized CLIP ViT-B/32, 512 dimensions. SSCD is the draw
  strategy, not the embedding used for these maps. British Library uses SigLIP 2
  and must not silently use a CLIP text encoder against its vectors.
- The 2M SSCD input is `/data2/monet/draws/sscd-clip.f32.npy`; the 19,344,847-row
  pool input is `/data2/monet/pool-20m/clip512.f32.npy`. The complement vectors
  are also present, making the full 103,816,750-row corpus available.
- A publisher-built **full-corpus** index is already local:
  `/data2/monet/retrieval-storage/clip/embedding_clip-vit-base-patch32.faiss`.
  Actual size **7,483,751,844 bytes / 6.970 GiB**, 103,816,750 rows, 512 dimensions,
  IVF4096/PQ64x8, inner-product metric, current nprobe 64. Its metadata records
  about 5,729 seconds of original index construction; not a new build estimate.
  [Published index](https://huggingface.co/buckets/jasperai/monet-retrieval-storage/tree/v1.2.0/clip).
- `latent-scope-frontend/pipeline/modal_api.py` already demonstrates CLIP text
  encoding + LanceDB on Modal, CPU=1, scale-to-zero, five-minute idle tail.
Reuse its experience, not its unrestricted model/database/query parameters
  or its potential ten-million-row response path.
- `MinimapBridge` already implements voxel highlighting and camera flight with
  destination prefetch; `FlightControls` has smooth look transitions. Search
  should share these mechanisms instead of introducing another camera owner.

### Identity is the main integration gate

FAISS IDs are **not automatically map row IDs**. The publisher's hash table has
103.8M `(row_id, hash_perceptual)` records; the companion index table has
`hash_perceptual`, `id`, and `local_path`. Our pool is assembled in a different
order, and a draw adds another permutation. Build and verify an explicit join
through stable source identity/provenance; audit duplicates and unmatched rows.
Do not assume a perceptual hash is globally unique.

A u32 index-ID → map-row mapping costs 396.03 MiB for the full corpus, including
an absent-row sentinel for subset maps. Alternatively, repack index lists for
each dataset, preserving the trained quantizer/PQ codes and remapping IDs.
Search must restrict membership *inside* retrieval or use a subset index:
fetching the global top 24 and dropping rows outside the 2M draw is not correct
subset search. Only about 1.9% of the global corpus is in that draw.

A read-only sample join confirmed this is a real issue, not just a precaution.
For "a red sports car", the first eight ANN hits each matched exactly one source
record in a scan of the publisher metadata. Only two had source shards in the
19.3M pool: ANN ID 83,269,456 maps to pool row 15,514,742, and ANN ID 1,338,958
maps to pool row 17,086,281. Both source paths matched our provenance arrays;
neither row belongs to the 2M SSCD draw. This validates the join route for these
eight examples, **not corpus-wide uniqueness or complete identity coverage**.

For the initial 2M map, there are two sensible accuracy/memory options: a subset
PQ64 index around 145 MiB, or IVF-Flat around 3.84 GiB, using the existing coarse
quantizer and original normalized vectors. IVF-Flat avoids PQ score distortion
but still misses neighbors outside the probed lists. Both fit CPU Basic in
principle; neither has been built or benchmarked for this review. Compare a
representative text-query suite against exact subset search before choosing.
At 103.8M, compressed retrieval becomes much more compelling. Optional exact
reranking of 128 candidates would read about 128 KiB of fp16 vectors per query,
but requires a separate roughly 99 GiB vector store and careful batched reads;
128 unrelated object requests could overwhelm the latency saved by ANN.

## Proposed interaction and API

`text → CLIP text encoder → dataset-scoped ANN → 24 result cards → existing map targeting`

- A search field with ~300 ms debounce, Enter for immediate submission, abort
  and generation tokens to reject stale results. Search pending state must not
  block flight, mining, rendering or dataset loading.
- Initially return 24 small thumbnails, with explicit load-more. Fetch previews
  at bounded concurrency and lazy-load offscreen results. Hover highlights the
  exact result in both maps and gently turns toward it; no movement on hover.
  Click flies to a close standoff and prefetches that chunk on the way.
- Standoff must exceed the current effector radius plus block clearance, or the
  destination image would be ghosted immediately on arrival. Pin the searched
  **row's** sharp preview while focused: the block's representative may be a
  different image in the same voxel.
- Request: dataset key + immutable release/index version + query + bounded k.
  Response: matching version, row ID, score, chunk/local voxel identity and
  packed thumbnail reference. No full embedding array or large metadata table
  in a normal response. Stage timings distinguish encoding, ANN and identity
  lookup from browser network/image time.
- Warm the encoder/index before readiness, normalize queries, enforce CLIP's
  token limit, and use `eval()`/inference mode. Load the **text tower only**:
  63,428,096 parameters, about 242 MiB fp32 weights, versus loading the image
  tower as well. One shared model/index per worker; multiple workers replicate
  the multi-GB index. Bound admission/concurrency, query length and k; allowlist
  datasets/models, rate-limit public requests and never expose cloud tokens.
- Cache normalized query results by model/index/dataset revision. On dataset
  changes, abort requests and clear incompatible cards/highlights.
- Keep corpus-to-map and thumbnail metadata in packed, indexed structures,
  with bounded page caches; do not load 103.8M Python string records into RAM.
  A multi-dataset service needs an explicit index residency budget as well:
  the measurements below cover one index, not every subset/release at once.

Browser-side CLIP remains possible later but adds roughly 63 MB int8 / 127 MB
fp16 text weights before runtime overhead, plus device variability and GPU
contention with WebGL. It removes text inference hosting, not the ANN backend.
The local CPU timing below makes it unnecessary for the first version.

## Measured local performance

Read-only benchmark on the shared AMD Ryzen 9 9950X machine. Twelve text prompts,
single-query top-24 retrieval, 36 encoder measurements and 24 searches per
configuration. Other research jobs remained running. Model files were already
cached. Temporary reproducer: `/tmp/lsv-search-bench.py`.

| Operation | Threads | Median | p95 |
| --- | ---: | ---: | ---: |
| Tokenize + encode + normalize | 2 | 18.05 ms | 28.70 ms |
| Tokenize + encode + normalize | 4 | 12.73 ms | 21.93 ms |
| Full 103.8M index, nprobe=16 | 2 | 9.63 ms | 18.84 ms |
| Full 103.8M index, nprobe=32 | 2 | 19.37 ms | 30.23 ms |
| Full 103.8M index, nprobe=64 | 2 | 39.67 ms | 51.68 ms |
| Full 103.8M index, nprobe=64 | 4 | 40.40 ms | 49.81 ms |

Index load from local disk took 6.52 s. Peak process RSS, including PyTorch and
the encoder, was 7.93 GiB; mappings and production API overhead are additional.
Text-model construction after imports took 0.25 s; neither timing includes a
fresh container, Python imports or downloading artifacts.

nprobe=16 retained 99.65% of the nprobe=64 top-24 IDs on these 12 prompts; nprobe=32
retained 100%. **This is not exact recall**, a broad relevance evaluation or proof
that 16 is sufficient. Keep 64 as the baseline until a larger text-query suite
compares against exact vectors, including subset membership and duplicate cases.

The sum of the two medians is roughly 58 ms, not an end-to-end latency statistic.
The hosted pilot below includes network RTT and queueing separately.
A sensible initial goal is warm browser-to-result p95 below 250–400 ms, measured
separately from thumbnail decode/display and the typing debounce.

## Hosted pilot methodology

Private HF Docker Spaces and an ephemeral, authenticated Modal development app
run the same FastAPI service. One process holds the complete 103,816,750-row
index and CLIP text tower. Both use CPU PyTorch 2.11.0, transformers 5.14.0,
FAISS 1.13.2, FastAPI 0.135.1 and uvicorn 0.41.0; base images and transitive
dependencies are not byte-identical. The model is pinned to revision
`3d74acf9a28c67741b2f4f2ea7635f0aaf6f0268`. Index metadata and file size are
checked on startup. This benchmark searches the **whole corpus**, without
map-row joins or thumbnails, so it is not yet the proposed dataset-scoped API.

Each configuration uses 12 prompts twice, 24 requests, top-24 retrieval, no
query cache, a reusable HTTP client and at most two simultaneous encoder/ANN
operations. PyTorch and FAISS each use two threads; extra admitted HTTP requests
queue at the semaphore. Per-request IVF search parameters avoid concurrent
mutation of `index.nprobe`. HF uses its ordinary region; Modal was tested both
with automatic placement and a second app requesting the broad `us` region.
Read-only inspection confirmed automatic placement in Azure `australiaeast`
and the US-pinned container in Azure `eastus2`. Results are from this workstation only,
not a multi-region browser test. These small-sample p95s describe this run, not
an SLA or sustained-load capacity estimate.

Fresh startup includes downloading the public model and **7.48 GB index** onto
ephemeral disk. This is deliberately an uncached bootstrap, not an optimized
production cold start. An always-warm service, a cached artifact volume or a
prebuilt image can avoid that explicit runtime download; baking it into an image
moves the bytes into image distribution, not magically to zero-byte startup.
Index deserialization and model/import
costs still remain unless an appropriate memory snapshot is used. At a perfect
1 Gbit/s, transferring this index alone takes about 60 seconds; 100 Mbit/s takes
about ten minutes, before protocol overhead. Do not equate a fast container
boot with a ready full-corpus search service.

### Measured warm requests

Baseline `nprobe=64`; all times below are milliseconds. Concurrency columns
refer to concurrent **requests**, not separate containers or sustained users.

| Host | Client p50 / p95, concurrency 1 | Server p50 / p95, concurrency 1 | Client p95, concurrency 4 | Client p95, concurrency 8 |
| --- | ---: | ---: | ---: | ---: |
| HF CPU Basic | 91.83 / 161.55 | 54.56 / 61.28 | 230.26 | 372.66 |
| HF CPU Upgrade | 115.83 / 149.59 | 80.65 / 106.20 | 199.69 | 336.60 |
| Modal 4 cores / 32 GiB, automatic → Australia East | 522.31 / 553.50 | 71.74 / 103.46 | 830.50 | 1,050.49 |
| Modal 4 cores / 32 GiB, US-pinned → East US 2 | 151.09 / 159.63 | 73.15 / 81.57 | 243.16 | 555.20 |

CPU Basic was faster in single-request median server time in this run; more
advertised cores do not automatically accelerate a small single-query workload.
Different host CPUs, contention, burst behavior and the small sample prevent
generalizing that ordering. Upgrade showed somewhat better concurrency tails.

The unpinned Modal result is **not evidence that its CPU search is much slower**:
server work was about 72 ms median, while the client observed about 522 ms.
Those medians are descriptive, not a paired network-overhead percentile, but
the gap and confirmed Australia placement justify explicit region selection.
Modal routes Function traffic through Virginia by default; container and routing
regions are distinct settings. [Routing and placement](https://modal.com/docs/guide/region-selection).

With US pinning, warm single-user latency became competitive with HF. That run
costs 1.15× the unpinned resource rate and had a higher eight-request tail in this
sample. Both providers meet the initial single-user target; the pilot does not
justify a blanket claim that Modal is slow. HF remains the simpler low-cost
personal-demo starting point, with Upgrade available for always-warm operation.

### Uncached startup and resident memory

One bootstrap per configuration; not cold-start p50/p95. Stage timings are
inside the service and exclude image build/scheduling before Python starts.

| Host | Imports | Model download/load | Index download | Index load | Ready after | Peak process RSS |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| HF CPU Basic | 3.41 s | 3.07 s | 92.22 s | 25.17 s | 124.33 s | 7.55 GiB |
| HF CPU Upgrade | 3.32 s | 3.36 s | 94.63 s | 4.19 s | 105.89 s | 7.60 GiB |
| Modal automatic → Australia East | 8.77 s | 18.47 s | 601.56 s | 11.85 s | 640.77 s | 8.14 GiB |
| Modal US-pinned → East US 2 | 8.55 s | 4.13 s | 257.06 s | 10.29 s | 280.14 s | 8.10 GiB |

RSS excludes the OS page cache and is not the provider's complete memory billing
metric. The service also uses about 7 GiB ephemeral disk for the index plus the
model cache. The full encoder checkpoint is downloaded, although only the text
tower is retained for inference. All reported first-query top-24 IDs matched
across these hosts/configurations; their first eight also matched the recorded
local sample. That is a sample identity check, not complete retrieval
correctness or recall validation.

The checked missing-key requests returned 401 on HF Basic and the US Modal
endpoint. CPU Basic's 120 search responses also passed unique/in-range ID,
finite-score and descending-score checks. There were 480 successful timed
search requests across four hosts/configurations, but no exact-recall or
full-browser UI test. Service source and raw aggregate measurements are in
[the pilot artifacts](benchmarks/clip-search-20260905/README.md).

## Index size calculations

512 dimensions. IVF estimates include 4,096 fp32 centroids, but exclude allocator
slack, optional lookup tables, identity maps and process/model overhead. PQ is
lossy; its size advantage is not a claim of exact ranking quality.
[FAISS storage formulas](https://github.com/facebookresearch/faiss/wiki/Faiss-indexes).

| Rows | Raw fp32 | Raw fp16 | IVF/PQ32 + IDs | IVF/PQ64 + IDs |
| --- | ---: | ---: | ---: | ---: |
| 2,000,000 | 3.815 GiB | 1.907 GiB | 0.082 GiB | 0.142 GiB |
| 19,344,847 | 36.897 GiB | 18.449 GiB | 0.728 GiB | 1.305 GiB |
| 103,816,750 | 198.015 GiB | 99.007 GiB | 3.875 GiB | 6.969 GiB |

Formulas: raw fp32 = N×512×4; fp16 = N×512×2;
PQ32 = N×(32+8)+4096×512×4; PQ64 replaces 32 with 64. These are server index
storage/memory quantities, **not browser downloads**. At nprobe=64, IVF4096 visits
about 1.62M codes/query on average at full scale; list imbalance changes that.

## Compute cost comparison

These are alternative configurations, not equivalent measured throughput.

| Service/configuration | Hourly | 730h always warm | 10 billed hours |
| --- | ---: | ---: | ---: |
| HF static frontend | $0 | $0 | $0 |
| HF CPU Basic, 2 vCPU / 16 GB | $0 hardware | $0 hardware | $0 hardware |
| HF CPU Upgrade, 8 vCPU / 32 GB | $0.030 | $21.90 | $0.30 |
| HF T4 small, 4 vCPU / 15 GB / 16 GB VRAM | $0.40 | $292 | $4 |
| HF L4, 8 vCPU / 30 GB / 24 GB VRAM | $0.80 | $584 | $8 |
| Modal CPU, 1 physical core / 12 GiB | $0.143064 | $104.44 | $1.43 |
| Modal CPU, 4 physical cores / 32 GiB | $0.444384 | $324.40 | $4.44 |
| Modal CPU, same resources, US-pinned | $0.511042 | $373.06 | $5.11 |

HF rates: [pricing](https://huggingface.co/pricing). Modal uses $0.0000131 per
physical-core-second plus $0.00000222 per GiB-second; a physical core corresponds
to two vCPUs. Billing uses the higher of requested or actual CPU/memory usage.
Figures exclude additional usage, storage, region premiums and existing credits.
[Modal rates](https://modal.com/pricing), [resource accounting](https://modal.com/docs/guide/resources).

CPU Basic sleeps after 48 hours of inactivity. Paid Spaces normally stay up;
custom sleep reduces billed time but a visitor must wait for restart. HF bills
Starting/Running time by the minute, not only inference execution. Persistent
artifacts now use attached Buckets; the ordinary container disk is ephemeral.
[Sleep/billing](https://huggingface.co/docs/hub/spaces-gpus),
[storage](https://huggingface.co/docs/hub/spaces-storage).

Modal gives more explicit scale-to-zero/warm-pool controls. Its five-minute idle
tail matters: 1,000 isolated 30-second sessions plus a 300-second tail imply
91.7 billed hours, about $13.11 at 1 core/12 GiB, before startup/extra usage. Shared
or overlapping sessions change this substantially. At 153 billed hours/month,
that configuration reaches the $21.90 always-on HF CPU price. CPU throughput
must still be compared. [Cold-start controls](https://modal.com/docs/guide/cold-start).

Region pinning is not free on Modal: broad selection has a 1.15× multiplier and
narrow selection 1.75×. The $104.44 example becomes about $120.10 / $182.76 per
always-warm month respectively. [Region selection](https://modal.com/docs/guide/region-selection).

ZeroGPU is not the default recommendation for this workload: GPU queues and
quotas add variability, and it currently requires the Gradio SDK. A small text
encoder plus CPU ANN does not justify that coupling for the desired interface.
[ZeroGPU](https://huggingface.co/docs/hub/spaces-zerogpu).

## Static storage and bandwidth

Read-only bucket inspection confirmed `fun-data` is **US multi-region**, with
wildcard GET/HEAD CORS and the required range-response headers exposed. Existing
frontend URLs use `storage.googleapis.com/fun-data/...`: direct GCS, not proof
that a separately configured Cloud CDN backend exists.

The completed original 2,015 thumbnail shards hold **154,329,981,126 bytes /
143.731 GiB** for 19,344,847 rows, averaging **7,978 bytes/image** at max-side 256px
WebP quality 80. Complement shards are currently being added to the same
directory, so this measurement deliberately uses only the completed pool
manifest. Extrapolating the same average to 103.8M gives **771.35 GiB** of thumbs,
not a measurement of the unfinished complement. At a planning rate of
$0.026/GiB-month, those are about **$3.74 / $20.06 monthly storage**; atlas packs,
indexes, URL metadata, redundant generations and replication writes are extra.
[GCS pricing](https://cloud.google.com/storage/pricing).

Twenty-four current thumbnails average about 187 KiB payload, plus small JSON
and lookup reads. They are already small enough that downloading 256px sources
for a small results grid is reasonable initially. A stored 128px variant could
reduce bandwidth further; displaying at 128px alone does not reduce transfer.

For a scenario of **200 MiB actually transferred/session** (not GPU memory),
US/Europe destinations, first pricing tier, excluding credits/tax:

| Monthly sessions | Transferred | Direct GCS egress | Cloud CDN delivery only |
| --- | ---: | ---: | ---: |
| 1,000 | 195.31 GiB | $23.44 | $15.63 |
| 10,000 | 1,953.13 GiB | $234.38 | $156.25 |

Direct GCS is $0.12/GiB here; 500 Standard GETs/session add $0.20 / $2.00.
Cloud CDN delivery is $0.08/GiB, but adds cache-fill bytes, lookup fees and load
balancing (a new forwarding-rule baseline is $18.25/month), plus applicable origin
operations. Five million CDN lookups cost $3.75. This is why its delivery-only
column is not a complete bill. [GCS](https://cloud.google.com/storage/pricing),
[Cloud CDN](https://cloud.google.com/cdn/pricing),
[load balancing](https://cloud.google.com/vpc/network-pricing#lb).

### HF assets are worth testing, not dismissing

HF advertises storage with CDN/egress included, Pro public storage up to 10 TB
subject to its usage policies, and 1 TB private storage. Public add-ons start at
$12/TB-month; free public storage is best-effort. This is potentially very good
for an approximately 0.83 TB thumbnail corpus, if available account capacity and
the intended distribution fit the policy. These are Hub/Bucket storage terms,
not a promise that the Space's ephemeral disk is a free terabyte CDN.
[Storage policies](https://huggingface.co/docs/hub/storage-limits),
[pricing](https://huggingface.co/pricing).

Anonymous Hub resolver requests are currently limited to 3,000 per five-minute
window per IP, subject to change. The owner's Pro token must never be embedded
in the browser to raise visitor limits; shared NATs and high request fan-out need
testing. [Rate limits](https://huggingface.co/docs/hub/rate-limits).

### Actual small range probes

Same machine, fresh urllib HTTP requests, 32 KiB requested, public URLs, Origin
header supplied. Three requests each; this is a diagnostic, **not a statistical
provider latency benchmark**. Different objects/origins and cache state.

| Path | Elapsed times | Result |
| --- | --- | --- |
| Existing GCS demo 100 MB binary | 139 / 98 / 89 ms | 206, exactly 32,768 bytes |
| HF Bucket 7.48 GB index through resolver | 594 / 304 / 240 ms | 206, exactly 32,768 bytes |
| HF resolved CDN URL, one follow-up | 204 ms | 206, exactly 32,768 bytes |

Both exposed Content-Range cross-origin and returned uncompressed byte slices.
GCS supplied `public,max-age=3600`; the tested HF response had no Cache-Control
header and used a signed CDN redirect. We should not hardcode expiring URLs.

Cloud CDN also fills ranges in roughly **2 MiB units**, independent of our
32 KiB app pages. Random tiny reads can therefore cause ~64× origin fill
amplification on cold cache; the browser still receives only its requested
bytes. Measure cache-fill traffic, not just frontend transferred bytes.
[Range caching behavior](https://docs.cloud.google.com/cdn/docs/caching#byte-range-requests).

Modal has announced egress charging from **October 1, 2026**: Starter includes
1 TiB/month, then $0.04/GiB; no charge in September. Small search JSON is unlikely
to dominate this, but routing all thumbnails through Modal would change the
calculation. [Announced egress billing](https://modal.com/docs/guide/network-egress-billing).

## Deployment work that should not be overlooked

The frontend already accepts `VITE_DATA_ORIGIN`, but today's `/thumbs/monet/...`
route extracts an image from packed shards, and `/meta/...` returns original URL
metadata. They are dynamic server routes. Uploading the current files to GCS
alone will not reproduce them. Either keep a bounded asset API initially or add
browser-side offset lookup → range read → Blob URL with a bounded cache and
URL revocation. This should work identically against GCS and HF Bucket origins.

Use immutable release URLs, separate asset/search origins, no transparent gzip
on indexed binaries, strict 206/Content-Range validation, long asset cache TTLs,
and short dataset-catalog TTLs. Test the HF iframe and direct `.hf.space` view
for keyboard focus, WebGL, fullscreen/pointer interactions, CSV downloads and
localStorage. Saved games are origin-scoped; CSV is the existing transfer path
from local/GitHub hosting. Do not assume saves migrate automatically.

## Remaining implementation order

1. Extend the sample identity join to a complete, audited FAISS-to-map join;
   create a 2M SSCD subset search index or validated in-index membership
   filtering. Keep ANN independent of UMAP grid N.
2. Implement the bounded local search API and result-card interactions, reusing
   targeting and explicitly pinning the searched image, not just its voxel.
3. Recheck the actual dataset-scoped API on the selected host, including mapping
   overhead, cached-artifact restart, and browser timings from the intended
   client region. The completed pilot tested full-corpus retrieval, not these
   integration details or a distribution of cold-start timings.
4. Compare identical published asset bytes on both stores at 32 KiB, 1 MiB,
   image and atlas sizes. Verify nonzero offsets, aborts, caching, expired
   redirects, read-amplification and iframe behavior. Then choose the origin.
5. Deploy the static Space independently once the hosting choice is confirmed.
   Start search on CPU Basic for personal use; choose Upgrade for paid
   always-warm controls, or US-pinned Modal for its scaling controls. The
   frontend should stay usable while a sleeping search backend warms up.

The HF token was found in the normal home cache rather than the active
`HF_HOME=/data/hf`; account identity/Pro status were verified without exposing
credentials or changing login state. GCP credentials refreshed successfully and
allowed read-only bucket inspection. The pilot created and then deleted two
private HF Spaces (Basic and Upgrade), and ran then stopped two ephemeral Modal
apps (automatic placement and US-pinned). No existing demo, bucket object,
workspace configuration or persistent volume was changed. Generated benchmark
images/run history may remain in Modal's normal cache/history; no pilot service
is left running. Approximate requested-resource compute for the whole pilot is
**$0.15 before credits**, not a reconciled invoice. A 45-minute cleanup watchdog
bounded each paid run; actual runs finished well before it and below the $2
pilot budget.
