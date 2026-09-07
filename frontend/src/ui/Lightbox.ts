import { setThumbnailSource } from "../streaming/ThumbnailSource.ts";
import {
  LIGHTBOX_ORIGINAL_CACHE_MAX_BYTES,
  LIGHTBOX_ORIGINAL_CACHE_MAX_ROWS,
  LIGHTBOX_ORIGINAL_CROSSFADE_MS,
  LIGHTBOX_ORIGINAL_MAX_VIEWPORT_FRAC,
  LIGHTBOX_ORIGINAL_TIMEOUT_MS,
  SYNTHETIC_MAX_THUMB_PX,
  SYNTHETIC_SUBSET_PREFIX,
} from "../config.ts";
import { fetchPointMeta, originHostname, peekPointMeta, type PointMeta } from "../streaming/PointMeta.ts";
import { WeightedLruCache } from "../utils/WeightedLruCache.ts";
import { applyHudPanelChrome, HUD_CLASS } from "./hudPanel.ts";
import { ImageMetadata } from "./ImageMetadata.ts";
import type { MetadataClient, FilterQuery } from "../metadata/MetadataClient.ts";

/** What the lightbox needs in order to page through a whole stack without
 * being handed (or preloading) every URL up front. */
export interface LightboxSource {
  /** The FULL row_id list of the stack being browsed — live, not a copy, so a
   * point returned to its voxel while the lightbox is open disappears from the
   * carousel too (the index is re-clamped on the next step). */
  rowIds: { readonly length: number; at(index: number): number | undefined };
  /** Where in `rowIds` to start — the thumbnail that was actually clicked. */
  index: number;
  /** row_id → thumbnail URL. Called lazily, once per navigation step. */
  resolveUrl: (rowId: number) => string | null | Promise<string | null>;
  /** row_id → the point's subset name (`covers`, `synthetic-flux-klein`, …),
   * or `null` when unknown. Only consulted for a row whose `/meta` record has
   * no original, to say WHY: a synthetic image has no larger copy anywhere,
   * a BL cover simply has no Flickr original on record. */
  resolveSubsetName: (rowId: number) => string | null;
  /** Trailing context line, e.g. `chunk 97 · voxel 2970`. */
  contextLabel: string;
}

export interface LightboxOptions {
  metadataClient?: MetadataClient;
  onMetadataFilter?: (query: FilterQuery) => void;
  /** Points-table id for the `/meta/<points_id>/<row_id>` original-image
   * lookup (`DatasetConfig.pointsId`). `null` disables the lookup entirely —
   * the lightbox is then thumbnail-only, with no status line, exactly as it
   * was before originals existed. */
  pointsId: string | null;
}

/**
 * Where the current row's original stands. Exposed (with `status`) for the
 * headless harness and console; the status line is the human rendering.
 *
 *   `idle`         no lookup configured (no `pointsId`), or closed
 *   `checking`     `/meta` in flight
 *   `loading`      `/meta` said there is an original; the image is in flight
 *   `shown`        the original is on screen in place of the thumbnail
 *   `unavailable`  there IS a URL on record, but it failed or timed out
 *   `none`         no original exists on record (synthetic image, BL cover)
 *   `unreachable`  the `/meta` lookup itself failed (server or network), so
 *                  whether an original exists is not known; nothing is
 *                  cached and paging back to the row asks again
 */
export type LightboxOriginalState =
  | "idle"
  | "checking"
  | "loading"
  | "shown"
  | "unavailable"
  | "none"
  | "unreachable";

/** One row's original as the cache remembers it: the decoded `Image` (kept
 * alive so paging back is a DOM insert, not a refetch or a re-decode), or
 * `"failed"` so a dead link is not retried — and not re-waited-on for 15 s —
 * every time the carousel passes over it. */
type CachedOriginal = HTMLImageElement | "failed";

class OriginalsCache {
  private readonly entries: WeightedLruCache<number, CachedOriginal>;

