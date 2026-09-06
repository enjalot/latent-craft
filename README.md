# latent-scope-3d

A browser-based, game-like explorer for large 3D UMAP embeddings. Points are
binned into voxel chunks; nearby chunks stream textured representative images
while a compact proxy layer keeps the full shape visible at distance. A linked
2D UMAP minimap, extraction inventory, lightbox, and inspection tools provide
ways to move between overview and individual source images.

The default is `monet-sscd-512`, using hierarchical proxy bricks and paged
byte-range data. See [streaming architecture and 100M limits](docs/streaming-architecture.md)
for formats, working-set budgets, build commands, and measured verification scope.

The [103.8M MONET release](docs/monet-104m-4m-release.md) uses the random
4M-trained CLIP basemap heads for both 2D and 3D, with 512³ voxel resolution.

## Run locally

The app expects a data tree containing `/chunks`, `/minimap`, `/thumbs`, and
`/points`. By default the Vite server proxies those paths to the included data
server on port 8802.

```bash
cd pipeline
python3 -m venv .venv
.venv/bin/pip install -e '.[dev]'
.venv/bin/python scripts/data_server.py --help
.venv/bin/python scripts/data_server.py 8802 /data/latent-scope-3d
```

In another terminal:

```bash
cd frontend
npm ci
npm run dev
```

Open `http://localhost:5300`. The dataset picker above Settings changes packs;
`?dataset=bl-160` selects one directly and `?synthetic=1` runs the procedural
fallback without a data server.

For a deployment where data lives on another origin, set
`VITE_DATA_ORIGIN=https://data.example.org` when running `npm run build`.
Otherwise serve the four data routes under the frontend's own origin.
During development, `LSV_DATA_PROXY_TARGET` can override Vite's default
`http://localhost:8802` proxy target.

## Controls

- Drag to look; WASD flies, Space/Shift moves vertically, and double-tap W sprints.
- Hold on a textured voxel to extract its points into Inventory.
- Click Inventory's header to collapse its list; the minimap stays docked at
  the bottom. Click a stack to reveal thumbnails, or its **Go** button to fly
  to the source block.
- `1` equips the empty hand (one point per mining cycle); `2` equips the Pickaxe
  (up to 100 points per cycle); `3` equips X-ray (glass view).
- The Effector Field is always active; scroll over the 3D world to resize its
  radius (default: two voxels). Physical rectangular markers show the boundary while scrolling,
  then fade out. Hovering a block turns the cursor into a count/depletion dial.
- Hover or click the minimap to relate the independent 2D and 3D UMAP fits.

## Data pipeline

`pipeline/src/lsvoxel` owns the binary formats, pack construction, and
validation. Dataset entry scripts live in `pipeline/scripts`; for example:

```bash
cd pipeline
.venv/bin/python scripts/run_chunkpack_bl.py 160 -160
.venv/bin/python scripts/run_minimap_bl.py
```

Chunk packs are built and validated in a sibling staging directory, then
published as a directory swap. New packs use occupied-only, power-of-two KTX2
atlases with no unused mip chain; the frontend continues to accept legacy
fixed-layout packs.

## Checks

```bash
cd frontend
npm test
npm run typecheck
npm run build

cd ../pipeline
.venv/bin/pytest -q
```

The tests emphasize binary-contract correctness, cache/resource ownership,
streaming retries and stationary-frame scheduling, indexed minimap queries,
compact atlas layout, and atomic publication. The BasisU end-to-end pack test
is skipped when the `basisu` executable is unavailable.
