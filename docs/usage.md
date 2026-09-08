# Using latent-craft

The dataset picker selects a map release. Settings starts collapsed; expand it
to adjust flight speed, effector radius, and the image-count filter.

## Navigation and collection

- Drag on the scene to look; WASD flies, Space/Shift moves up/down. Double-tap W
  to sprint. Clicking the scene returns keyboard focus to navigation.
- Scroll over the scene to resize the effector field. Its default radius is two
  voxels. Resizing displays solid boundary markers, including in empty space.
- `1`: empty hand, one image per extraction cycle. `2`: pickaxe, up to 100 images
  per cycle. Hold a textured voxel to collect images.
- `3`: X-ray. Colors show original image counts on a fixed logarithmic scale
  from 1 to 10,000+. The hovered/focused voxel alone displays an opaque thumbnail.
- Hover the minimap to relate 2D and 3D neighborhoods; click to fly there.
- Inventory's **Go** button flies to a collected block. Focusing a block expands
  its thumbnails and reduces the others to compact rows.

The default filter hides voxels with two images or fewer. Counts are original
occupancy, not remaining inventory. Filtering does not remove images from the
dataset or inventory, and does not currently reduce atlas downloads.

## Search

The BL publication profile uses SigLIP 2 text embeddings and FAISS SQ8. Hover a
result to aim at its voxel; click to collect that exact image and fly there.
Already-held images are not duplicated. Results are paginated in groups of eight.

The 103.8M CLIP map uses the existing MONET disk-mapped IVF/PQ FAISS index and a
verified ANN-to-map row join. Its results have the same navigation/collection
behavior. A separate training-map prototype compares projection-only navigation
with exact search.

Search is optional and hidden on maps without a compatible profile, including
DINO. The map can run while its search worker warms or is unavailable.

## Phones and tablets

Before loading the map, the mobile layout explains expected data use: budget
roughly 5–15 MB to begin, with ongoing exploration potentially exceeding 100 MB.
This is guidance, not a lifetime transfer cap. Continue to load the map, or copy
its URL for a computer without loading map assets.

Use the D-pad to fly, the right arrows for vertical movement, and drag the scene
with another finger to look. Hold a voxel for a larger thumbnail and slow
single-image collection. The previous image remains visible while the next loads.
The minimap and automatic sharp band are omitted; inventory shows small thumbs.
Large collections are paginated, not discarded. `?mobile=1` previews touch layout
on a desktop; `?mobile=0` forces the desktop layout.

## Saved inventory

Inventory and movement settings persist in localStorage per dataset and pack
release. Another hostname, port, browser profile, or private session has separate
storage. Changing a visual theme does not change the dataset/save identity.

Export CSV for a portable backup, including image URLs. Import replaces the
current inventory after validation and confirmation. The importer checks rows
against the map and rejects mixed datasets or inconsistent posting state.
CSV exports include `selected_row_ids` for out-of-order search selections;
the importer also accepts legacy 13-column inventories. Older application builds
cannot import the extended format. Inventory grows with collected images and is
subject to browser storage quotas; keep a CSV backup if the app reports a save
failure.

## Image resolution

Compact base atlases normally use 32px tiles with quantized sampling. A bounded
128px preview pool sharpens hovered voxels and a one-voxel band outside the
effector. X-ray suppresses the band and retains only the focused image. An
untouched voxel sharpens its atlas representative; mining advances the preview
to a remaining row. The inventory lightbox can request the original source image
when metadata and the provider make one available.
