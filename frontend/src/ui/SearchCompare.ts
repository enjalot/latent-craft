import { CHUNK_SERVER_ORIGIN } from "../config.ts";
import { COMPARE_DATASET, CompareClient, type CompareMode, type CompareResponse, type SearchResult } from "../search/CompareClient.ts";
import { applyHudPanelChrome, applyHudTitle } from "./hudPanel.ts";

export class SearchCompare {
  private readonly root = document.createElement("section");
  private readonly client = new CompareClient();
  private readonly input = document.createElement("input");
  private readonly status = document.createElement("div");
  private readonly results = document.createElement("div");
  private generation = 0;
  private dead = false;
  private mode: CompareMode = "project";

  constructor(container: HTMLElement, dataset: string, private readonly actions: {
    project: (response: CompareResponse) => void;
    hover: (result: SearchResult | null) => void;
    select: (result: SearchResult) => void;
    clear: () => void;
  }) {
    this.root.className = "ls-search-compare";
    // Keep Space/number shortcuts on focused controls out of flight/hotbar.
    this.root.addEventListener("keydown", event => event.stopPropagation());
    Object.assign(this.root.style, { padding: "10px", pointerEvents: "auto", fontSize: "11px", flexShrink: "0" });
    applyHudPanelChrome(this.root);
    const details = document.createElement("details"); details.open = true;
    const title = document.createElement("summary"); title.textContent = "Text navigation · local comparison";
    applyHudTitle(title); title.style.cursor = "pointer";
    details.append(title); this.root.append(details); container.append(this.root);
    if (dataset !== COMPARE_DATASET) {
      const note = document.createElement("p");
      note.textContent = "Compare text projection and exact CLIP search on the same 2.01M basemap. This map has no compatible prototype endpoint.";
      const link = document.createElement("a");
      const url = new URL(window.location.href); url.searchParams.set("dataset", COMPARE_DATASET); url.searchParams.delete("synthetic");
      link.href = url.toString(); link.textContent = "Open comparison dataset →";
      details.append(note, link); return;
    }
    const form = document.createElement("form");
    this.input.type = "search"; this.input.maxLength = 400; this.input.placeholder = "a red sports car…";
    this.input.setAttribute("aria-label", "CLIP text query");
    this.input.value = new URLSearchParams(location.search).get("query")?.slice(0, 400) ?? "";
    Object.assign(this.input.style, { width: "100%", boxSizing: "border-box", padding: "8px", margin: "10px 0 8px",
      background: "var(--hud-ground-inset)", color: "var(--hud-text)", border: "1px solid var(--hud-line)", font: "inherit", fontSize: "13px" });
    const buttons = document.createElement("div");
    Object.assign(buttons.style, { display: "flex", gap: "6px", flexWrap: "wrap" });
    const project = document.createElement("button"); project.type = "button"; project.textContent = "Project & fly";
    const search = document.createElement("button"); search.type = "button"; search.textContent = "Search images";
    const clear = document.createElement("button"); clear.type = "button"; clear.textContent = "Clear";
    for (const b of [project, search, clear]) b.className = "hud-button";
    project.addEventListener("click", () => { this.mode = "project"; void this.submit(); });
    search.addEventListener("click", () => { this.mode = "search"; void this.submit(); });
    clear.addEventListener("click", () => { this.input.value = ""; this.clear(); });
    form.addEventListener("submit", e => { e.preventDefault(); void this.submit(); });
    this.input.addEventListener("input", () => this.clear());
    buttons.append(project, search, clear); form.append(this.input, buttons);
    const help = document.createElement("p");
    help.textContent = "Projection flies directly to the predicted 3D location—no image search or snapping. Search ranks these 2.01M images by CLIP similarity. Hover to aim; click to fly close.";
    Object.assign(help.style, { opacity: ".72", lineHeight: "1.5" });
    this.status.setAttribute("role", "status"); this.status.setAttribute("aria-live", "polite");
    Object.assign(this.status.style, { whiteSpace: "pre-line", lineHeight: "1.5", margin: "8px 0" });
    Object.assign(this.results.style, { display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: "5px" });
    details.append(form, help, this.status, this.results);
  }

