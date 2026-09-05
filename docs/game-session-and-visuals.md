# Game saves and visual pass — September 5, 2026

The marker layout and lighting below describe the earlier pass. See
[distance-stable rendering](distance-stable-rendering.md) for the subsequent
fixed-physical-size markers, revised budgets, shading and image-identity fix.

Settings replaces Telemetry and shares its 420px dock width with the dataset
picker. Movement instructions remain in the collapsible header. Flight defaults
to **8 voxel cells/second**, adjustable from 1–64, with the existing double-W
sprint. At 512³ this is 1.5625 world units/s, versus the previous 8. The effector
slider and wheel share the same live radius; camera position, direction, speed
and radius restore separately for each immutable dataset release.

## Inventory persistence

Browser-local key: `lsv-game-v1:<dataset key>:<immutable pack path>`.
Inventory changes schedule one write within 750ms, including during continuous
mining; pagehide/HMR flushes pending work. Flight settings are tiny separate
writes, at most every two seconds and on exit. No save serialization in the
render loop. The saved stack includes row order, posting cursor, returned-row
queue, source voxel identity, total count, representative and timestamps. Reload
therefore restores depletion and the next image, not just the inventory display.

CSV has one row per mined image, including an absolute thumbnail URL. Block
metadata appears on that block's first row. Import validates dataset/release,
integer bounds, duplicate identities and count invariants before reading only
the consumed posting prefixes to verify membership against the map. It replaces
the inventory atomically after validation, with confirmation if nonempty;
imported URLs are references, never fetch instructions. Downloads resolve at
most 32 thumbnail references concurrently; imports accept files up to 64 MiB.

localStorage is not unlimited or cross-device storage. A quota/security failure
keeps the previous successful save and explicitly prompts CSV backup. This is
appropriate for personal collecting; very large collections would warrant
IndexedDB or server-backed persistence later.

## Visual/rendering changes

- 32px atlases use nearest magnification and linear minification. No added
  texture bytes; 128px sharp previews retain smooth sampling and mipmaps.
- Effector markers are 72 closed beveled solids, merged into one draw, with
  centres on the real spherical boundary whether or not any voxels are nearby.
  Slots do not rotate/pop as the radius changes. Bar proportions are 1:.2:.2,
  up to one voxel long, reduced for small fields to maintain clearance.
- A camera-centred sphere has no visible silhouette: a fixed angular layout
  looks unchanged when scaled. The three rings now deliberately open their
  angular aperture with radius, replacing fixed 3/6/9 geodesic offsets. This
  produces visible expansion/contraction while preserving true boundary depth.
- Warm key, cool rim, ACES highlight rolloff and a one-time 128px PMREM light-card
  environment give coated blocks highlights. No bloom, shadow maps, per-frame
  environment capture or additional full-screen passes. 128px image color is
  unchanged. The environment adds a small fixed texture, independent of dataset.
- Edge housings are slimmer, close-fitting pale metal with graphite channels,
  derivative-filtered brushed grain, fine seams and ceramic corner inlays.
  Existing instanced cage draws and depletion behavior are retained.
- Missing hierarchy regions use opacity .16 instead of .08.
- The baked sky is sampled on one fullscreen triangle instead of a camera-
  enclosing cube. This removes the flat polygon seams reproduced in WebGL
  at the basemap spawn view; it replaces the existing background draw, without
  another texture, pass, or per-frame procedural sky computation.

### Mining-border flicker

Previously any partially mined sharp image moved **all** sharp previews into the
transparent queue. Their draw order tied with the depth-write-free cages, so
unrelated nearby borders could be overpainted. Normal previews now remain in the
opaque/depth-writing MSAA coverage path, before cages. Only X-ray switches queues
(and it hides cages). Replacement cubes use the exact original transform, not
an enlarged overlay. A zero-opacity source also bypasses coverage dithering.

Verification includes deterministic radius/clearance/screen-aperture tests,
render-queue regression tests, bounded preview/CSV concurrency, save corruption
and round-trip tests, and flight-speed tests. A focused browser check verified
99-image reload and CSV round trips including a returned image, synchronized
settings, and increasing ring extents at radii 2/8/24 with no shader errors.
Additional browser checks rejected a CSV with wrong posting membership without
changing inventory, preserved the last save under simulated storage-quota
failure, and verified that 160/512 dataset switches do not mix progress.
