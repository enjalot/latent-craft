import type { SearchResult } from "../search/CompareClient.ts";
import { applyHudPanelChrome, applyHudTitle } from "./hudPanel.ts";
import { setThumbnailSource } from "../streaming/ThumbnailSource.ts";

export const BL_MAP_RELEASE = "bl-20260907a";
export function parseBLResults(value: unknown): SearchResult[] {
  const body = value as { dataset?: string; release?: string; results?: SearchResult[] };
  if (body?.dataset !== "bl-160" || body.release !== BL_MAP_RELEASE || !Array.isArray(body.results) || body.results.length > 24) throw new Error("Search response belongs to a different map");
  const seen = new Set<number>();
  for (const r of body.results) {
    if (!r || ![r.row, r.chunk, r.local, r.thumb].every(Number.isSafeInteger) || r.row < 0 || r.row >= 1080814 ||
      r.chunk < 0 || r.chunk >= 1000 || r.local < 0 || r.local >= 4096 || r.thumb < 0 || !Number.isFinite(r.score) ||
      typeof r.thumbUrl !== "string" || !/^\/thumbs\/bl\/(covers|medium|embellishments|plates)\/\d{8}\.webp$/.test(r.thumbUrl) || seen.has(r.row)) throw new Error("Invalid BL search result");
    seen.add(r.row);
    const id = Number(r.thumbUrl!.slice(-13, -5));
    if (id !== r.thumb) throw new Error("Thumbnail identity mismatch");
  }
  return body.results;
}

export class BLSearch {
  private root = document.createElement("section");
  private controller: AbortController | null = null;
  private generation = 0;
  private statusController = new AbortController();
  private statusTimer: ReturnType<typeof setTimeout> | undefined;
  constructor(container: HTMLElement, actions: { hover: (r: SearchResult | null) => void; select: (r: SearchResult) => void; clear: () => void }) {
    this.root.className = "ls-bl-search";
    Object.assign(this.root.style, { padding: "10px", pointerEvents: "auto", fontSize: "11px", flexShrink: "1", minHeight: "42px", overflowY: "auto", boxSizing: "border-box", overscrollBehavior: "contain" });
    applyHudPanelChrome(this.root);
    this.root.addEventListener("keydown", event => event.stopPropagation());
    const details = document.createElement("details"); details.open = true;
    const heading = document.createElement("summary"); heading.textContent = "Search the collection · SigLIP 2"; applyHudTitle(heading);
    const form = document.createElement("form"), input = document.createElement("input"), button = document.createElement("button"), select = document.createElement("select");
    input.type = "search"; input.maxLength = 400; input.placeholder = "a sailing ship, a botanical illustration…";
    input.setAttribute("aria-label", "Search British Library images");
    Object.assign(input.style, { width: "100%", boxSizing: "border-box", margin: "10px 0 8px", padding: "8px", background: "var(--hud-ground-inset)", color: "var(--hud-text)", border: "1px solid var(--hud-line)" });
    button.type = "submit"; button.textContent = "Search"; button.className = "hud-button";
    select.className = "hud-select"; select.setAttribute("aria-label", "Search index experiment");
    for (const [value, label] of [["faiss", "FAISS · SQ8"], ["sq8", "LanceDB · SQ8 + refine"]]) {
      const option = document.createElement("option"); option.value = value; option.textContent = label; select.append(option);
    }
    const bar = document.createElement("div"); Object.assign(bar.style, { display: "flex", gap: "8px", flexWrap: "wrap" }); bar.append(button, select);
    const status = document.createElement("p"); status.setAttribute("role", "status"); status.textContent = "1,080,814 images. Hover to aim; click to fly to an image.";
    const checkStatus = async () => {
      try {
        const response = await fetch("/api/bl/status", { signal: this.statusController.signal, cache: "no-store" });
        if (!response.ok) return;
        const state = await response.json();
        if (this.statusController.signal.aborted) return;
        button.disabled = state.state !== "ready";
        if (state.state === "ready") {
          status.textContent = "1,080,814 images. Hover to aim; click to fly to an image.";
          return;
        }
        status.textContent = typeof state.detail === "string" ? state.detail : "Search is warming; explore the map meanwhile.";
        this.statusTimer = setTimeout(checkStatus, 10000);
      } catch { /* A local map may not have its optional search service running. */ }
    };
    void checkStatus();
    const results = document.createElement("div"); Object.assign(results.style, { display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: "5px" });
    const clear = () => { this.generation++; this.controller?.abort(); results.replaceChildren(); actions.clear(); };
    input.addEventListener("input", clear); select.addEventListener("change", clear);
    form.addEventListener("submit", async event => {
      event.preventDefault(); clear();
      const generation = this.generation, query = input.value.trim();
      if (!query) return;
      this.controller = new AbortController(); status.textContent = "Searching…";
      const started = performance.now();
      try {
        const response = await fetch("/api/bl/search", { method: "POST", signal: this.controller.signal,
          headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query, backend: select.value }) });
        const body = await response.json();
        if (generation !== this.generation) return;
        if (!response.ok) throw new Error(body.detail || body.error || `Search HTTP ${response.status}`);
        const hits = parseBLResults(body);
        if (body.query !== query || ![body.embed_ms, body.search_ms].every(v => Number.isFinite(v) && v >= 0)) throw new Error("Invalid search response");
        status.textContent = `${hits.length} matches · ${(performance.now()-started).toFixed(0)} ms · encode ${body.embed_ms.toFixed(0)} / search ${body.search_ms.toFixed(0)} ms`;
        for (const [i, hit] of hits.entries()) {
          const card = document.createElement("button"); card.type = "button"; card.className = "hud-button";
          Object.assign(card.style, { minWidth: "0", padding: "3px", display: "grid", gap: "3px" });
          card.setAttribute("aria-label", `Result ${i+1}: fly to image`);
          const image = document.createElement("img"); image.alt = `Result ${i+1}`; image.decoding = "async";
          Object.assign(image.style, { width: "100%", aspectRatio: "1", objectFit: "contain" });
          card.append(image, document.createTextNode(hit.score.toFixed(3))); results.append(card);
          setThumbnailSource(image, hit.thumbUrl!);
          card.addEventListener("pointerenter", () => actions.hover(hit)); card.addEventListener("pointerleave", () => actions.hover(null));
          card.addEventListener("focus", () => actions.hover(hit)); card.addEventListener("blur", () => actions.hover(null));
          card.addEventListener("click", () => actions.select(hit));
        }
      } catch (error) {
        if (generation === this.generation) status.textContent = error instanceof Error ? error.message : String(error);
      }
    });
    form.append(input, bar); details.append(heading, form, status, results); this.root.append(details); container.append(this.root);
  }
  dispose(): void {
    this.generation++; this.controller?.abort(); this.statusController.abort();
    clearTimeout(this.statusTimer); this.root.remove();
  }
}