  constructor(onEvict: (entry: CachedOriginal) => void) {
    this.entries = new WeightedLruCache({
      maxEntries: LIGHTBOX_ORIGINAL_CACHE_MAX_ROWS,
      maxWeight: LIGHTBOX_ORIGINAL_CACHE_MAX_BYTES,
      weightOf: (entry) =>
        entry === "failed" ? 0 : entry.naturalWidth * entry.naturalHeight * 4,
      onEvict,
    });
  }

  get(rowId: number): CachedOriginal | undefined {
    return this.entries.get(rowId);
  }

  set(rowId: number, entry: CachedOriginal): boolean {
    return this.entries.set(rowId, entry);
  }

  /** Row ids currently cached, least recently visited first. */
  rowIds(): number[] {
    return this.entries.keys();
  }

  clear(): void {
    this.entries.clear();
  }
}

type ImageLoadResult = HTMLImageElement | null | undefined;

interface ImageLoadTask {
  /** `undefined` means explicitly canceled; `null` means failed/timed out. */
  promise: Promise<ImageLoadResult>;
  cancel(): void;
}

/**
 * "View bigger" modal for inventory thumbnails, with arrow-key navigation
 * through the rest of the stack.
 *
 * ## Two images, one box
 *
 * Every row shows its LOCAL thumbnail first — the same 256 px file the
 * inventory grid uses, on screen immediately, exactly as before — and then
 * asks the data server (`/meta/<points_id>/<row_id>`, see
 * `streaming/PointMeta.ts`) whether a full-resolution original exists for it
 * on the open web. If one does, it is loaded off-DOM and, once decoded,
 * cross-faded in over the thumbnail; the lightbox grows to show it at up to
 * `LIGHTBOX_ORIGINAL_MAX_VIEWPORT_FRAC` of the viewport. The status line
 * under the image narrates every step so nothing is ever silently
 * "loading": what is being fetched and how big it is, where it came from
 * (with an "open ↗" link to the source), or — the honest cases — that the
 * link is dead, that a BL cover has no original on record, or that a
 * synthetic MONET image has no larger copy anywhere.
 *
 * The thumbnail-first discipline is what keeps this cheap: originals never
 * delay the local image. Only the current row may have an original request in
 * flight, and decoded images are retained under a byte-weighted LRU budget.
 *
 * ## Carousel (Phase 6.5)
 *
 * The important part is what it iterates: the stack's ENTIRE `rowIds` list,
 * not the ~60 thumbnails the grid happens to have rendered — a stack can hold
 * thousands of points and the grid pages through them
 * `INVENTORY_THUMBS_PAGE_SIZE` at a time. Navigation resolves and loads
 * exactly one thumbnail (and at most one original) per step; nothing is
 * prefetched, so opening a 7,098-point stack costs the same as opening a
 * 4-point one.
 */
export class Lightbox {
  private metadata: ImageMetadata | null = null;
  private readonly root: HTMLElement;
  /** Holds the thumbnail (in flow, so it sizes the box) and, once one has
   * loaded, the original stacked over it. Sized explicitly only while an
   * original is showing; otherwise the thumbnail's own size is the box. */
  private readonly stage: HTMLElement;
  private readonly img: HTMLImageElement;
  private readonly statusEl: HTMLElement;
  private readonly statusTextEl: HTMLElement;
  private readonly openLink: HTMLAnchorElement;
  private readonly caption: HTMLElement;
  private readonly counter: HTMLElement;

  private readonly pointsId: string | null;

  private source: LightboxSource | null = null;

  /** Bumped on every `show()` and `close()`. An async continuation started
   * for row N compares the token it captured against this before touching
   * the DOM; a mismatch means the user has moved on and it must do nothing. */
  private showToken = 0;

  /** The original element currently stacked over the thumbnail, if any. */
  private shownOriginal: HTMLImageElement | null = null;
  private shownOriginalCached = false;
  private originalState: LightboxOriginalState = "idle";
  private statusString = "";

  private readonly originals: OriginalsCache;
  /** At most the current row's original is allowed to consume network/decode. */
  private loading: { rowId: number; task: ImageLoadTask } | null = null;
  private metaLookup: { token: number; controller: AbortController } | null = null;

