# Dataset and model provenance

Dataset names identify the embedding model separately from the sampling rule
and projection. An “SSCD draw” selects images using SSCD-derived sampling; the
legacy MONET draw maps still project CLIP vectors, not SSCD vectors.

| Dataset profile | Embedding | Projection | Images |
| --- | --- | --- | ---: |
| `bl-160` | Google SigLIP 2 SO400M patch16-256, 1152D | Independent 2D / 3D UMAP | 1,080,814 |
| MONET full CLIP, 512³ | OpenAI CLIP ViT-B/32, 512D | Paired 4M-trained basemap heads | 103,816,750 |
| MONET full DINO, 6M heads, 512³ | DINOv2 ViT-g/14, centered PCA to 768D, then L2 normalization | Paired 6M-trained basemap heads | 103,816,750 |
| MONET full DINO, 12M heads, 512³ | DINOv2 ViT-g/14, reused 6M-fitted PCA-768, then L2 normalization | Paired 12M-trained basemap heads | 103,816,750 |
| MONET random / SSCD / ANN draw arms | OpenAI CLIP ViT-B/32, 512D | Independent 2D / 3D UMAP | 2,000,000 each |

The full-corpus row layout is the initial 19,344,847-row pool followed by
84,471,903 complementary rows. Each map has a separate geometric address table;
sharing thumbnail references does not make CLIP and DINO voxel IDs interchangeable.
See [full-corpus construction and audit](full-corpus-monet.md).

The 12M DINO draw contains the earlier 6M training rows plus six million new
ones; its PCA basis is deliberately unchanged. Its head checkpoints begin
`7c38430a492a1ff5` (2D) and `a786ede1f47bdff6` (3D). New voxel assignments require
a separate saved-game identity even though source-image row IDs are shared.

## Search identity

BL text encoding uses Google's SigLIP 2 checkpoint
`e8708ab72d125807e45b36fb7d4e0aacbb59f379`. The exported text tower is checked
against a saved query vector before serving its SQ8 index.

MONET text encoding uses OpenAI CLIP ViT-B/32 revision
`3d74acf9a28c67741b2f4f2ea7635f0aaf6f0268`. The existing full-corpus IVF4096/PQ64x8
index uses a different row order from the maps. Its publisher ANN IDs are joined
through source shard + original ID and perceptual hash. All 198 collided ANN
entries were resolved by exact stored IVF/PQ code comparison against the source
vectors; the final table is a one-to-one permutation of all 103,816,750 map rows.
Another 1,026 spread/random source-vector code checks agreed. The search worker
and client are bound to the compact 4M CLIP map's row-to-voxel SHA-256.

This index must not be attached to the DINO map without a separately verified
map-address binding. CLIP similarity and DINO neighborhoods are different
representations even when the image IDs overlap.

## Image origins and rights

BL imagery comes from British Library Labs via
[Daniel van Strien's dataset mirror](https://huggingface.co/datasets/biglam/british-library-book-images).
Its original image release carries the Public Domain Mark / no known copyright
restrictions. On-demand book metadata preserves source subset and row pointers,
rather than guessing identity from an image filename.

MONET comes from [Jasper's dataset](https://huggingface.co/datasets/jasperai/monet),
whose release is labeled Apache-2.0. The collection combines web and synthetic
images. Individual source-image rights remain with their owners; a dataset
release license is not a blanket new license for every displayed image.

The full-corpus thumbnail store covers the complete published row layout.
Original URL metadata currently covers only the initial pool. Complement rows
use their thumbnail fallback; unavailable originals are not replaced by guessed
URLs or different images.

The CLIP text export retains its MIT license; the SigLIP export retains
Apache-2.0. Model notices, dependency notices and generated-theme provenance
are separate from the as-yet-unspecified project source license.

## Legacy UMAP runs

The retained 2M MONET draw fits recorded cosine distance, 25 neighbors,
`min_dist=0`, seed 42 and independent 2D / 3D coordinates. Their saved environment
reports UMAP 0.6.0 from the project's development installation. Historical helper
revision `67ca365` was recorded by the fit helper, not independently reconstructed
from a surviving source checkout. New basemap releases instead carry explicit
checkpoint/input receipts and sampled CPU re-inference checks.
