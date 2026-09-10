/**
 * Dataset registry. Switching which chunk-pack the explorer renders is a
 * one-line change to `DEFAULT_DATASET` (or a `?dataset=` query param at
 * runtime) — nothing downstream hardcodes "bl".
 *
 * `path` is fetched same-origin (relative to the page) and proxied by Vite's
 * dev server (see `vite.config.ts`'s `server.proxy`) through to the static
 * data server (port 8802 by default; `LSV_DATA_PROXY_TARGET` overrides it).
 * A direct cross-port browser fetch to :8802 was
 * tried first and gets blocked by Chrome's Private/Local Network Access
 * policy once the page is served over plain http from a LAN hostname like
 * gsv.local — proxying through Vite's Node process sidesteps that entirely,
 * and incidentally means the same build works unmodified from localhost, any
 * LAN IP, or gsv.local.
 */
export interface DatasetAttribution {
  title: string;
  description: string;
  links: ReadonlyArray<{ label: string; url: string }>;
  rights: string;
  warning?: string;
}

export interface DatasetConfig {
  /** Decorative skin only; never part of data or saved-game identity. */
  theme?: "nebula" | "library";
  attribution?: DatasetAttribution;
  /** Path on the chunk server to the directory holding `manifest.json`. */
  path: string;
  /** Human-readable label for the HUD. */
  label: string;
  /**
   * Id of the POINTS TABLE this chunk-pack was binned from — the `<points_id>`
   * segment of the data server's per-row original-image lookup,
   * `GET /meta/<points_id>/<row_id>` (see `streaming/PointMeta.ts`). This is
   * NOT the chunk-pack id: a points table is one UMAP fit's worth of rows,
   * and every voxel resolution built from it shares the same `row_id`s, so
   * `bl` and `bl-160` both look up `bl`, and each MONET arm's 96^3 and 160^3
   * packs both look up that arm (`monet-random`, …). Required rather than
   * defaulted from the key so that a new pack can't silently ask the server
   * about a table that doesn't exist (a 404 there reads as "no original for
   * any row", which is exactly the kind of quiet wrongness a lookup like this
   * should never produce).
   */
  pointsId: string;
  /**
   * Path to this dataset's 2D minimap pack (Phase 5), or absent for a dataset
   * that has no 2D pack built yet — in which case the app simply runs without
   * a minimap panel rather than failing.
   *
   * Note both BL chunk-packs point at the SAME minimap pack: the 2D pack is
   * built from the 2-component UMAP fit of the points table, which is
   * independent of the 3D fit and completely independent of the voxel
   * resolution a chunk-pack was binned at.
   */
  minimapPath?: string;
  /**
   * Where this dataset's thumbnails are rooted on the chunk server. The
   * manifest's own `thumb_url_template` supplies everything after it, so the
   * two together are the full URL (see `streaming/PointIndex.ts`'s
   * `resolveThumbUrl`). Defaults to `THUMBS_BASE_PATH` (`/thumbs`).
   *
   * BL sets it to `/thumbs/bl` because BL's already-built packs carry a
   * template with no dataset-family segment (`{subset_name}/{local_idx:08d}
   * .webp`) — the family lives in the base for those. MONET's template carries
   * its own `monet/` segment, so it takes the default.
   */
  thumbsBasePath?: string;
  pointMetaFile?: { path: string; bytes: number; rows: number };
  searchProfile?: "bl-siglip2-20260907a" | "clip-training" | "clip-full-4m-20260906a";
  streamingProfile?: "bl-wide";
  /** Optional release-bound metadata/filter API; absent means no facets. */
  metadataEndpoint?: string;
}

