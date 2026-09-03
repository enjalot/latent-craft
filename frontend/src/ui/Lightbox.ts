import { applyHudPanelChrome, HUD_CLASS } from "./hudPanel.ts";

/**
 * Minimal "view bigger" modal for inventory thumbnails.
 *
 * Honesty note (per the project plan's own dataset-readiness research): the
 * British Library thumbnails served at `/thumbs/bl/<subset>/<idx>.webp` —
 * the same files the inventory grid already uses — are the ONLY image
 * resolution available on this machine (max-256px-longest-side WebP; no
 * separate full-resolution originals were downloaded). So "view bigger" here
 * means exactly that: rendering the SAME file at a larger on-screen size
 * (the browser upscales it), not fetching a higher-detail source. There is
 * no higher-detail source to fetch.
 */
export class Lightbox {
  private readonly root: HTMLElement;
  private readonly img: HTMLImageElement;
  private readonly caption: HTMLElement;

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

    this.root.appendChild(frame);
    container.appendChild(this.root);

    window.addEventListener("keydown", (event) => {
      if (event.key === "Escape") this.close();
    });
  }

  open(url: string, caption: string): void {
    this.img.src = url;
    this.img.alt = caption;
    this.caption.textContent = caption;
    this.root.style.display = "flex";
  }

  close(): void {
    this.root.style.display = "none";
  }
}
