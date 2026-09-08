import { fetchThumbnailBlob } from "../streaming/ThumbnailSource.ts";

/** One bounded image request, stale work cancelled, no GPU texture or original download. */
export class TouchPreview {
  readonly root = document.createElement("div");
  private readonly img = document.createElement("img");
  private readonly label = document.createElement("p");
  private request: AbortController | null = null;
  private key: string | null = null;
  private shownKey: string | null = null;
  private url: string | null = null;
  constructor(container: HTMLElement) {
    this.root.className = "lc-mobile-preview"; this.root.hidden = true;
    this.img.alt = "Held block image"; this.img.decoding = "async";
    this.img.style.visibility = "hidden";
    this.img.addEventListener("error", () => { if (!this.root.hidden) this.label.textContent = "Preview unavailable"; });
    this.root.append(this.img, this.label); container.append(this.root);
  }
  show(key: string, count: number, resolve: () => Promise<string | null>): void {
    if (key === this.key) return;
    this.request?.abort(); this.key = key; this.root.hidden = false;
    this.label.textContent = `${count.toLocaleString()} images · loading preview…`;
    const request = new AbortController(); this.request = request;
    void resolve().then(async url => {
      request.signal.throwIfAborted(); if (!url) throw Error("No thumbnail");
      const blob = await fetchThumbnailBlob(url, request.signal); request.signal.throwIfAborted();
      const nextUrl = URL.createObjectURL(blob);
      let installed = false;
      try {
        const decoded = document.createElement("img"); decoded.src = nextUrl; await decoded.decode();
        request.signal.throwIfAborted();
        const previousUrl = this.url;
        this.url = nextUrl; this.img.src = nextUrl; this.img.style.visibility = "visible";
        this.shownKey = key; installed = true;
        if (previousUrl) URL.revokeObjectURL(previousUrl);
      } finally { if (!installed) URL.revokeObjectURL(nextUrl); }
      this.label.textContent = `${count.toLocaleString()} images · hold to collect`;
    }).catch(() => { if (!request.signal.aborted) this.label.textContent = "Preview unavailable"; });
  }
  get ready(): boolean { return this.key !== null && this.shownKey === this.key; }
  hide(): void {
    this.request?.abort(); this.request = null; this.key = null; this.shownKey = null;
    this.img.style.visibility = "hidden";
    this.img.removeAttribute("src"); if (this.url) URL.revokeObjectURL(this.url); this.url = null; this.root.hidden = true;
  }
  dispose(): void { this.hide(); this.root.remove(); }
}