const ALL_DATASETS: Record<string, DatasetConfig> = {
  "monet-dino-basemap-full-12m-pca768-512": {
    path: "/chunks/monet-dino-basemap-full-12m-pca768-20260910a-512-web-20260910a",
    label: "MONET · DINOv2 ViT-g/14 · PCA-768 · 12M head · 103.82M · 512³",
    pointsId: "monet-dino-basemap-full-12m-pca768-20260910a",
    minimapPath: "/minimap/monet-dino-basemap-full-12m-pca768-20260910a",
    pointMetaFile: { path: "/points/monet-clip-basemap-pool-20260905a/point_meta.bin", rows: 19344847, bytes: 1887424406 },
  },
  "monet-dino-basemap-full-6m-pca768-512": {
    path: "/chunks/monet-dino-basemap-full-6m-pca768-20260908a-512-web-20260908b",
    label: "MONET · DINOv2 ViT-g/14 · PCA-768 · 6M head · 103.82M · 512³",
    pointsId: "monet-dino-basemap-full-6m-pca768-20260908a",
    minimapPath: "/minimap/monet-dino-basemap-full-6m-pca768-20260908a",
    pointMetaFile: { path: "/points/monet-clip-basemap-pool-20260905a/point_meta.bin", rows: 19344847, bytes: 1887424406 },
  },
  "monet-clip-basemap-full-4m-512": {
    searchProfile: "clip-full-4m-20260906a",
    path: "/chunks/monet-clip-basemap-full-4m-20260906a-512-web-20260908b",
    label: "MONET · CLIP ViT-B/32 · 4M head · 103.82M · 512³",
    pointsId: "monet-clip-basemap-full-4m-20260906a",
    minimapPath: "/minimap/monet-clip-basemap-full-4m-20260906a",
    pointMetaFile: { path: "/points/monet-clip-basemap-pool-20260905a/point_meta.bin", rows: 19344847, bytes: 1887424406 },
    attribution: {
      title: "latent-craft · MONET 100M",
      description: "Independent explorer of Jasper's MONET collection. CLIP ViT-B/32 embeddings, 4M-trained basemap heads, and disk-backed FAISS search.",
      links: [{ label: "MONET dataset", url: "https://huggingface.co/datasets/jasperai/monet" },
        { label: "CLIP model", url: "https://huggingface.co/openai/clip-vit-base-patch32" },
        { label: "Source code", url: "https://github.com/enjalot/latent-craft" }],
      rights: "Dataset release: Apache-2.0. CLIP model: MIT. Individual source-image rights remain with their owners; no blanket image or project-code license is implied.",
      warning: "Web and synthetic imagery may contain offensive or sensitive content. Similarity is not moderation. Queries go to the search worker; inventory stays in this browser. Original URLs cover the initial 19.34M pool; other rows retain thumbnail previews.",
    },
  },
  "monet-clip-basemap-pool-512": {
    path: "/chunks/monet-clip-basemap-pool-20260905a-512-stream",
    label: "MONET · CLIP ViT-B/32 · basemap · 19.34M · 512³",
    pointsId: "monet-clip-basemap-pool-20260905a",
    minimapPath: "/minimap/monet-clip-basemap-pool-20260905a",
  },
  "monet-clip-basemap-training-512": {
    searchProfile: "clip-training",
    path: "/chunks/monet-clip-basemap-training-20260905a-512-stream",
    label: "MONET · CLIP ViT-B/32 · basemap · 2.01M · 512³",
    pointsId: "monet-clip-basemap-training-20260905a",
    minimapPath: "/minimap/monet-clip-basemap-training-20260905a",
  },
  // Display the projection embedding separately from the sampling arm. MONET's
  // SSCD label describes how rows were drawn, not the embedding used by UMAP.
  // Verified source/model evidence: docs/dataset-provenance.md. Keep URL keys and
  // points IDs stable so bookmarks and row metadata still address the same data.
  "bl-160": {
    path: "/chunks/bl-160",
    label: "BL · SigLIP 2 · 1.08M · 160³",
    pointsId: "bl",
    minimapPath: "/minimap/bl",
    thumbsBasePath: "/thumbs/bl",
    streamingProfile: "bl-wide",
    theme: "library",
    attribution: {
      title: "British Library",
      description: "1,080,814 images from British Library Labs’ digitised books. An independent explorer, not an official British Library product.",
      links: [
        { label: "Daniel van Strien’s dataset mirror", url: "https://huggingface.co/datasets/biglam/british-library-book-images" },
        { label: "Google SigLIP 2 embedding model", url: "https://huggingface.co/google/siglip2-so400m-patch16-256" },
      ],
      rights: "Original image release: Public Domain Mark / no known copyright restrictions.",
      warning: "Historical material may contain offensive depictions. The collection reflects institutional and digitisation choices, not a representative sample of history.",
    },
  },
  // MONET draw arms (jasperai/monet, 2M points each). Each arm is a different
  // sampling of the same 19.3M-row pool, so they are separate packs end to end
  // — separate points table, UMAP fit, chunk pack and minimap pack. Thumbnails
  // are served by the data server's dynamic `/thumbs/monet/<packed>.webp`
  // route (MONET's are byte ranges inside packed blobs, not files), which the
  // pack's own `thumb_url_template` addresses — hence no `thumbsBasePath`
  // override here.
  // Each draw's resolutions share points, coordinates and minimap identity;
  // only voxel binning changes.
  "monet-random-160": {
    path: "/chunks/monet-random-160",
    label: "MONET · CLIP ViT-B/32 · random draw · 2M · 160³",
    pointsId: "monet-random",
    minimapPath: "/minimap/monet-random",
  },
  "monet-sscd-160": {
    path: "/chunks/monet-sscd-160-stream-20260904b",
    label: "MONET · CLIP ViT-B/32 · SSCD draw · 2M · 160³",
    pointsId: "monet-sscd",
    minimapPath: "/minimap/monet-sscd",
  },
  "monet-sscd-512": {
    path: "/chunks/monet-sscd-512-stream-20260905a",
    label: "MONET · CLIP ViT-B/32 · SSCD draw · 2M · 512³",
    pointsId: "monet-sscd",
    minimapPath: "/minimap/monet-sscd",
  },
  "monet-annfaiss-160": {
    path: "/chunks/monet-annfaiss-160",
    label: "MONET · CLIP ViT-B/32 · ANN-FAISS draw · 2M · 160³",
    pointsId: "monet-annfaiss",
    minimapPath: "/minimap/monet-annfaiss",
  },
  // The fourth arm, the research project's own faiss-based rarity draw. Its
  // packs are built by the same per-arm chain as the other three.
  "monet-theirfaiss-160": {
    path: "/chunks/monet-theirfaiss-160",
    label: "MONET · CLIP ViT-B/32 · their-FAISS draw · 2M · 160³",
    pointsId: "monet-theirfaiss",
    minimapPath: "/minimap/monet-theirfaiss",
  },
};