  constructor(container: HTMLElement, options: LightboxOptions) {
    this.pointsId = options.pointsId;
    this.originals = new OriginalsCache((entry) => this.handleOriginalEvicted(entry));

    this.root = document.createElement("div");
    this.root.className = "ls-lightbox";
    Object.assign(this.root.style, {
      position: "fixed",
      inset: "0",
      display: "none",
      alignItems: "center",
      justifyContent: "center",
      flexDirection: "column",
      gap: "10px",
      // Cyan-tinted blackout rather than neutral: the whole HUD is one cool
      // phosphor palette, and a neutral scrim reads as a different app.
      background: "rgba(2, 9, 13, 0.86)",
      zIndex: "50",
      cursor: "zoom-out",
      pointerEvents: "auto",
    } satisfies Partial<CSSStyleDeclaration>);
    // Click anywhere in the overlay (backdrop, frame, or image) to close — the
    // simplest, most discoverable dismissal for this modal. The frame added
    // below is a plain container that stops nothing, so this still holds; the
    // one exception is the "open ↗" link, which stops its own click.
    this.root.addEventListener("click", () => this.close());

    // Frame wrapper so the image + caption sit inside one piece of cockpit
    // chrome (the shared `hudPanel` frame) instead of floating on the scrim.
    // No max-width of its own any more: the stage inside is what bounds the
    // picture (256 px for a thumbnail, a viewport fraction for an original),
    // and the frame simply wraps it.
    const frame = document.createElement("div");
    Object.assign(frame.style, {
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      gap: "8px",
      padding: "12px 12px 9px",
      maxWidth: "96vw",
    } satisfies Partial<CSSStyleDeclaration>);
    applyHudPanelChrome(frame, { variant: "inset" });

    this.stage = document.createElement("div");
    this.stage.className = "ls-lightbox-stage";
    Object.assign(this.stage.style, {
      position: "relative",
      // Kills the descender gap an inline <img> leaves under itself, so the
      // stage's box is exactly the image's box and the overlay lines up.
      lineHeight: "0",
      background: "#04141b",
      border: "1px solid var(--hud-line)",
    } satisfies Partial<CSSStyleDeclaration>);
    frame.appendChild(this.stage);

    this.img = document.createElement("img");
    this.img.className = "ls-lightbox-thumb";
    Object.assign(this.img.style, {
      display: "block",
      // The thumbnail shows at its native 256 px (a bigger, un-cramped view
      // of what the 28 px grid cell showed) and never exceeds the viewport
      // in the degenerate case of a tiny window.
      maxWidth: "88vw",
      maxHeight: "72vh",
      objectFit: "contain",
    } satisfies Partial<CSSStyleDeclaration>);
    this.stage.appendChild(this.img);

    // Status line: what is happening with this row's original. Not
    // uppercased like the caption, because it carries hostnames and pixel
    // sizes that need to stay readable as written.
    this.statusEl = document.createElement("div");
    this.statusEl.className = "ls-lightbox-status";
    Object.assign(this.statusEl.style, {
      display: "flex",
      alignItems: "baseline",
      gap: "10px",
      fontSize: "10px",
      letterSpacing: "0.06em",
      fontFamily: "var(--hud-font)",
      lineHeight: "1.4",
      // Fixed height so the frame doesn't jump between a one-part and a
      // two-part status; the text is a single line at every state.
      minHeight: "14px",
    } satisfies Partial<CSSStyleDeclaration>);
    this.statusTextEl = document.createElement("span");
    this.statusTextEl.className = "ls-lightbox-status-text";
    this.statusTextEl.classList.add(HUD_CLASS.dim);
    this.openLink = document.createElement("a");
    this.openLink.className = "ls-lightbox-open";
    this.openLink.textContent = "open ↗";
    this.openLink.target = "_blank";
    this.openLink.rel = "noopener noreferrer";
    // Same policy the image load uses: the source host must not learn where
    // it is being embedded from, and some hosts serve nothing to a referrer
    // they don't recognise.
    this.openLink.referrerPolicy = "no-referrer";
    this.openLink.hidden = true;
    Object.assign(this.openLink.style, {
      color: "var(--hud-accent-bright)",
      textDecoration: "none",
      borderBottom: "1px solid var(--hud-line)",
      textTransform: "uppercase",
      letterSpacing: "0.14em",
      cursor: "pointer",
      whiteSpace: "nowrap",
    } satisfies Partial<CSSStyleDeclaration>);
    // Following the link must not also dismiss the modal behind it.
    this.openLink.addEventListener("click", (event) => event.stopPropagation());
    this.statusEl.append(this.statusTextEl, this.openLink);
    this.statusEl.hidden = this.pointsId === null;
    frame.appendChild(this.statusEl);

    this.caption = document.createElement("div");
    this.caption.classList.add(HUD_CLASS.dim);
    Object.assign(this.caption.style, {
      fontSize: "10px",
      letterSpacing: "0.08em",
      textTransform: "uppercase",
      fontFamily: "var(--hud-font)",
    } satisfies Partial<CSSStyleDeclaration>);
    frame.appendChild(this.caption);
    if (options.metadataClient) {
      this.metadata = new ImageMetadata(options.metadataClient, query => { options.onMetadataFilter?.(query); this.close(); });
      Object.assign(this.metadata.element.style, { maxHeight: "22vh", overflowY: "auto", maxWidth: "650px", textAlign: "left" });
      frame.append(this.metadata.element);
    }

    this.counter = document.createElement("div");
    this.counter.className = "ls-lightbox-counter";
    this.counter.classList.add(HUD_CLASS.readout);
    Object.assign(this.counter.style, {
      fontSize: "10px",
      letterSpacing: "0.14em",
      textTransform: "uppercase",
      fontFamily: "var(--hud-font)",
    } satisfies Partial<CSSStyleDeclaration>);
    frame.appendChild(this.counter);

    this.root.appendChild(frame);
    container.appendChild(this.root);

    window.addEventListener("keydown", this.handleKeyDown);
    // An original is sized against the viewport at the moment it is shown;
    // keep it fitting if the window changes underneath it.
    window.addEventListener("resize", this.handleResize);
  }

