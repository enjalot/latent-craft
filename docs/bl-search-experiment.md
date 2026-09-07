# BL SigLIP 2: full-corpus search experiment

7 September 2026. [Try the demo](https://huggingface.co/spaces/enjalot/latent-craft-bl).

## Decision

Ship mmap FAISS SQ8 as the initial default, with LanceDB SQ8 + exact-vector
refinement selectable beside it. Both search the entire 1,080,814-image collection.
Do not ship the tested PQ configurations as the default: their text-query recall
is materially worse, even when their image-query results look good.

LanceDB remains useful for its table/storage/filtering interface, but this test
does **not** establish a RAM or latency advantage over mmap FAISS for this static
collection. Keeping the raw vectors on disk is not the same as bounding total
process memory to the configured index-cache size.

## What was actually measured

The source is the local float16 export of all BL vectors, shape
`1,080,814 × 1,152`. Every `(subset, fname)` was compared against the published
map's points table, and `row_id` was checked to be dense and identically ordered.
The immutable source SHA-256 is in the measurement JSON.

The dataset card identifies the encoder as
[google/siglip2-so400m-patch16-256](https://huggingface.co/google/siglip2-so400m-patch16-256),
revision `e8708ab72d125807e45b36fb7d4e0aacbb59f379`. Text queries use its text
model's pooled output, normalized to unit length, with 64-token padding/truncation.
The deployment exports only that text tower and tokenizer. A fixed query is
checked against the experiment on every worker startup.

Ground truth is exact FAISS `IndexFlatIP` over float32-normalized versions of
all stored source vectors—not a subsample, and not the unavailable original
pre-float16 vectors. Queries comprise 64 fixed BL-oriented text phrases and 64
image vectors, 16 per collection subset. Recall@24 measures recovery of those
exact neighbors, **not human-judged semantic relevance**. Near-ties and repeated
illustrations make this distinction important. Image queries can retrieve
themselves; text and image recall are reported separately.

The experiment includes:

- Exact FAISS float32, FAISS IVF1024/PQ72×8, and FAISS IVF1024/SQ8.
- Lance float32/PQ72; float16/IVF_FLAT, PQ72, PQ144, SQ8, and HNSW-SQ8.
- Normalized-vector dot-product PQ144/SQ8 and L2 PQ144 diagnostic controls.
- 64/512 MiB Lance index caches, probes 8/32/64, refinement off/4×.
- Extended SQ8 sweeps through 128/256 probes, including a 128 MiB cache run.
- Full-corpus **actual signed-int8 storage**, with an independent exact
  dequantization oracle; native signed-int8 cosine-index compatibility checks.

There are 130 measured search settings, plus the full signed-int8 experiment.
The [complete table](measurements/bl-search-20260907.md) and
[machine-readable measurements](measurements/bl-search-20260907.json) include
build duration, index and total disk size, query latency, and process RSS.

Builds and searches run in separate processes. Searches use two threads. These
are shared-workstation timings, not isolated CPU reservations. Some metric
sweeps overlap; other research jobs were left untouched. OS caches were not
flushed, and successive settings reuse their process's application cache.
The reported RSS excludes the text encoder, includes native libraries/buffers,
and must not be read as a hard memory limit. FAISS compressed indices are mmap,
not copies eagerly loaded into RAM. The exact flat index is fully loaded.

## Main results

Disk below is decimal GB. Lance totals include its stored float vectors and
index. Timings are retrieval only, excluding encoding/network/rendering.

| Configuration | Text recall@24 | Local median retrieval | Total search-data disk |
|---|---:|---:|---:|
| Exact FAISS float32 | 100% | 163 ms | 4.98 GB |
| FAISS SQ8, 128 probes — demo default | 95.7% | 17 ms | 1.26 GB |
| Lance float16 SQ8, cosine, 256 probes, refine 4 — demo alternative | 93.7% | 146 ms | 3.74 GB |
| Lance float16 SQ8, dot, 256 probes, refine 4 | 95.9% | 459 ms | 3.74 GB |
| FAISS PQ72, 64 probes | 27.0% | 2.3 ms | 0.09 GB |
| Lance float16 PQ144, cosine, 64 probes, refine 4 | 3.9% | 21 ms | 2.66 GB |

At 64 probes, representative search-only RSS was about 1.21 GiB for mmap
FAISS SQ8 versus 1.76 GiB for Lance SQ8 with a 512 MiB index cache. The latter
is already larger than its cache budget: that setting is not a process-RAM cap.
See the full table for higher-probe runs and peaks rather than extrapolating
these examples to another query workload.

The text encoder's float32 parameter payload is 2,831,131,584 bytes
(2.64 GiB), before tokenizer, activations, runtime and search overhead. It is
much larger than the small CLIP text encoder used in the earlier MONET prototype.

## Actual HF CPU Basic measurements

The live two-CPU Space reproduced the recall scores on the same 64 text prompts.
Requests were sequential over a persistent HTTP connection. The first measurement
attempt hit a TLS-handshake timeout; the completed run had no transport retries.
An earlier partial run had warmed eight prompts, so 28 queries per backend still
paid for embedding; the alternate backend reused each query vector.

| Live backend | Recall@24 | Retrieval p50 / p95 | New-phrase end-to-end p50 / p95 |
|---|---:|---:|---:|
| FAISS SQ8 / 128 probes | 95.7% | 32 / 49 ms | 425 / 582 ms |
| Lance SQ8 / 256 probes / refine 4 | 93.7% | 267 / 380 ms | 648 / 789 ms |

Uncached text embedding itself was 380 ms median / 496 ms p95. Process RSS
after the sweep was **5.224 GB (4.87 GiB)**, with **5.250 GB peak**, including
the encoder and both search backends. This is one combined worker's observed
working set, not an attribution of RAM to either backend and not a hard cap.

The [live measurement receipt](measurements/bl-space-20260907.json) includes
per-query encoding, retrieval, network-inclusive latency, cache hits and recall.
The mixed cached/uncached overall median is intentionally not presented as a
new-query latency. These numbers do not characterize sleep/resume time, an
empty OS cache, concurrent visitors, or every client's network route.

### Signed int8 is not a drop-in native Lance cosine column

Both tested Lance versions accept a `FixedSizeList<int8>` storage column, but
reject creating the tested cosine IVF_SQ index on it. This was checked with
8,192 rows before trying a full import. The supported SQ8 search path takes
floating-point input and builds its own 8-bit quantized search index.
Unsigned-byte binary/Hamming search is a different similarity function and
is not a substitute for SigLIP cosine similarity.

Separately, all 1,080,814 vectors were stored in Lance as symmetric per-row
signed-int8 codes plus a float32 scale. The whole table is **1.252 GB**.
An exact FAISS oracle over dequantized, re-normalized vectors recovers **91.4%**
of the original text top-24 and **97.1%** of image top-24, before any ANN error.
This is a quantization-quality control, **not** a functioning native Lance
int8 search configuration. Its temporary exact oracle also consumes substantial
RAM; its process memory is not a proposed serving budget. The measured result
is specific to this simple per-row symmetric quantizer, not all 8-bit schemes.

### Bugs / unsuitable configurations caught by the test

The installed LanceDB 0.30.2 crashed querying float16 IVF_FLAT with a buffer-size
error. All current Lance configurations were rerun using an isolated 0.37.1
installation; shared research environments were not upgraded. That crash no
longer occurred.

Lance PQ's text recall was unexpectedly poor while image-query recall looked
respectable. The first stored vectors were checked against the source exactly;
an unindexed cosine query returned the exact expected text neighbors. Rebuilding
on the newer version did not resolve PQ's text failure. Dot-product PQ improves
the result substantially but still reaches only 57.0% text recall at 64 probes
with refine 4. L2 PQ did not solve it. This narrows the issue to the indexed
approximation/routing path; it does not prove a specific upstream bug. Do not
generalize image-only recall to a cross-modal text search demo.

## Reproducing and extending

The experiment runner is `pipeline/scripts/experiment_bl_search.py`. Its source
paths and model revision are intentionally explicit; make a new output directory
for another source, version, seed or configuration. `--reuse-preparation` reuses
verified vectors and exact truth without repeating model extraction. `--config`
selects one build/evaluation; `--configs` restricts the all-stage matrix.

```bash
python pipeline/scripts/experiment_bl_search.py --output /path/to/new-experiment
python pipeline/scripts/experiment_bl_search.py --output /path/to/new-experiment \
  --stage evaluate --config lance-f16-sq8 --cache-mb 512 --probes 64 128 256
python pipeline/scripts/report_bl_search.py /path/to/new-experiment docs/measurements
```

Use LanceDB 0.37.1, FAISS CPU 1.13.2, and Transformers 5.14.0 for this release;
the Space uses CPU-only PyTorch 2.8.0. Original receipts and result identities
remain under `/data/latent-craft/experiments/bl-search-20260907b`. This is not a
multi-seed tuning study or a concurrency/cold-cache benchmark. Those are sensible
follow-ups if a higher-traffic deployment needs stronger guarantees.

See [deployment and publication notes](bl-demo-publication.md) for the browser,
HF worker, asset boundaries, and later BL/Monet theme separation.