/**
 * Default when no dataset query is supplied. Resolution changes belong in
 * the pipeline; compact atlases avoid a full 2048² texture for sparse chunks.
 * Standalone builds below whitelist only their deployed release.
 */
export const DEFAULT_DATASET = import.meta.env.VITE_DEMO_DATASET || "monet-sscd-512";
const REGISTERED_DATASETS: Record<string, DatasetConfig> = import.meta.env.VITE_DEMO_DATASET === "bl-160"
  ? { "bl-160": { ...ALL_DATASETS["bl-160"], path: "/chunks/bl-siglip2-160-stream-20260907a",
      searchProfile: "bl-siglip2-20260907a",
      metadataEndpoint: "/api/metadata/bl-20260907a",
      pointMetaFile: { path: "/points/bl/point_meta.bin", bytes: 77049305, rows: 1080814 } } }
  : ALL_DATASETS;

// A standalone publication must not offer research maps whose assets weren't deployed.
const demo = import.meta.env.VITE_DEMO_DATASET;
if (demo && !REGISTERED_DATASETS[demo]) throw new Error(`Unknown demo dataset: ${demo}`);
export const DATASETS: Record<string, DatasetConfig> = demo ? { [demo]: REGISTERED_DATASETS[demo] } : REGISTERED_DATASETS;
