---
title: latent-craft · MONET 100M
emoji: 🌌
colorFrom: indigo
colorTo: blue
sdk: docker
app_port: 7860
short_description: Fly and search through 103.8 million images
---

# latent-craft · MONET

Explore 103,816,750 images in a streaming voxel world. The independent 2D and
3D maps project CLIP ViT-B/32 embeddings with basemap heads trained on 4M images.
Text search uses the publisher's full IVF/PQ FAISS index, opened from local disk,
and a verified join from index IDs to map rows. No vector index loads in the browser.

Drag to look, WASD to fly, Space/Shift for up/down. Scroll to resize the effector.
Hold a block to collect images. Keys 1/2/3 select hand, bulk pickaxe, and density
X-ray. Hover a search result to aim; click to collect that image and fly there.
Phones get a data-use notice, D-pad, hold-to-preview and compact saved inventory.
Exploring new areas continues to transfer data; use Wi-Fi when practical.

This independent research demo uses [Jasper's MONET dataset](https://huggingface.co/datasets/jasperai/monet)
and [OpenAI CLIP ViT-B/32](https://huggingface.co/openai/clip-vit-base-patch32).
The dataset card declares Apache-2.0 for its release; source-image rights remain
with their respective owners. CLIP's model export is under MIT. No blanket
license for all displayed images or project source is implied.

The collection mixes web and synthetic imagery and may include offensive or
sensitive content. Similarity search is not moderation or a factual classifier.

Inventory/settings stay in this browser unless exported as CSV. Search phrases
are sent to the Space; the application does not intentionally save query history.
Cloudflare R2/CDN receives map and 128px thumbnail requests. CPU Basic may sleep;
a fresh worker downloads its verified artifacts before search is ready.
Memory mapping saves eager RAM allocation, but the operating system's disk page
cache grows with use; it is not a fixed total-memory limit.

[Source and setup](https://github.com/enjalot/latent-craft)
