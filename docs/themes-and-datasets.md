# Dataset descriptors and visual themes

`frontend/src/datasets/registry.ts` defines map paths, stable points-table IDs,
optional minimaps and static point metadata, search profiles, streaming profiles,
and collection attribution. `config.ts` re-exports the registry for existing
callers. Release overrides preserve the public dataset keys and saved-game IDs.

`frontend/src/themes/registry.ts` defines decorative appearance independently:
lighting colors, fog, background artwork, shared border texture, and artwork
attribution. BL selects `library`; datasets without a theme retain `nebula`.
Use `?theme=library` or `?theme=nebula` for visual comparison without changing
data, search configuration, inventory identity or CSV contents. `?sky=0` omits
the background texture but keeps the selected HUD and border materials.

Library HUD styles are scoped to `data-theme="library"`. Image pixels, minimap
data and X-ray density colors are not recolored by CSS. Library block borders
share one oak texture across chunk materials; evicting a chunk disposes its
material, not that shared texture. The engine disposes theme textures at teardown.
The panorama is a distant background without positional parallax or collisions.
No extra shadow-map or postprocessing passes are introduced.

The generated artwork and its prompts are recorded in
`frontend/public/themes/library/provenance.json`. Both PNG assets total
4,706,817 bytes. They load asynchronously, only for the library skin; chunk
streaming does not wait for them. These are prototype source-resolution assets,
not compressed GPU textures. With mipmaps their combined texture storage is
approximately 16 MiB, excluding browser image decoding and any separate CSS copy.

## BL residency profile

`streamingProfile: "bl-wide"` opts compact streaming BL packs into the wider
policy. Legacy uncompressed-layout packs retain the default policy.

| Setting | Default / MONET | Compact BL |
|---|---:|---:|
| Immediate loading radius, chunk widths | 1.5 | 1.5 |
| Background loading radius | 2.5 | 5 |
| Retention radius | 3.5 | 6 |
| Chunk admission cap | 96 | 256 |
| Conservative reservation cap | 384 MiB | 384 MiB |
| Voxel instance admission cap | 98,304 | 98,304 |
| Concurrent chunk loads | 6 | 6 |
| Preview visibility | Separate 2.2/2.4 distance gates | All resident chunks |

Default streaming admission currently retains only its loading-radius prefix;
the 3.5 retention radius remains relevant to classification and legacy behavior.
BL explicitly retains warm resident or in-flight chunks within its outer band
using remaining budget, without starting requests for cold outer-band chunks.
Current loading candidates always take precedence over warm retention.
Admission reserves RGBA atlas bytes, metadata, and 1 KiB per occupied voxel,
including requests that have not finished. It does not skip an expensive near
chunk to admit cheaper distant ones. Teleport destinations retain explicit priority.

Chunks appear as they finish. Neither the wider radius nor the count cap
introduces an all-chunks startup barrier. Detailed cages and the 128px sharp band
retain their independent nearby limits.