  /** Whether the modal is currently showing. */
  get isOpen(): boolean {
    return this.source !== null;
  }

  /** Index into the current source's `rowIds`, or -1 when closed. */
  get currentIndex(): number {
    return this.source ? this.source.index : -1;
  }

  /** row_id currently displayed, or -1 when closed. */
  get currentRowId(): number {
    return this.source ? (this.source.rowIds.at(this.source.index) ?? -1) : -1;
  }

  /** The status line as rendered (without the "open ↗" link text). */
  get status(): string {
    return this.statusString;
  }

  /** See `LightboxOriginalState`. */
  get state(): LightboxOriginalState {
    return this.originalState;
  }

  /** `src` of the original currently on screen over the thumbnail, or
   * `null` while the thumbnail is what's showing. */
  get originalSrc(): string | null {
    return this.shownOriginal?.src ?? null;
  }

  /** URL of the original on record for the current row (the "open ↗" link),
   * whether or not it loaded; `null` when none is offered. */
  get originalUrl(): string | null {
    return this.openLink.hidden ? null : this.openLink.href;
  }

  /** Rows whose original (or failure) is cached, least recently visited first. */
  get cachedOriginalRowIds(): number[] {
    return this.originals.rowIds();
  }

  open(source: LightboxSource): void {
    this.source = { ...source, index: clampIndex(source.index, source.rowIds.length) };
    this.root.style.display = "flex";
    this.show();
  }

  /** Moves `delta` positions through the stack, wrapping at both ends (so a
   * single Left from the first item lands on the last — a 60-item page in a
   * 7,098-point stack makes "walk backwards to the end" a real use). No-op
   * when closed. Returns the new index, or -1. */
  step(delta: number): number {
    const source = this.source;
    if (!source) return -1;
    const length = source.rowIds.length;
    if (length === 0) {
      this.close();
      return -1;
    }
    source.index = (((source.index + delta) % length) + length) % length;
    this.show();
    return source.index;
  }