  private clear(): void {
    this.generation++; this.client.cancel(); this.results.replaceChildren(); this.status.textContent = "";
    this.actions.clear();
  }

  private async submit(): Promise<void> {
    this.clear();
    const generation = this.generation;
    this.status.textContent = this.mode === "project" ? "Embedding & projecting…" : "Searching images…";
    const start = performance.now();
    try {
      const response = await this.client.query(this.input.value, this.mode, text => {
        if (!this.dead && generation === this.generation) this.status.textContent = text;
      });
      if (!response || this.dead || generation !== this.generation) return;
      const t = response.timings, r = response.resources;
      const size = (n: number) => n >= 1024**3 ? `${(n/1024**3).toFixed(2)} GiB` : `${(n/1024**2).toFixed(0)} MiB`;
      this.status.textContent = `${response.mode === "project" ? "Projected destination" : "Exact CLIP cosine · 24 results"} · ${(performance.now()-start).toFixed(0)} ms round trip\n` +
        `Encode ${t.embed_ms.toFixed(1)} ms${response.embedding_cached ? " (cached)" : ""} · project ${t.project_ms.toFixed(1)} ms` +
        (response.mode === "search" ? ` · search ${t.search_ms.toFixed(1)} ms` : " · no index query") +
        `\nModel weights: text ${size(r.encoder_weight_bytes)} + heads ${size(r.projection_weight_bytes)}. Optional index: ${r.index_bytes ? size(r.index_bytes) + " resident" : "not loaded"}.` +
        (response.mode === "project" ? "\nImage-trained head: text may land in sparse/empty space." : "") +
        (response.projection.outside_frame && response.mode === "project" ? "\nOutside the displayed frame; showing the true prediction, not clamping." : "") +
        (response.truncated ? "\nQuery truncated to CLIP’s 77-token limit." : "");
      if (response.mode === "project") this.actions.project(response);
      else this.showResults(response.results);
    } catch (error) {
      if (!this.dead && generation === this.generation && !(error instanceof DOMException && error.name === "AbortError"))
        this.status.textContent = error instanceof Error ? error.message : String(error);
    }
  }

  private showResults(results: SearchResult[]): void {
    results.forEach((result, i) => {
      const button = document.createElement("button"); button.type = "button"; button.className = "hud-button";
      button.setAttribute("aria-label", `Result ${i+1}, row ${result.row}, similarity ${result.score.toFixed(3)}. Fly to image.`);
      Object.assign(button.style, { minWidth: "0", padding: "3px", display: "grid", gap: "3px", cursor: "pointer" });
      const img = document.createElement("img"); img.alt = `Result ${i+1}`; img.loading = "lazy"; img.decoding = "async";
      img.src = `${CHUNK_SERVER_ORIGIN ?? ""}/thumbs/monet/${result.thumb}.webp`;
      Object.assign(img.style, { width: "100%", aspectRatio: "1", objectFit: "contain", background: "#070c17" });
      img.addEventListener("error", () => { img.alt = "Preview unavailable"; }, { once: true });
      const label = document.createElement("span"); label.textContent = `${i+1} · ${result.score.toFixed(3)}`;
      button.append(img, label);
      button.addEventListener("pointerenter", () => this.actions.hover(result));
      button.addEventListener("pointerleave", () => this.actions.hover(null));
      button.addEventListener("focus", () => this.actions.hover(result));
      button.addEventListener("blur", () => this.actions.hover(null));
      button.addEventListener("click", () => this.actions.select(result));
      this.results.append(button);
    });
  }

  dispose(): void { this.dead = true; this.clear(); this.root.remove(); }
}
