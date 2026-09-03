import { applyHudPanelChrome, HUD_CLASS } from "./hudPanel.ts";

/** What the lightbox needs in order to page through a whole stack without
 * being handed (or preloading) every URL up front. */
export interface LightboxSource {
  /** The FULL row_id list of the stack being browsed — live, not a copy, so a
   * point returned to its voxel while the lightbox is open disappears from the
   * carousel too (the index is re-clamped on the next step). */
  rowIds: readonly number[];
  /** Where in `rowIds` to start — the thumbnail that was actually clicked. */
  index: number;
  /** row_id → thumbnail URL. Called lazily, once per navigation step. */
  resolveUrl: (rowId: number) => string | null;
  /** Trailing context line, e.g. `chunk 97 · voxel 2970`. */
  contextLabel: string;
}

/**
 * "View bigger" modal for inventory thumbnails, with arrow-key navigation
 * through the rest of the stack.
 *
 * Honesty note (per the project plan's own dataset-readiness research): the
 * British Library thumbnails served at `/thumbs/bl/<subset>/<idx>.webp` —
 * the same files the inventory grid already uses — are the ONLY image
 * resolution available on this machine (max-256px-longest-side WebP; no
 * separate full-resolution originals were downloaded). So "view bigger" here
 * means exactly that: rendering the SAME file at a larger on-screen size
 * (the browser upscales it), not fetching a higher-detail source. There is
 * no higher-detail source to fetch.
 *
 * Phase 6.5 added the carousel. The important part is what it iterates: the
 * stack's ENTIRE `rowIds` list, not the ~60 thumbnails the grid happens to
 * have rendered — a stack can hold thousands of points and the grid pages
 * through them `INVENTORY_THUMBS_PAGE_SIZE` at a time. Navigation resolves and
 * loads exactly one image per step (the browser's own cache handles
 * backtracking), matching the lazy-loading discipline the grid already
 * follows; nothing is prefetched, so opening a 16,770-point stack costs the
 * same as opening a 4-point one.
 */
export class Lightbox {
  private readonly root: HTMLElement;
  private readonly img: HTMLImageElement;
  private readonly caption: HTMLElement;
  private readonly counter: HTMLElement;

  private source: LightboxSource | null = null;

  constructor(container: HTMLElement) {
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
    // below is a plain container that stops nothing, so this still holds.
    this.root.addEventListener("click", () => this.close());

    // Frame wrapper so the image + caption sit inside one piece of cockpit
    // chrome (the shared `hudPanel` frame) instead of floating on the scrim.
    const frame = document.createElement("div");
    Object.assign(frame.style, {
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      gap: "8px",
      padding: "12px 12px 9px",
      maxWidth: "min(92vw, 680px)",
    } satisfies Partial<CSSStyleDeclaration>);
    applyHudPanelChrome(frame, { variant: "inset" });

    this.img = document.createElement("img");
    Object.assign(this.img.style, {
      // Deliberately allowed to exceed the source's native ~256px — that IS
      // "bigger," honestly achieved by upscaled display, not a claim of more
      // detail (see class doc).
      maxWidth: "min(88vw, 640px)",
      maxHeight: "72vh",
      objectFit: "contain",
      background: "#04141b",
      border: "1px solid var(--hud-line)",
      borderRadius: "0",
    } satisfies Partial<CSSStyleDeclaration>);
    frame.appendChild(this.img);

    this.caption = document.createElement("div");
    this.caption.classList.add(HUD_CLASS.dim);
    Object.assign(this.caption.style, {
      fontSize: "10px",
      letterSpacing: "0.08em",
      textTransform: "uppercase",
      fontFamily: "var(--hud-font)",
    } satisfies Partial<CSSStyleDeclaration>);
    frame.appendChild(this.caption);

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
    return this.source ? (this.source.rowIds[this.source.index] ?? -1) : -1;
  }

  open(source: LightboxSource): void {
    this.source = { ...source, index: clampIndex(source.index, source.rowIds.length) };
    this.root.style.display = "flex";
    this.show();
  }

  /** Moves `delta` positions through the stack, wrapping at both ends (so a
   * single Left from the first item lands on the last — a 60-item page in a
   * 16,770-point stack makes "walk backwards to the end" a real use). No-op
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
    this.root.style.display = "none";
    this.source = null;
  }

  private show(): void {
    const source = this.source;
    if (!source) return;
    const length = source.rowIds.length;
    if (length === 0) {
      this.close();
      return;
    }
    source.index = clampIndex(source.index, length);
    const rowId = source.rowIds[source.index];
    const url = source.resolveUrl(rowId);
    // Only the CURRENT image is ever requested — see class doc.
    this.img.src = url ?? "";
    const caption = `row ${rowId} — ${source.contextLabel}`;
    this.img.alt = caption;
    this.caption.textContent = caption;
    this.counter.textContent =
      length > 1
        ? `◄ ${(source.index + 1).toLocaleString()} / ${length.toLocaleString()} ►  ·  arrow keys`
        : "1 / 1";
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
}

function clampIndex(index: number, length: number): number {
  if (length === 0) return 0;
  return Math.max(0, Math.min(length - 1, index));
}
