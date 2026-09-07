# Local BL iteration: inventory, settings, and density X-ray

7 September 2026. These changes are local; the HF Space has not been redeployed.

[Open the BL build](http://gsv.local:5303/) or [read all review notes in Moonshine](http://gsv.local:5196/).

## Current choices

The BL search UI now uses FAISS SQ8 only. The backend experiment and its Lance
artifacts remain available for reproducibility; they have not been removed from
the deployed worker. Settings starts collapsed on every page load. The occupancy
filter starts enabled and hides voxels containing **two images or fewer**.
Old off/1 defaults migrate once; subsequent explicit choices are preserved.

Search results use pages of eight, with no scrolling search container. Clicking
a result collects that exact image, focuses it in the inventory, and flies to its
voxel. Clicking an already-held result focuses it without duplicating it. The
collection is verified with 56 bytes of map identity/metadata reads; it does not
load the whole chunk or scan a voxel's posting list.

Out-of-order selections are tracked separately from the sequential mining cursor.
Mining skips those rows later. Returning a selected image makes it available to
mine again. Local saves retain this state. CSV adds a `selected_row_ids` column;
the updated importer still reads the original 13-column files. New exports need
the updated app, not the older public HF build.

## X-ray as an image-count heatmap

X-ray replaces thumbnail surfaces with colors derived from the original image
count in each voxel, not how many images remain after mining. The hovered/focused
voxel alone keeps an opaque image preview. Ordinary sharp-band image previews
resume when X-ray is switched off.

The fixed logarithmic scale is 1, 10, 100, 1,000, and 10,000+ images per voxel.
Colors are not renormalized per chunk or camera position. Counts at or above
10,000 share the final color. The on-screen legend shows the endpoints.

Fine proxies use their exact count. Coarse proxy bricks use peak child counts
when those counts have already been fetched for filtering; otherwise they use
the mean per unit voxel, not their larger aggregate total. Region placeholders
without voxel detail stay neutral. These coarse colors are approximations until
the finer brick arrives; they must not be read as exact voxel counts.

Density colors use the existing count metadata and one per-instance scalar.
There is no new corpus-sized asset, search service, or thumbnail fetch for the
heatmap. X-ray retains true alpha blending and instance sorting. Normal view
returns to the original atlas material and coverage rendering.

## Review before another deployment

Please try search collection, returning an image, saving/reloading, and X-ray
navigation in the local build. The remaining publication choices are in the
[BL deployment/theme notes](bl-demo-publication.md): choose a code license before
the reusable repo's public release, and agree on the dataset-descriptor versus
visual-theme boundary before the wood/library skin. FAISS SQ8 is already settled.

The [full search experiment](bl-search-experiment.md), all measurements, the older
hosting comparison, and architecture/release notes are in the Moonshine series.
