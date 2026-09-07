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
with SigLIP 2; hover a result to aim, click to fly to it.

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
while its models load. The current sci-fi skin is a prototype; a library-specific
visual theme is planned separately.
