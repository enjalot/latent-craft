import { MetadataClient, MetadataUnavailable, type FilterQuery, type MatchSnapshot } from "../metadata/MetadataClient.ts";

export class MetadataFilters {
  readonly element = document.createElement("section");
  private lifetime = new AbortController();
  private request: AbortController | null = null;
  private lookup: AbortController | null = null;
  private form = document.createElement("form");
  private status = document.createElement("p");
  private controls = new Map<string, HTMLInputElement | HTMLSelectElement>();
  private ready = false;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private bookLabel = document.createElement("div");
  private bookMatches = document.createElement("div");
  constructor(private readonly client: MetadataClient, private readonly apply: (snapshot: MatchSnapshot | null) => void) {
    this.element.className = "ls-metadata-filters";
    this.element.setAttribute("aria-label", "Image filters");
    this.status.setAttribute("role", "status"); this.status.textContent = "Loading filter fields…";
    this.element.append(this.status, this.form);
    this.element.addEventListener("keydown", event => event.stopPropagation());
    this.form.addEventListener("submit", event => { event.preventDefault(); void this.submit(); });
    void this.init();
  }
  private async init(): Promise<void> {
    try {
      const schema = await this.client.schema(this.lifetime.signal);
      if (this.lifetime.signal.aborted) return;
      for (const field of schema.fields) {
        const label = document.createElement("label"); label.textContent = field.label;
        Object.assign(label.style, { display: "grid", gap: "4px", marginBottom: "8px" });
        const input = document.createElement(field.kind === "category" ? "select" : "input");
        input.setAttribute("aria-label", field.label); this.controls.set(field.key, input);
        if (input instanceof HTMLSelectElement && field.kind === "category") {
          input.add(new Option("All image types", "")); for (const type of field.options) input.add(new Option(type, type));
        } else if (input instanceof HTMLInputElement && field.kind === "range") {
          input.type = "number"; input.min = String(field.min); input.max = String(field.max); input.placeholder = `${field.min} (any)`;
          this.controls.delete(field.key); this.controls.set("minYear", input);
          const max = input.cloneNode() as HTMLInputElement; max.placeholder = `${field.max} (any)`; max.setAttribute("aria-label", "Latest publication year");
          input.setAttribute("aria-label", "Earliest publication year"); this.controls.set("maxYear", max); label.append(input, max);
          const unknown = document.createElement("input"); unknown.type = "checkbox"; this.controls.set("includeUnknown", unknown);
          const choice = document.createElement("label"); choice.append(unknown, " Include unknown years in date range"); label.append(choice);
        } else if (input instanceof HTMLInputElement && field.kind === "lookup") {
          input.type = "search"; input.maxLength = 120; input.placeholder = "Find a book…";
          const matches = this.bookMatches; Object.assign(matches.style, { maxHeight: "150px", overflow: "auto" });
          let timer: ReturnType<typeof setTimeout>;
          input.addEventListener("input", () => {
            delete input.dataset.book; this.bookLabel.textContent = ""; this.lookup?.abort(); clearTimeout(timer); matches.replaceChildren();
            const text = input.value.trim(); if (text.length < 2) return;
            const request = this.lookup = new AbortController();
            timer = setTimeout(() => { if (request.signal.aborted || this.lifetime.signal.aborted) return;
              void this.client.books(text, request.signal).then(books => {
                if (request.signal.aborted) return;
                matches.replaceChildren();
                if (!books.length) matches.textContent = "No books found. Try a shorter title or a nine-digit ID.";
                for (const book of books) {
                  const button = document.createElement("button"); button.type = "button"; button.textContent = `${book.id} · ${book.title}`;
                  Object.assign(button.style, { width: "100%", textAlign: "left", whiteSpace: "normal" }); button.className = "hud-button";
                  button.addEventListener("click", () => { input.value = book.id; input.dataset.book = book.id; this.bookLabel.textContent = book.title; matches.replaceChildren(); });
                  matches.append(button);
                }
              }).catch(error => { if (!request.signal.aborted) matches.textContent = String(error); });
            }, 250);
          });
          label.append(input, this.bookLabel, matches);
        }
        if (!label.contains(input)) label.append(input);
        this.form.append(label);
      }
      for (const input of this.controls.values()) if (!(input instanceof HTMLInputElement && input.type === "checkbox"))
        Object.assign(input.style, { minWidth: "0", maxWidth: "100%", boxSizing: "border-box", background: "var(--hud-ground-inset)", color: "var(--hud-text)", border: "1px solid var(--hud-line)", padding: "5px" });
      const apply = document.createElement("button"); apply.type = "submit"; apply.className = "hud-button"; apply.textContent = "Apply image filters";
      const clear = document.createElement("button"); clear.type = "button"; clear.className = "hud-button"; clear.textContent = "Clear image filters";
      clear.addEventListener("click", () => {
        this.request?.abort(); this.lookup?.abort(); this.form.reset(); this.bookLabel.textContent = ""; this.bookMatches.replaceChildren();
        const book = this.controls.get("book"); if (book) delete book.dataset.book;
        this.apply(null); this.status.textContent = "All images · inventory unchanged.";
      });
      const note = document.createElement("p"); note.textContent = `${schema.note} “Hide voxels” also applies to matching counts; lower that threshold if a small book selection looks empty. Gray faces have no matching atlas representative; hover to load a matching image.`;
      note.style.opacity = ".7"; this.form.append(apply, clear, note); this.ready = true;
      this.status.textContent = "All images. Filters apply to counts, X-ray and mining; saved inventory is unchanged.";
    } catch (error) {
      if (this.lifetime.signal.aborted) return;
      this.status.textContent = String(error);
      if (error instanceof MetadataUnavailable && [429, 503].includes(error.status)) {
        this.status.textContent = error.status === 503 ? "Book metadata is warming; filters will become available automatically." : "Book metadata is busy; retrying shortly.";
        this.retryTimer = setTimeout(() => { if (!this.lifetime.signal.aborted) void this.init(); }, 5000);
      }
    }
  }
  async setQuery(query: FilterQuery): Promise<void> {
    if (!this.ready) return;
    this.lookup?.abort(); this.form.reset(); this.bookLabel.textContent = ""; this.bookMatches.replaceChildren();
    const book = this.controls.get("book"); if (book) delete book.dataset.book;
    for (const [key, value] of Object.entries(query)) { const input = this.controls.get(key); if (input) input.value = String(value); }
    await this.submit();
  }
  private async submit(): Promise<void> {
    const query: FilterQuery = {};
    for (const key of ["minYear", "maxYear"] as const) { const input = this.controls.get(key) as HTMLInputElement; if (input?.value) query[key] = input.valueAsNumber; }
    const type = this.controls.get("type")?.value; if (type) query.type = type;
    const book = this.controls.get("book") as HTMLInputElement;
    if (book?.value.trim()) {
      if (!/^\d{9}$/.test(book.value.trim())) { this.status.textContent = "Choose a book from the title results or enter its nine-digit ID."; return; }
      query.book = book.value.trim();
    }
    if (query.minYear !== undefined || query.maxYear !== undefined) query.includeUnknown = (this.controls.get("includeUnknown") as HTMLInputElement).checked;
    this.request?.abort(); const request = this.request = new AbortController();
    if (!Object.keys(query).length) { this.apply(null); this.status.textContent = "All images · inventory unchanged."; return; }
    this.status.textContent = "Computing matches… previous filter remains active.";
    const start = performance.now();
    try {
      const result = await this.client.filter(query, request.signal);
      if (request.signal.aborted) return;
      this.apply(result);
      this.status.textContent = `${result.total.toLocaleString()} matching images · ${(performance.now() - start).toFixed(0)} ms · ${(result.bits.buffer.byteLength / 1024).toFixed(0)} KiB decoded filter data. Inventory unchanged.`;
    } catch (error) { if (!request.signal.aborted) this.status.textContent = `${String(error)} Previous filter remains active.`; }
  }
  dispose(): void { clearTimeout(this.retryTimer); this.lifetime.abort(); this.request?.abort(); this.lookup?.abort(); this.element.remove(); }
}
