# Image metadata and filtering

Dataset descriptors may opt into `metadataEndpoint`. The endpoint serves a
release-bound schema, focused-image details, book lookup and exact filter
snapshots. Datasets without an adapter do not display metadata controls.

The BL adapter supports image type, inclusive recorded publication-year range
(optionally including unknown dates), and nine-digit book ID. Title lookup is
case-insensitive substring search, capped at 20 results. Predicates combine with
AND. Missing catalog titles are shown as labeled source filenames.

## Local service

Build the sidecar using the pipeline environment (NumPy and PyArrow required):

```sh
pipeline/.venv/bin/python pipeline/build_bl_metadata.py \
  --points /path/to/points.parquet \
  --catalog /path/to/flickr-metadata/imagedirectory \
  --pack /path/to/compact-chunk-pack \
  --output /path/to/new-metadata.sqlite
python3 pipeline/metadata_server.py --db /path/to/new-metadata.sqlite
```

The builder refuses to overwrite an existing output. It validates row order,
the row-to-voxel hash and all posting memberships. It writes to a staging database
and publishes only after SQLite's integrity check. The service opens SQLite
read-only, binds `127.0.0.1:8805`, and imports no ML libraries. Vite proxies
`/api/metadata`; `LSV_METADATA_PROXY_TARGET` overrides that local target.

The standalone HTTP server is a serialized local preview service. The BL Space
wraps the same store in bounded FastAPI routes, with a dedicated single thread
owning SQLite and cancellation-safe admission. Its matching sidecar is pinned
and checksum-verified independently from the model. Do not route an unrelated
database behind an existing release URL or put SQLite in the static asset tree.

## Wire contract

`GET /api/metadata/bl-20260907a/schema` supplies available controls and the map
identity. `GET .../rows/{row}` returns typed text fields, provenance and source
links for one image. `GET .../books?q=...` performs bounded book lookup.

`POST .../filter` accepts at most 2 KiB of JSON:

```json
{"type":"plates","minYear":1800,"maxYear":1850,"includeUnknown":false}
```

The gzip-compressed binary response has a 64-byte little-endian header:

| Offset | Type | Meaning |
|---:|---|---|
| 0 | 4 ASCII bytes | `LCMF` |
| 4 | u32 | Total map rows |
| 8 | u32 | Matching rows |
| 12 | u32 | Nonempty matching voxel count |
| 16 | 32 bytes | Row-to-voxel SHA-256 |
| 48 | u32 | Match mask bytes, `ceil(rows/8)` |
| 52 | u32 | Version, currently 1 |
| 56 | 8 bytes | Reserved zero |

The header is followed by a one-bit-per-row mask (least-significant bit first)
and sorted 12-byte `(chunk u32, local voxel u32, matching count u32)` records.
The client verifies map identity, shape, record ordering, population count and
count sums before atomically applying a snapshot. Eight compressed snapshots
are cached by the local service. At BL scale the largest decoded snapshot is
311,422 bytes; JavaScript maps and proxy summaries require additional heap.

## Interaction semantics

Filtering hides zero-match voxels and effector ghosts. The occupancy cutoff,
X-ray colors and hovered counts use matching counts before mining. Coarse proxy
labels show aggregate counts, while colors and cutoff use the largest child
count. A stale/nonmatching atlas representative is neutral until a matching
sharp preview is available. No atlas repacking occurs.

Filtered mining stores out-of-order selections and never advances the ordinary
posting cursor through excluded images. It reads at most 100 postings per async
page, retaining at most one 100-match prepared batch outside the existing bounded
range cache. Sparse matches can require scanning several pages. Existing save
and CSV identities remain unchanged; return, clear-filter and restore must not
lose excluded rows or collect duplicates.

Metadata text loads only for the focused inventory/lightbox image. Old requests
are canceled on focus changes and teardown. Missing metadata does not block
ordinary map use. Image filters are session-only; inventory remains persistent.

The minimap remains full-collection context. BL search filters its 24 retrieved
FAISS candidates; this is not predicate-aware index retrieval. MONET requires
its own audited metadata adapter; the 100M maps do not download global masks or
enable these BL predicates.

## Verification

```sh
cd frontend
npm test
npm run build
```

From the repository root:

```sh
pipeline/.venv/bin/pytest -q pipeline/test_metadata_server.py
python3 pipeline/benchmark_metadata.py --db /path/to/metadata.sqlite
```
