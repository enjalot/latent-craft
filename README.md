# latent-craft

Fly through image embeddings as a voxel world. Nearby chunks stream thumbnail
atlases; hierarchical proxies show the larger structure. Search, collect images,
inspect their sources, and return later to a saved inventory.

## Try it

[British Library demo on Hugging Face Spaces](https://huggingface.co/spaces/enjalot/latent-craft-bl)
· [Open the app directly](https://enjalot-latent-craft-bl.hf.space/)

The BL demo contains 1,080,814 historic book images, SigLIP 2 / FAISS SQ8 search,
book metadata and filters, and a wood-and-library theme. It is an independent
project, not an official British Library product. Historical-content and source
attribution notices are available in the app.

The full 103.8M MONET CLIP profile, projected by 4M-trained basemap heads, also
supports disk-backed FAISS search. Its [search artifacts](https://huggingface.co/datasets/enjalot/latent-craft-monet-search)
are published; the public map is pending completion of the 128px Cloudflare R2
thumbnail release. R2 also serves the voxel packs, minimap and URL metadata.
See [MONET deployment](docs/monet-demo.md). The separate
[6M-trained DINO/PCA-768 map](docs/full-corpus-monet.md) has no text-search bar.

## What the browser loads

The corpus and search index never load wholesale in the browser. Chunk atlases,
summaries, hierarchical proxy bricks, posting lists and row lookups stream by
distance or byte range. Compact publication formats use 5-byte thumbnail
references, 4-byte voxel addresses, and sparse occupied-cell summaries.

Phones get a data-use notice before any map assets load, a D-pad, drag-to-look,
hold-to-preview, and compact saved inventory. The mobile tier omits the minimap
and automatic sharp band, and limits pixel count, frame rate and residency.
Exploration still uses ongoing data; the notice is not a lifetime download cap.

## Run locally

For a procedural world without a dataset:

```bash
cd frontend
npm ci
npm run dev
```

Open `http://localhost:5300/?synthetic=1`.

Real datasets require separately prepared assets; they are not in this
repository. The default data server runs on port 8802:

```bash
cd pipeline
python3 -m venv .venv
.venv/bin/python -m pip install -e '.[dev]'
.venv/bin/python scripts/data_server.py 8802 /path/to/data-root
```

The data tree contains `chunks/`, `minimap/`, `points/` and thumbnail stores.
Vite proxies those routes to the local data server. Select a registered map with
`?dataset=bl-160` or the dataset picker. A published standalone build uses
`VITE_DEMO_DATASET` to offer only its deployed dataset.

## Guides

- [Controls, mobile layout, search, inventory and CSV](docs/usage.md)
- [Streaming architecture, formats and resource budgets](docs/streaming-architecture.md)
- [Dataset descriptors and visual themes](docs/themes-and-datasets.md)
- [Image metadata and exact filtering](docs/image-metadata.md)
- [Dataset/model provenance](docs/dataset-provenance.md)
- [BL deployment and static-serving requirements](docs/deployment.md)
- [MONET full-corpus build and verification](docs/full-corpus-monet.md)
- [R2 publication and read-only usage dashboard](docs/r2-operations.md)

## Checks

```bash
cd frontend
npm test
npm run typecheck
npm run build

cd ../pipeline
.venv/bin/python -m pytest -q
```

Tests emphasize correctness, bounded memory, byte-range contracts, cache
ownership and stationary-frame work. Brief browser checks supplement the unit
suite; software-rendered headless FPS is not a user-GPU benchmark.

## Source and licenses

Large corpus packs, vector indices, model weights, databases and credentials
are excluded from code commits. Small theme artwork and the Basis transcoder
are included for the application.

A reusable license for project source has not yet been selected. Public source
availability does not grant an MIT/Apache license. Dataset images, model exports
and dependencies retain their separate terms; see the app's attribution,
model license files and `frontend/public/THIRD_PARTY_NOTICES.txt`.
