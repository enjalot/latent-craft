# Disposable search pilot artifacts

These are the exact service, Dockerfile and Modal adapters used for the
September 5 comparison. Current runtime guidance lives in
[MONET disk-search deployment](../../monet-demo.md); chronological reviews are
kept separately from the publication source.
They are benchmark artifacts, **not a production search implementation**.
The accompanying JSON files contain aggregate measurements and sample IDs,
not tokens. Pilot resources were temporary; their URLs are not live APIs.

The service requires an externally supplied `PILOT_KEY`; each request supplies
it as `X-Pilot-Key`. Private HF requests additionally need an authorized HF
Bearer token. Never put either secret in a frontend build or this directory.
The Modal adapter creates no persistent volume and caps the app at one
4-physical-core / 32-GiB container. The US adapter additionally requests the
broad `us` region (1.15× compute pricing). Running/deploying either can incur charges.
The measured Modal instance was ephemeral (`with app.run()`), not a permanent
deployment. No workspace settings or existing apps were changed.

HF used this Dockerfile on private CPU Upgrade and CPU Basic Spaces, with a
Docker SDK README and port 7860. A local controller deleted its own Spaces
after testing and stopped the Modal run. The paid pilot had a 45-minute
cleanup watchdog, well inside the $2 requested-compute budget. That controller
is intentionally not an unattended production deployment mechanism.

For each ready service, a persistent httpx client sent the following 12 prompts
twice per configuration (24 requests):

- a red sports car
- an aerial photograph of a forest
- a dog playing in snow
- a watercolor painting of mountains
- a plate of pasta
- a portrait of a woman
- a medieval castle
- a black and white street photograph
- a close up of a butterfly
- a blue ceramic bowl
- a science fiction spaceship
- a vintage illustrated book cover

Configurations were `(concurrency, nprobe)` = `(1,16)`, `(1,32)`, `(1,64)`,
`(4,64)`, `(8,64)`, with top-k fixed at 24. HTTP concurrency was a thread pool;
actual encoder/ANN admission was capped at two operations by the service.
Client time covers the request and parsed JSON response, without thumbnails.
p50/p95 use NumPy percentile interpolation. Readiness was polled every ten
seconds, so `observed_first_ready_s` includes polling delay and deployment/build
time where applicable; use the service's stage timings to separate them.

The bootstrap downloads a publicly published 7.48-GB index into container-local
`/tmp`, and checks size/dimensions/row count, not a cryptographic checksum.
Production needs a trusted immutable release/checksum, dataset membership and
verified identity mapping, rate limits, bounded queue admission, readiness
integration, cached artifacts, and operational monitoring. In particular,
HTTP disconnects do not cancel a running FAISS search in this benchmark.