  close(): void {
    this.metadata?.clear();
    this.showToken++;
    this.cancelMetaLookup();
    this.cancelOriginalLoad();
    this.root.style.display = "none";
    this.source = null;
    this.clearOriginal();
    this.setStatus("", "idle", null);
  }

  private show(): void {
    const source = this.source;
    if (!source) return;
    const length = source.rowIds.length;
    if (length === 0) {
      this.close();
      return;
    }
    // Anything started for the previous row is now stale — see `showToken`.
    const token = ++this.showToken;
    this.cancelMetaLookup();
    this.cancelOriginalLoad();
    source.index = clampIndex(source.index, length);
    const rowId = source.rowIds.at(source.index)!;
    this.metadata?.show(rowId);
    this.img.removeAttribute("src");
    void Promise.resolve(source.resolveUrl(rowId)).then(url => {
      if (token === this.showToken && url) setThumbnailSource(this.img, url, () => token === this.showToken);
    }).catch(() => { if (token === this.showToken) this.img.alt = "Thumbnail lookup failed; navigate to retry"; });
    const caption = `row ${rowId} — ${source.contextLabel}`;
    this.img.alt = caption;
    this.caption.textContent = caption;
    this.counter.textContent =
      length > 1
        ? `◄ ${(source.index + 1).toLocaleString()} / ${length.toLocaleString()} ►  ·  arrow keys`
        : "1 / 1";

    // Back to the thumbnail-only box first; the original for THIS row (if
    // any) is layered on afterwards.
    this.clearOriginal();
    if (this.pointsId === null) {
      this.setStatus("", "idle", null);
      return;
    }

    // Fast path: both the record and the decoded original are already in
    // hand, so paging back to a row is a synchronous DOM insert — no
    // "checking …" flash, no microtask gap.
    const knownMeta = peekPointMeta(this.pointsId, rowId);
    const cached = this.originals.get(rowId);
    if (knownMeta?.url && cached instanceof HTMLImageElement) {
      this.presentOriginal(cached, knownMeta, true, true);
      return;
    }

    this.setStatus("checking for original …", "checking", null);
    void this.resolveOriginal(token, rowId);
  }

  /**
   * The async half of `show()`: look the row up, then fetch its original.
   * Every step re-checks `token` before touching the DOM. Obsolete metadata
   * and image requests are canceled; a decoded image that wins the race with
   * cancellation is released rather than cached for a row no longer shown.
   */
  private async resolveOriginal(token: number, rowId: number): Promise<void> {
    const pointsId = this.pointsId;
    if (pointsId === null) return;
    const controller = new AbortController();
    this.metaLookup = { token, controller };
    const meta = await fetchPointMeta(pointsId, rowId, controller.signal);
    if (this.metaLookup?.token === token) this.metaLookup = null;
    if (token !== this.showToken) return;

    if (meta === undefined) {
      // The lookup failed, not the row: say so rather than "no record", and
      // leave the door open — nothing was cached, so paging back retries.
      this.setStatus("original lookup failed · paging back retries", "unreachable", null);
      return;
    }
    if (meta === null) {
      this.setStatus("original not available (no record)", "none", null);
      return;
    }
    if (meta.url === null) {
      const subset = this.source?.resolveSubsetName(rowId) ?? null;
      if (subset?.startsWith(SYNTHETIC_SUBSET_PREFIX)) {
        this.setStatus(
          `synthetic image · no larger image exists · ${SYNTHETIC_MAX_THUMB_PX} px is the largest available`,
          "none",
          null,
        );
      } else {
        this.setStatus("original not available", "none", null);
      }
      return;
    }

    const cached = this.originals.get(rowId);
    if (cached === "failed") {
      this.setStatus(unavailableStatus(meta), "unavailable", meta.url);
      return;
    }
    if (cached) {
      this.presentOriginal(cached, meta, true, true);
      return;
    }

    this.setStatus(`loading original · ${meta.width} x ${meta.height} …`, "loading", meta.url);
    const image = await this.loadOriginal(rowId, meta.url);
    if (image === undefined) return;
    if (token !== this.showToken) {
      if (image) releaseImage(image);
      return;
    }
    if (image) {
      this.presentOriginal(image, meta, false, false);
      this.shownOriginalCached = this.originals.set(rowId, image);
    } else {
      this.originals.set(rowId, "failed");
      this.setStatus(unavailableStatus(meta), "unavailable", meta.url);
    }
  }

