# British Library publication profile

[Hugging Face Space](https://huggingface.co/spaces/enjalot/latent-craft-bl)
· [Direct app](https://enjalot-latent-craft-bl.hf.space/)
· [Source](https://github.com/enjalot/latent-craft)

The deployed profile uses the shared library theme, desktop and touch controls,
FAISS SQ8 text search, exact-result collection, persistent inventory, source
metadata and book/type/year filters. See [deployment instructions](deployment.md)
and [usage](usage.md).

## Hosting split

| Component | Stored by | Loaded by |
| --- | --- | --- |
| Compiled UI, theme art, runtime | HF Docker Space | Browser / worker |
| SigLIP text tower, SQ8 index, map lookups | Pinned HF artifact dataset | Worker only |
| Book metadata SQLite | Separate pinned HF artifact | One read-only worker thread |
| Atlases, hierarchy, map lookups, WebP shards | Immutable GCS objects | Browser, nearby chunks / exact ranges |
| Inventory and settings | localStorage, optional CSV | This browser and dataset |

The active search manifest contains **4,141,328,383 bytes**. It does not download
or open the older LanceDB experiment. Metadata adds **313,352,192 bytes** on
worker disk, not on the client. GCS visual assets occupy **7,827,080,918 bytes**
under `gs://fun-data/latent-craft/bl/20260907a`.

The Space uses CPU Basic, with one bounded search request at a time, two CPU
threads, 24 results and a 128-entry embedding cache. Read-only SQLite has a
16 MiB page cache, an eight-snapshot result cache and one execution thread with
at most 16 admitted operations. The immutable schema is precomputed; ordinary
overlapping reads queue within that bound instead of immediately returning 429.
Overflow returns Retry-After, which the client respects with at most two retries.
Metadata starts independently from the model. No query history is intentionally
persisted by the application.

Ordinary thumbnails travel directly from browser to GCS. The worker's thumbnail
endpoint preserves stable exported URLs and provides a fallback. Source metadata
loads only for the focused image. Full collection masks stay small at BL scale;
the 100M MONET profiles do not use these BL predicates.

About, Settings and Search share a 320px left column. About is first; the
single-collection publication omits the dataset picker. The wider minimap sits
bottom-left, separately from the right-hand inventory. Search pages contain
four images on shorter windows or eight on taller ones. Hide UI retains all
state while leaving only its restore button visible. Mobile still omits the
minimap and uses compact inventory thumbnails.

GCS is a public object-storage origin, not a provisioned Cloud CDN load balancer.
The existing bucket CORS settings support exact 206 byte ranges. Binary objects
must not be dynamically recompressed.

## Costs and limitations

CPU Basic currently provides 2 vCPU, 16 GB RAM and 50 GB ephemeral disk at no
hourly compute charge. A cold worker still downloads and verifies artifacts;
memory mapping does not cap process/page-cache memory.
[HF hardware documentation](https://huggingface.co/docs/hub/spaces-overview).

At US multi-region Standard list prices, the visual assets are roughly
$0.19/month at rest. Internet transfer commonly starts at $0.12/GiB, with
destination and allowance differences. For example, 1,000 uncached 50 MiB
sessions total about 48.8 GiB, or $5.86 transfer before allowances and requests.
These are workload calculations, not a promised session average.
[GCS pricing](https://cloud.google.com/storage/pricing).

The library interior is a generated interpretation, not a photograph or an
exact reconstruction. BL Labs, Daniel van Strien's mirror and Google SigLIP 2
are credited separately. Historical material may contain offensive depictions.
No blanket source-image or application-code license is implied.
