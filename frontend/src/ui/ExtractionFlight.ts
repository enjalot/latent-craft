import { EXTRACTION_FLIGHT_MS } from "../config.ts";
import { HUD_CLASS } from "./hudPanel.ts";

export interface ExtractionFlightRequest {
  /** Launch point, viewport CSS pixels — the extracted voxel's screen
   * position. */
  fromX: number;
  fromY: number;
  /** Landing point, viewport CSS pixels — the inventory panel. */
  toX: number;
  toY: number;
  /** Thumbnail for the batch's lead point, or `null` (falls back to a plain
   * lit tile — `point_index.bin` may still be loading on the very first
   * extraction of a session). */
  url: string | null;
  /** How many points this batch carried; rendered as a "+N" badge. */
  count: number;
}

const TILE_PX = 44;

/**
 * The little "something just went into your inventory" flourish: one
 * thumbnail-sized tile per completed extraction cycle, flying from the voxel's
 * on-screen position to the inventory panel and fading out.
 *
 * **One element per CYCLE, not per point.** Each cycle extracts exactly one
 * point today (`config.ts#extractionBatchSize` is pinned to 1 — "one thumb at
 * a time", by explicit design), so `count` is currently always 1 and the "+N"
 * badge always reads "+1". The count-based design is kept anyway rather than
 * simplified to a hardcoded single thumbnail: it's the same reasoning
 * `extractionBatchSize` itself was kept as a function for — if the batch size
 * ever changes again, this animation already scales (one tile, a "+N" badge,
 * not N DOM nodes per cycle) instead of needing a second pass.
 *
 * Implementation is deliberately the cheap one the plan asked for: a plain
 * absolutely-positioned `div` with a CSS transition on `transform`/`opacity`,
 * removed on `transitionend`. No rAF loop, no library, nothing to tick — the
 * compositor owns the whole animation, so it costs nothing on the render
 * thread that is already busy drawing the world.
 *
 * Chrome comes from the shared HUD tokens (`HUD_CLASS.thumb`, `--hud-line`,
 * `--hud-title`), not from bespoke CSS — same rule every other panel follows.
 */
export class ExtractionFlights {
  /** Exposed so the headless verification harness can slow a flight down and
   * screenshot it mid-air, which a 620ms transition otherwise makes a race.
   * Nothing in the app writes it. */
  durationMs = EXTRACTION_FLIGHT_MS;

  private readonly live = new Set<HTMLElement>();

  constructor(private readonly container: HTMLElement) {}

  /** How many tiles are in the air right now (harness/HUD readout). */
  get activeCount(): number {
    return this.live.size;
  }

  launch(request: ExtractionFlightRequest): HTMLElement {
    const tile = document.createElement("div");
    tile.className = "ls-extraction-flight";
    tile.setAttribute("aria-hidden", "true");
    Object.assign(tile.style, {
      position: "fixed",
      left: `${request.fromX - TILE_PX / 2}px`,
      top: `${request.fromY - TILE_PX / 2}px`,
      width: `${TILE_PX}px`,
      height: `${TILE_PX}px`,
      zIndex: "40",
      pointerEvents: "none",
      backgroundColor: "#04141b",
      backgroundSize: "cover",
      backgroundPosition: "center",
      border: "1px solid var(--hud-line)",
      boxShadow: "0 0 12px rgba(70, 200, 224, 0.45)",
      opacity: "0.96",
      willChange: "transform, opacity",
      transition: `transform ${this.durationMs}ms cubic-bezier(0.34, 0.05, 0.4, 1), opacity ${this.durationMs}ms ease-in`,
    } satisfies Partial<CSSStyleDeclaration>);
    tile.classList.add(HUD_CLASS.thumb);
    if (request.url) tile.style.backgroundImage = `url("${request.url}")`;

    if (request.count > 1) {
      const badge = document.createElement("div");
      badge.className = "ls-extraction-flight__count";
      badge.textContent = `+${request.count.toLocaleString()}`;
      Object.assign(badge.style, {
        position: "absolute",
        left: "0",
        right: "0",
        bottom: "0",
        padding: "1px 0",
        textAlign: "center",
        fontFamily: "var(--hud-font)",
        fontSize: "9px",
        letterSpacing: "0.06em",
        color: "var(--hud-title)",
        background: "rgba(2, 9, 13, 0.82)",
      } satisfies Partial<CSSStyleDeclaration>);
      tile.appendChild(badge);
    }

    this.container.appendChild(tile);
    this.live.add(tile);

    const dx = request.toX - request.fromX;
    const dy = request.toY - request.fromY;

    const finish = (): void => {
      if (!this.live.delete(tile)) return;
      tile.remove();
    };
    tile.addEventListener("transitionend", finish, { once: true });
    // Belt and braces: a transition on an element in a background tab (or one
    // whose transition never starts because the layout was already final)
    // never fires `transitionend`, which would leak the node forever.
    window.setTimeout(finish, this.durationMs + 400);

    // Two frames, not one: the first commits the tile at its start position,
    // the second changes the properties being transitioned. Setting both in
    // the same frame makes the browser coalesce them and skip the animation
    // entirely (the classic "transition doesn't run on a freshly-inserted
    // element" trap).
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        tile.style.transform = `translate(${dx}px, ${dy}px) scale(0.3)`;
        tile.style.opacity = "0.05";
      });
    });

    return tile;
  }

  /** Removes every in-flight tile immediately (page teardown). */
  clear(): void {
    for (const tile of this.live) tile.remove();
    this.live.clear();
  }
}
