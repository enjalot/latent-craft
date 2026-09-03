import type { MinimapPack } from "./Manifest.ts";

/**
 * Composites one zoom level of the pack's pre-rendered density PNGs into a
 * single canvas, once, at load — the minimap's static base image.
 *
 * ## Why this is so much simpler than `latent-basemap/mapviewer`
 *
 * That viewer (the production 2D map this pack's format was borrowed from) has
 * a WebGL2 tile pipeline, an LRU tile cache, per-corpus `.u32` plane
 * recomposition, and progressive LOD point rendering — all of which exist to
 * support a full-screen map the user pans and zooms through a multi-corpus
 * text corpus. This minimap is a fixed 220px overview panel that always shows
 * the entire embedding and never pans or zooms, so:
 *
 * - the base is composited **once** into a plain 2D canvas (no camera
 *   transform, no per-frame GPU pipeline, no tile streaming);
 * - the pack's **pre-rendered combined PNGs** are used directly instead of
 *   recomposing the per-corpus `.u32` count planes, because nothing here
 *   toggles corpora on and off (4 PNGs ≈ 145 KB at z1, versus 4 MB of u32
 *   planes for the same level);
 * - only the marker overlay (`MinimapRenderer`'s second canvas) ever redraws.
 *
 * ## The one thing the PNGs need fixing up for
 *
 * `render_png` (pipeline side) draws log1p(count) through matplotlib's YlGnBu
 * with **empty bins forced to opaque white** — right for a light-background
 * document map, wrong for a dark cockpit HUD, where it would paint a bright
 * white square over the corner of the screen. `remapForDarkPanel` below
 * converts each pixel back to a density weight and re-colorizes it (see its
 * own comment).
 */
export interface DensityBase {
  canvas: HTMLCanvasElement;
  /** Zoom level actually composited. */
  zoom: number;
  /** Canvas edge in bins (`tile_bins * tiles_per_side`). */
  sizeBins: number;
  /** How many tiles the level's index listed vs. how many decoded cleanly. */
  tilesExpected: number;
  tilesDrawn: number;
}

export async function composeDensityBase(
  pack: MinimapPack,
  zoom: number,
  signal?: AbortSignal,
): Promise<DensityBase> {
  const index = await pack.densityIndex(zoom, signal);
  const sizeBins = pack.tileBins * index.tiles_per_side;

  const canvas = document.createElement("canvas");
  canvas.width = sizeBins;
  canvas.height = sizeBins;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("minimap: could not get a 2D context for the density base");

  const keys = Object.keys(index.tiles);
  let tilesDrawn = 0;
  await Promise.all(
    keys.map(async (key) => {
      const [txRaw, tyRaw] = key.split("_");
      const tx = Number(txRaw);
      const ty = Number(tyRaw);
      if (!Number.isInteger(tx) || !Number.isInteger(ty)) return;
      const url = pack.url(`density/z${zoom}/${tx}_${ty}.png`);
      try {
        const response = await fetch(url, { signal });
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        const bitmap = await createImageBitmap(await response.blob());
        ctx.drawImage(bitmap, tx * pack.tileBins, ty * pack.tileBins);
        bitmap.close();
        tilesDrawn++;
      } catch (error) {
        // A missing/undecodable tile leaves that region transparent, which
        // reads the same as "no points here" — degrade rather than fail the
        // whole panel.
        console.warn(`[minimap] density tile z${zoom}/${tx}_${ty} failed`, error);
      }
    }),
  );

  remapForDarkPanel(ctx, sizeBins);

  return { canvas, zoom, sizeBins, tilesExpected: keys.length, tilesDrawn };
}

/**
 * Turns the pack's white-background YlGnBu density image into a
 * transparent-background "glow" image suitable for a dark HUD panel.
 *
 * YlGnBu's luminance is strictly monotonically DECREASING in density (pale
 * yellow #ffffd9 at the low end through to near-black navy #081d58 at the
 * high end), and empty bins are forced to pure white, so `1 - luminance`
 * recovers a monotone density weight `t` with empty bins landing exactly at 0.
 * That weight is then re-colorized through the ramp below and given an alpha,
 * so:
 *
 * - empty space becomes fully transparent (the panel's own dark background
 *   shows through) instead of a white block;
 * - **brighter now means denser**, which is the opposite of YlGnBu's own
 *   ordering but the intuitive reading for a glowing overlay on black. The
 *   ordering is still monotone in density, so the map means the same thing.
 *
 * The alpha curve is deliberately generous at the low end (`0.16 + 1.5t`):
 * a bin holding a single point is only ~0.07 of the way down YlGnBu's
 * luminance range, and at a straight `alpha = t` the sparse outskirts of the
 * embedding — which is exactly where a "fly over there and look" target is
 * interesting — would be invisible.
 */
function remapForDarkPanel(ctx: CanvasRenderingContext2D, sizeBins: number): void {
  const image = ctx.getImageData(0, 0, sizeBins, sizeBins);
  const px = image.data;
  for (let i = 0; i < px.length; i += 4) {
    // Untouched (never-drawn) pixels are already transparent; leave them.
    if (px[i + 3] === 0) continue;
    const luminance = (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]) / 255;
    const t = Math.min(1, Math.max(0, 1 - luminance));
    if (t <= 0.004) {
      px[i + 3] = 0;
      continue;
    }
    const s = Math.min(1, t / 0.85);
    rampColor(s, px, i);
    px[i + 3] = Math.round(255 * Math.min(1, 0.16 + 1.5 * t));
  }
  ctx.putImageData(image, 0, 0);
}

/** Low→high density ramp: dim steel blue → teal → mint → pale yellow-white.
 * Mirrors YlGnBu's hue progression but reversed in brightness so density
 * reads as glow on a dark ground. */
const RAMP: Array<[number, number, number, number]> = [
  [0.0, 0x2c, 0x5c, 0x8f],
  [0.35, 0x2f, 0xa8, 0xa0],
  [0.7, 0x86, 0xe0, 0xa6],
  [1.0, 0xf4, 0xf8, 0xcd],
];

function rampColor(s: number, out: Uint8ClampedArray, offset: number): void {
  let hi = 1;
  while (hi < RAMP.length - 1 && s > RAMP[hi][0]) hi++;
  const a = RAMP[hi - 1];
  const b = RAMP[hi];
  const span = b[0] - a[0] || 1;
  const f = Math.min(1, Math.max(0, (s - a[0]) / span));
  out[offset] = a[1] + (b[1] - a[1]) * f;
  out[offset + 1] = a[2] + (b[2] - a[2]) * f;
  out[offset + 2] = a[3] + (b[3] - a[3]) * f;
}
