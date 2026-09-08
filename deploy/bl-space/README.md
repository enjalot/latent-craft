---
title: latent-craft · British Library
emoji: 📚
colorFrom: yellow
colorTo: blue
sdk: docker
app_port: 7860
short_description: Fly, search, and collect a million historic book images
---

# latent-craft · British Library

An experimental 3D explorer for 1,080,814 historic book images. Drag to look,
WASD to fly, Space/Shift for up/down. Scroll to resize the effector. Hold a
block to collect images; 2 equips the bulk pickaxe, 3 enables X-ray. Search
with SigLIP 2 and FAISS SQ8; hover a result to aim, click to fly to it and
collect that exact image. X-ray shows density colors, except at the hovered block.

On phones: accept the data-use notice, use the D-pad to fly, drag to look,
and hold a block for a larger thumbnail and slow collection. The smaller mobile
working set omits the minimap. Exploration continues to use data; Wi-Fi is
recommended. Inventory and settings stay local, with CSV export/import.

Book titles, recorded publication years, source-image links and type/book/year
filters load on demand. Search filters the 24 retrieved candidates, not the
whole ANN index. The minimap always shows the full collection.

This is an **independent demo, not an official British Library product**.
Images come from British Library Labs' digitised books, via Daniel van Strien's
[British Library Book Images dataset](https://huggingface.co/datasets/biglam/british-library-book-images).
The original release carries the Public Domain Mark / no known copyright
restrictions. The model is Google's
[SigLIP 2 SO400M patch16-256](https://huggingface.co/google/siglip2-so400m-patch16-256),
revision `e8708ab72d125807e45b36fb7d4e0aacbb59f379` (Apache-2.0).

Historical images may contain offensive depictions and reflect the selection
biases of the original collection. This is not a representative sample of world
history, and similarity search is not a curatorial classification.

Progress stays in this browser, scoped to the dataset. Export CSV to keep a
portable backup. Search phrases are sent to this Space for embedding; no query
history is intentionally persisted. Google Cloud Storage serves the map and
thumbnail bytes, and Flickr may serve original images when opened. Those
providers receive the corresponding network requests.

CPU Basic may sleep. Search can take time to warm; the map remains available
while its models load. Wood-grain borders, a wood-styled HUD, and a generated
library-inspired interior are a dataset theme—not a photograph or exact
reconstruction of a British Library reading room.

[Source and local setup](https://github.com/enjalot/latent-craft) ·
[Data formats and streaming](https://github.com/enjalot/latent-craft/blob/master/docs/streaming-architecture.md)