  private loadOriginal(rowId: number, url: string): Promise<ImageLoadResult> {
    if (this.loading?.rowId === rowId) return this.loading.task.promise;
    this.cancelOriginalLoad();
    const task = loadImage(url, LIGHTBOX_ORIGINAL_TIMEOUT_MS);
    this.loading = { rowId, task };
    void task.promise.finally(() => {
      if (this.loading?.task === task) this.loading = null;
    });
    return task.promise;
  }

  /** Puts a loaded original on screen over the thumbnail, growing the box to
   * fit it. `instant` skips the cross-fade (a cached row paging back in). */
  private presentOriginal(
    image: HTMLImageElement,
    meta: PointMeta,
    instant: boolean,
    cached: boolean,
  ): void {
    this.clearOriginal();
    image.className = "ls-lightbox-original";
    image.alt = this.img.alt;
    Object.assign(image.style, {
      position: "absolute",
      inset: "0",
      width: "100%",
      height: "100%",
      objectFit: "contain",
      display: "block",
      opacity: "0",
      transition: instant ? "none" : `opacity ${LIGHTBOX_ORIGINAL_CROSSFADE_MS}ms ease`,
    } satisfies Partial<CSSStyleDeclaration>);
    this.stage.appendChild(image);
    this.shownOriginal = image;
    this.shownOriginalCached = cached;
    this.fitStageTo(image);
    // Force the opacity:0 start state to be committed before flipping it, or
    // the browser coalesces both writes and there is no transition to run.
    void image.offsetWidth;
    image.style.opacity = "1";
    // Real pixel size from the decoded image, not the record — the two agree
    // for every row checked, but the image is the thing on screen.
    this.setStatus(
      `original · ${image.naturalWidth} x ${image.naturalHeight} · ${originHostname(image.src)}`,
      "shown",
      meta.url,
    );
  }

  /** Sizes the stage to show `image` at its native size, shrunk (never
   * enlarged) to `LIGHTBOX_ORIGINAL_MAX_VIEWPORT_FRAC` of the viewport. The
   * thumbnail underneath is stretched to the same box so the cross-fade is
   * between two pictures of the same size. */
  private fitStageTo(image: HTMLImageElement): void {
    const [fracW, fracH] = LIGHTBOX_ORIGINAL_MAX_VIEWPORT_FRAC;
    const maxW = window.innerWidth * fracW;
    const maxH = window.innerHeight * fracH;
    const nw = Math.max(1, image.naturalWidth);
    const nh = Math.max(1, image.naturalHeight);
    const scale = Math.min(1, maxW / nw, maxH / nh);
    const w = Math.max(1, Math.round(nw * scale));
    const h = Math.max(1, Math.round(nh * scale));
    this.stage.style.width = `${w}px`;
    this.stage.style.height = `${h}px`;
    Object.assign(this.img.style, {
      width: "100%",
      height: "100%",
      maxWidth: "none",
      maxHeight: "none",
    } satisfies Partial<CSSStyleDeclaration>);
  }

  /** Back to the thumbnail-only box. The removed element stays in the cache
   * (it is the cache entry) for as long as the cache keeps it, ready to be
   * re-inserted. */
  private clearOriginal(): void {
    if (this.shownOriginal) {
      const image = this.shownOriginal;
      this.shownOriginal.remove();
      this.shownOriginal = null;
      if (!this.shownOriginalCached) releaseImage(image);
      this.shownOriginalCached = false;
    }
    this.stage.style.width = "";
    this.stage.style.height = "";
    Object.assign(this.img.style, {
      width: "",
      height: "",
      maxWidth: "88vw",
      maxHeight: "72vh",
    } satisfies Partial<CSSStyleDeclaration>);
  }

