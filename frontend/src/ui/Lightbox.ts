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
      background: "rgba(2, 3, 6, 0.82)",
      zIndex: "50",
      cursor: "zoom-out",
      pointerEvents: "auto",
    } satisfies Partial<CSSStyleDeclaration>);
    // Click anywhere in the overlay (backdrop or image) to close — the
    // simplest, most discoverable dismissal for an unskinned Phase 3.5 modal.
    this.root.addEventListener("click", () => this.close());

    this.img = document.createElement("img");
    Object.assign(this.img.style, {
      // Deliberately allowed to exceed the source's native ~256px — that IS
      // "bigger," honestly achieved by upscaled display, not a claim of more
      // detail (see class doc).
      maxWidth: "min(90vw, 640px)",
      maxHeight: "75vh",
      objectFit: "contain",
      background: "#1b1e28",
      borderRadius: "4px",
      boxShadow: "0 12px 40px rgba(0,0,0,0.5)",
    } satisfies Partial<CSSStyleDeclaration>);
    this.root.appendChild(this.img);

    this.caption = document.createElement("div");
    Object.assign(this.caption.style, {
      color: "#9fb0d8",
      fontSize: "12px",
      fontFamily: "system-ui, sans-serif",
    } satisfies Partial<CSSStyleDeclaration>);
    this.root.appendChild(this.caption);

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
