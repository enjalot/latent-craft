# R2 publication and local usage monitoring

MONET's public visual assets use the `latent-craft` R2 Standard bucket and
`assets.latent.download` custom domain. No Worker, on-demand image encoder or
Modal container sits in the normal browser range path. BL retains its GCS assets
and 256px images. The MONET disk FAISS/model bundle stays in a pinned HF dataset
for the Space to download; browsers never fetch that bundle.

## Credentials and domain setup

Install `ops/requirements.txt` into an operations virtual environment. Keep all
credentials outside the repository. `ops/configure_r2.py` provides an interactive
hidden-input prompt and saves `~/.config/latent-craft/r2.json` with file mode 600
in a mode-700 directory. Never put these values in `VITE_*` variables.

When using an existing local `.env`, `ops/cloudflare_setup.py` reads only its
`CLOUDFLARE_*` keys without evaluating shell syntax. Its default is inspection.
Explicit setup flags create the dedicated bucket, attach an unused asset
subdomain, add GET/HEAD range CORS and a host/path-scoped cache rule:

```bash
python ops/cloudflare_setup.py --env-file /private/path/.env
python ops/cloudflare_setup.py --env-file /private/path/.env \
  --create-bucket --public-domain assets.latent.download --import-credentials \
  --create-scoped-tokens
python ops/cloudflare_setup.py --env-file /private/path/.env \
  --large-range-domain assets.latent.download
```

The required account token can manage R2, read zones/DNS and manage cache rules
and account tokens. The script creates a bucket-only object publisher key and a
separate Account Analytics Read token, storing both privately. Repeat imports
preserve the narrower key. Account, bucket or origin changes require review.
Existing DNS records and changed owned rules are never silently replaced;
the apex and unrelated records are untouched. Account tokens use the account
token APIs, not `/user/tokens/verify`.