  private setStatus(text: string, state: LightboxOriginalState, openUrl: string | null): void {
    this.statusString = text;
    this.originalState = state;
    this.statusTextEl.textContent = text;
    // A shown original's status is a readout (lit); every other state is a
    // dim aside under the picture.
    this.statusTextEl.classList.toggle(HUD_CLASS.readout, state === "shown");
    this.statusTextEl.classList.toggle(HUD_CLASS.dim, state !== "shown");
    if (openUrl) {
      this.openLink.href = openUrl;
      this.openLink.hidden = false;
    } else {
      this.openLink.removeAttribute("href");
      this.openLink.hidden = true;
    }
  }

  private handleKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      this.close();
      return;
    }
    if (!this.source) return;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    // Swallow it: an open modal owns the arrow keys outright, and letting the
    // event through would also scroll the page behind the scrim.
    event.preventDefault();
    event.stopPropagation();
    this.step(event.key === "ArrowRight" ? 1 : -1);
  };

  private handleResize = (): void => {
    if (this.shownOriginal) this.fitStageTo(this.shownOriginal);
  };

  private cancelOriginalLoad(): void {
    const loading = this.loading;
    if (!loading) return;
    this.loading = null;
    loading.task.cancel();
  }

  private cancelMetaLookup(): void {
    this.metaLookup?.controller.abort();
    this.metaLookup = null;
  }

  private handleOriginalEvicted(entry: CachedOriginal): void {
    if (!(entry instanceof HTMLImageElement)) return;
    if (entry === this.shownOriginal) {
      this.shownOriginalCached = false;
      return;
    }
    releaseImage(entry);
  }

  dispose(): void {
    this.close();
    this.originals.clear();
    this.img.src = "";
    window.removeEventListener("keydown", this.handleKeyDown);
    window.removeEventListener("resize", this.handleResize);
    this.root.remove();
  }
}

function unavailableStatus(meta: PointMeta): string {
  return `original unavailable (link dead) · ${meta.width} x ${meta.height}`;
}

/**
 * Loads `url` into an off-DOM `Image`, resolving the element once decoded
 * or `null` on error / after `timeoutMs`. Never rejects.
 *
 * `referrerPolicy = "no-referrer"`: some of the crawl-source hosts refuse
 * hotlinked requests by referrer, and none of them has any business knowing
 * this page's URL. `crossOrigin` is deliberately NOT set — the image is only
 * displayed, never read back into a canvas, and an anonymous CORS request
 * would be refused by every host that doesn't send `Access-Control-Allow-
 * Origin`, which is most of them.
 *
 * On timeout the in-flight request is abandoned by clearing `src`, which is
 * the only way to cancel an `<img>` fetch; the handlers are detached first so
 * that the `error` event the clear fires does not double-settle.
 */
function loadImage(url: string, timeoutMs: number): ImageLoadTask {
  let cancel = (): void => undefined;
  const promise = new Promise<ImageLoadResult>((resolve) => {
    const image = new Image();
    image.referrerPolicy = "no-referrer";
    image.decoding = "async";
    let settled = false;
    const settle = (result: ImageLoadResult): void => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      image.onload = null;
      image.onerror = null;
      resolve(result);
    };
    const timer = window.setTimeout(() => {
      settle(null);
      image.src = "";
    }, timeoutMs);
    image.onload = () => {
      // A 200 with an empty/undecodable body still fires `load` in some
      // browsers; a 0x0 image is no original.
      settle(image.naturalWidth > 0 && image.naturalHeight > 0 ? image : null);
    };
    image.onerror = () => settle(null);
    cancel = () => {
      if (settled) return;
      image.onload = null;
      image.onerror = null;
      image.src = "";
      settle(undefined);
    };
    image.src = url;
  });
  return { promise, cancel: () => cancel() };
}

function releaseImage(image: HTMLImageElement): void {
  image.remove();
  image.src = "";
}

function clampIndex(index: number, length: number): number {
  if (length === 0) return 0;
  return Math.max(0, Math.min(length - 1, index));
}
