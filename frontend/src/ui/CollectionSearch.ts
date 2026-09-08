import type { SearchResult } from "../search/CompareClient.ts";
import { applyHudPanelChrome, applyHudTitle } from "./hudPanel.ts";
import { setThumbnailSource } from "../streaming/ThumbnailSource.ts";
import { BL_COLLECTION, MONET_CLIP_COLLECTION, parseCollectionResults } from "../search/CollectionProfile.ts";

export class CollectionSearch {
  private root = document.createElement("section");
  private controller: AbortController | null = null;
  private generation = 0;
  private statusController = new AbortController();
  private statusTimer: ReturnType<typeof setTimeout> | undefined;
  private matches: ((row: number) => boolean) | null = null;
  private clearResults = () => {};
  setMetadataFilter(matches: ((row: number) => boolean) | null): void { this.matches = matches; this.clearResults(); }
  constructor(container: HTMLElement, actions: { hover: (r: SearchResult | null) => void; select: (r: SearchResult) => void | Promise<void>; clear: () => void }, profileKey: "bl" | "monet" = "bl") {
    const profile = profileKey === "monet" ? MONET_CLIP_COLLECTION : BL_COLLECTION;
    this.root.className = "ls-bl-search";
    Object.assign(this.root.style, { padding: "10px", pointerEvents: "auto", fontSize: "11px", flexShrink: "1", minHeight: "42px", minWidth: "0", overflow: "clip", boxSizing: "border-box", display: "flex", flexDirection: "column" });
    applyHudPanelChrome(this.root);
    this.root.addEventListener("keydown", event => event.stopPropagation());
    const bodyPanel = document.createElement("div");
    Object.assign(bodyPanel.style, { display: "flex", flexDirection: "column", minHeight: "0", overflow: "clip" });
    const heading = document.createElement("button"); heading.type = "button";
    heading.textContent = `▾ Search the collection · ${profile.model}`; applyHudTitle(heading);
    Object.assign(heading.style, { background: "none", border: "0", padding: "0", textAlign: "left", cursor: "pointer", flexShrink: "0" });
    heading.setAttribute("aria-expanded", "true");
    heading.addEventListener("click", () => {
      const open = heading.getAttribute("aria-expanded") !== "true";
      heading.setAttribute("aria-expanded", String(open)); bodyPanel.style.display = open ? "flex" : "none";
      heading.textContent = `${open ? "▾" : "▸"} Search the collection · ${profile.model}`;
    });
    const form = document.createElement("form"), input = document.createElement("input"), button = document.createElement("button");
    Object.assign(form.style, { flexShrink: "0", display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: "6px", margin: "8px 0 0" });
    input.type = "search"; input.maxLength = 400; input.placeholder = profile.placeholder;
    input.setAttribute("aria-label", `Search images with ${profile.model}`);
    Object.assign(input.style, { minWidth: "0", width: "100%", boxSizing: "border-box", padding: "7px", background: "var(--hud-ground-inset)", color: "var(--hud-text)", border: "1px solid var(--hud-line)" });
    button.type = "submit"; button.textContent = "Search"; button.className = "hud-button";
    heading.title = profile.backendLabel;
    const help = "Hover to aim; click to collect the image and fly to its block.";
    const status = document.createElement("p"); status.setAttribute("role", "status"); status.textContent = help;
    status.style.overflowWrap = "anywhere";
    status.style.flexShrink = "0";
    const checkStatus = async () => {
      try {
        const response = await fetch(`${profile.endpoint}/status`, { signal: this.statusController.signal, cache: "no-store" });
        if (!response.ok) return;
        const state = await response.json();
        if (this.statusController.signal.aborted) return;
        button.disabled = state.state !== "ready";
        if (state.state === "ready") {
          if (this.generation === 0) status.textContent = help;
          return;
        }
        status.textContent = typeof state.detail === "string" ? state.detail : "Search is warming; explore the map meanwhile.";
        this.statusTimer = setTimeout(checkStatus, 10000);
      } catch { /* A local map may not have its optional search service running. */ }
    };
    void checkStatus();
    const results = document.createElement("div"); Object.assign(results.style, { display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gridTemplateRows: "repeat(2, minmax(0, 1fr))", gap: "5px", flex: "0 1 0px", minHeight: "0" });
    const pager = document.createElement("div");
    Object.assign(pager.style, { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px", marginTop: "8px", flexShrink: "0" });
    const clear = () => { this.generation++; this.controller?.abort(); results.replaceChildren(); results.style.flexBasis = "0px"; pager.replaceChildren(); actions.clear(); };
    this.clearResults = () => { clear(); status.textContent = this.matches ? "Image filters changed. Search again; matches are drawn from the 24 retrieved candidates." : help; };
    input.addEventListener("input", clear);
    form.addEventListener("submit", async event => {
      event.preventDefault(); clear();
      const generation = this.generation, query = input.value.trim();
      if (!query) return;
      this.controller = new AbortController(); status.textContent = "Searching…";
      const started = performance.now();
      try {
        const response = await fetch(`${profile.endpoint}/search`, { method: "POST", signal: this.controller.signal,
          headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query, backend: "faiss" }) });
        const body = await response.json();
        if (generation !== this.generation) return;
        if (!response.ok) throw new Error(body.detail || body.error || `Search HTTP ${response.status}`);
        const candidates = parseCollectionResults(body, profile);
        const hits = this.matches ? candidates.filter(hit => this.matches!(hit.row)) : candidates;
        results.style.flexBasis = hits.length ? "230px" : "0px";
        if (body.query !== query || ![body.embed_ms, body.search_ms].every(v => Number.isFinite(v) && v >= 0)) throw new Error("Invalid search response");
        status.textContent = `${hits.length} matches · ${(performance.now()-started).toFixed(0)} ms · encode ${body.embed_ms.toFixed(0)} / search ${body.search_ms.toFixed(0)} ms`;
        if (this.matches) status.textContent += ` · filtered from ${candidates.length} candidates (not a full filtered-index search)`;
        let page = 0, pageSize = window.innerHeight < 850 ? 4 : 8;
        const renderPage = () => {
          results.style.gridTemplateRows = `repeat(${pageSize / 4}, minmax(0, 1fr))`;
          results.style.flexBasis = hits.length ? `${pageSize === 4 ? 100 : 200}px` : "0px";
          results.replaceChildren(); pager.replaceChildren(); actions.hover(null);
          for (const [offset, hit] of hits.slice(page * pageSize, (page + 1) * pageSize).entries()) {
            const i = page * pageSize + offset;
            const card = document.createElement("button"); card.type = "button"; card.className = "hud-button";
            Object.assign(card.style, { minWidth: "0", minHeight: "0", padding: "3px", display: "grid", gridTemplateRows: "minmax(0, 1fr) auto", gap: "3px", overflow: "clip" });
            card.setAttribute("aria-label", `Result ${i+1}: collect image and fly to block`);
            const image = document.createElement("img"); image.alt = `Result ${i+1}`; image.decoding = "async";
            Object.assign(image.style, { width: "100%", height: "100%", minHeight: "0", objectFit: "contain" });
            card.append(image, document.createTextNode(hit.score.toFixed(3))); results.append(card);
            setThumbnailSource(image, hit.thumbUrl!);
            card.addEventListener("pointerenter", () => actions.hover(hit)); card.addEventListener("pointerleave", () => actions.hover(null));
            card.addEventListener("focus", () => actions.hover(hit)); card.addEventListener("blur", () => actions.hover(null));
            card.addEventListener("click", async () => {
              card.disabled = true;
              try {
                await actions.select(hit);
                if (generation === this.generation) status.textContent = `Image ${hit.row.toLocaleString()} collected · ${help}`;
              } catch (error) {
                if (generation === this.generation) status.textContent = `Could not collect image: ${error instanceof Error ? error.message : String(error)}`;
              } finally { card.disabled = false; }
            });
          }
          if (hits.length > pageSize) {
            const previous = document.createElement("button"), next = document.createElement("button"), label = document.createElement("span");
            previous.type = next.type = "button"; previous.className = next.className = "hud-button";
            previous.textContent = "← Previous"; next.textContent = "Next →";
            previous.disabled = page === 0; next.disabled = (page + 1) * pageSize >= hits.length;
            label.textContent = `${page * pageSize + 1}–${Math.min((page + 1) * pageSize, hits.length)} of ${hits.length}`;
            previous.addEventListener("click", () => { page--; renderPage(); });
            next.addEventListener("click", () => { page++; renderPage(); });
            pager.append(previous, label, next);
          }
        };
        window.addEventListener("resize", () => {
          const nextSize = window.innerHeight < 850 ? 4 : 8;
          if (nextSize !== pageSize) { pageSize = nextSize; page = 0; renderPage(); }
        }, { signal: this.controller.signal });
        renderPage();
      } catch (error) {
        if (generation === this.generation) status.textContent = error instanceof Error ? error.message : String(error);
      }
    });
    form.append(input, button); bodyPanel.append(form, status, results, pager); this.root.append(heading, bodyPanel); container.append(this.root);
  }
  dispose(): void {
    this.generation++; this.controller?.abort(); this.statusController.abort();
    clearTimeout(this.statusTimer); this.root.remove();
  }
}