`r2.dev` is not a production endpoint. Use a custom domain in an active zone in
the same Cloudflare account. [Public buckets](https://developers.cloudflare.com/r2/buckets/public-buckets/),
[token setup](https://developers.cloudflare.com/r2/api/tokens/).

## Immutable conversion and uploads

The converter preserves packed thumbnail IDs, aspect ratio, row order and empty
spans. It resizes the existing WebP to at most 128px, RGB, Lanczos, quality 80,
method 4. It records encoder versions, source identity and per-shard checksums.
Nonempty corrupt images stop the build. Originals are never rewritten.

```bash
python pipeline/scripts/build_thumbnail_release.py SOURCE_PACK NEW_128_RELEASE --workers 12
python pipeline/scripts/upload_thumbnail_release_r2.py NEW_128_RELEASE --publish --follow --workers 4
python pipeline/scripts/upload_monet_static_r2.py --publish --workers 4
```

The two uploads can run alongside conversion. The static plan is deliberately
specific to the audited 4M CLIP release: 16,374 objects, 6,640,924,381 bytes,
with a 10 GiB upper bound. The shared thumbnail release is bounded at 400 GiB.
Upload scripts are dry-run by default except that `--follow` requires `--publish`.

Uploads use conditional PUT, MD5 transport checks, stored SHA-256 and post-upload
HEAD verification. Existing objects are reused only when size, digest and
encoding match. Conflicting objects are not overwritten. Each process has an
exclusive local lock and bounded concurrency. Resume with the same command;
do not delete completed files to restart. Upload keys have versioned prefixes;
binary objects use `no-transform`. Root manifests are published last.

A cold browser thumbnail reads 16 offset bytes, then that image's encoded span.
The public preflight requires exact `206`/Content-Range, public CORS, and no binary
Content-Encoding. It refuses a whole-object `200`. Python clients identify
themselves with a project User-Agent; the default generic urllib agent was
blocked by the configured Cloudflare security policy. No zone-wide security
settings were weakened.

### Large objects need an explicit cache exception

Cloudflare's normal CDN cache limit is 512 MB on Free/Pro/Business plans.
On this release, a cold request to a 1.887 GB file returned HTTP 200 for the
whole object, even with `Range` and `CF-Cache-Status: BYPASS`. The next request
returned the correct 206. A warm probe therefore did not establish safe
first-touch behavior. [CDN range behavior and size limits](https://developers.cloudflare.com/cache/concepts/default-cache-behavior/).

The `--large-range-domain` setup flag appends an exact-host, exact-path cache
bypass for three oversized objects: `spatial.bin`, minimap `points/xy_id.bin`,
and shared `point_meta.bin`. Those reads go directly to R2; ordinary chunks,
atlases and thumbnail shards retain CDN caching. It does not alter the bucket,
DNS or object contents. The bypass must follow the normal cache rule because
the last matching cache setting wins.

Preflight checks unique cache keys, nonzero middle ranges and end-of-file
ranges on all three objects, plus ordinary map and thumbnail lookups. It still
rejects HTTP 200 before consuming a response body; retrying a warm URL or
accepting whole-object fallback is not a fix. Future releases need their own
large-object inventory and exact-path exceptions, or smaller sharded objects.

## Completion-gated HF publication

Build the R2 profile in [MONET deployment](monet-demo.md), then freeze it before
waiting for long-running data jobs:

```bash
python ops/publish_when_ready.py --prepare --job /path/to/fresh-publication-job \
  --thumbnail-release NEW_128_RELEASE --search-assets PINNED_SEARCH_RELEASE \
  --static-status /path/to/monet-static-upload.json --state /path/to/deployment.json
python /path/to/fresh-publication-job/ops/publish_when_ready.py \
  --run --job /path/to/fresh-publication-job
```

Preparation copies only the built frontend, runtime and publication code, bounded
at 100 MiB. A checksum manifest freezes that version; later repository edits do
not change the waiting release. Full thumbnail counts, finished upload receipts,
release prefixes, immutable search inputs and public range checks must all pass
before creating/updating `enjalot/latent-craft-monet`. No paid hardware is selected.

After upload, the job waits for search startup, checks returned rows against
local voxel/image lookups and decodes a 128px image from the permanent resolver.
It reports `complete` only after these checks. It stops visibly on failures;
waiting is bounded at 12 hours for data, 30 minutes for publication and 90 minutes
for HF startup. `publish.log` and progress stay outside the repo. A brief browser
check of the resulting Space remains useful; these checks are not an E2E suite.

Static preflight failures also write a bounded `preflight.json` report with the
object path, status, expected/actual Content-Range and cache state. Its error is
shown in the dashboard, so diagnosing it does not require opening a log file.
Prepare a fresh job directory when changing publication code; keep old failed
snapshots and logs for diagnosis. Completed corpus objects need no re-upload.
The completion guard is scoped to that job, so a new frozen release can replace
an earlier successful one. Verification waits for the new `index.html` before
checking search readiness; the old healthy Space does not count as a deployment.

## Read-only LAN dashboard

```bash
python ops/usage_dashboard.py --bind 0.0.0.0 --port 5310
```

The default binding is loopback; the explicit LAN binding accepts private
clients with a private-IP, localhost or `gsv.local` Host header. There is no
authentication: do not expose it to the Internet or untrusted networks. It has
no write endpoints, arbitrary provider URLs or browser-visible credentials.
Changing the expected LAN hostname requires updating the host allowlist.

Local conversion/upload/publication progress refreshes every ten seconds;
provider queries run every fifteen minutes without waking sleeping demo workers.
Snapshots are kept in a private SQLite file for 31 days. Setup defaults refer to
this release's paths; command-line flags configure other local paths/providers.

| Provider | Observed | Explicitly not inferred |
| --- | --- | --- |
| R2 | Bucket origin operations and latest reported storage | CDN hit traffic, invoice, whole-account free allowance remaining |
| Modal | Workspace month-to-date billing report | Credits remaining or final invoice |
| GCP | Bucket storage gauges, requests and bytes sent through last complete UTC hour | Billable Internet egress or dollars without billing export |
| HF | Configured Space hardware and runtime stage | Account-wide invoice or historical paid hardware hours |

Missing metrics remain unavailable, not zero. R2's current-byte storage run rate
is an estimate before free allowance, not the billing cycle's daily peak average.
Storage/traffic samples retain their observation times. R2 `HeadObject userError`
counts include expected missing-object probes during publication.

For actual GCP charges, enable a [Cloud Billing export to BigQuery](https://cloud.google.com/billing/docs/how-to/export-data-bigquery)
and provide its `project.dataset.table` identifier to the operator. Monitoring
access alone does not expose the bill. No export reader is configured yet.
Modal's billing report worked with this account's existing credentials; access
may differ for another workspace. [Modal reports](https://modal.com/docs/guide/billing).

R2 Standard list prices are $0.015/GB-month, $4.50/million Class A operations,
$0.36/million Class B operations and free Internet egress. Free allowances and
unit rounding apply account-wide. Verify rates before using estimates for a
budget. [R2 pricing](https://developers.cloudflare.com/r2/pricing/).
