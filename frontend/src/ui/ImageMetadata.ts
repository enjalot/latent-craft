import type { FilterQuery, MetadataClient } from "../metadata/MetadataClient.ts";

/** One focused row, cancelable. DOM text (never catalog HTML), safe source links. */
export class ImageMetadata {
  readonly element = document.createElement("section");
  private controller: AbortController | null = null;
  constructor(private readonly client: MetadataClient, private readonly onFilter?: (query: FilterQuery) => void) {
    this.element.className = "ls-image-metadata";
    Object.assign(this.element.style, { fontSize: "11px", lineHeight: "1.5", overflowWrap: "anywhere", gridColumn: "1 / -1", padding: "8px 0" });
    this.element.addEventListener("click", event => event.stopPropagation());
    this.element.addEventListener("keydown", event => event.stopPropagation());
  }
  show(row: number): void {
    this.clear();
    const controller = this.controller = new AbortController();
    this.element.textContent = "Loading image metadata…";
    void this.client.detail(row, controller.signal).then(detail => {
      if (controller.signal.aborted) return;
      const title = document.createElement("div"); title.textContent = detail.title; title.style.fontWeight = "600";
      const source = document.createElement("div"); source.textContent = detail.provenance; source.style.opacity = ".65";
      const fields = document.createElement("dl"); Object.assign(fields.style, { display: "grid", gridTemplateColumns: "auto 1fr", gap: "2px 8px", margin: "8px 0" });
      for (const field of detail.fields) {
        const label = document.createElement("dt"), value = document.createElement("dd");
        label.textContent = field.label; value.textContent = field.value; value.style.margin = "0"; fields.append(label, value);
      }
      this.element.replaceChildren(title, source, fields);
      for (const link of detail.links) {
        try { if (!["https:", "http:"].includes(new URL(link.url).protocol)) continue; } catch { continue; }
        const a = document.createElement("a"); a.textContent = link.label; a.href = link.url; a.target = "_blank"; a.rel = "noopener noreferrer";
        Object.assign(a.style, { display: "block", color: "var(--hud-text)" }); this.element.append(a);
      }
      if (detail.filter && this.onFilter) {
        const button = document.createElement("button"); button.className = "hud-button"; button.textContent = "Explore images from this book";
        button.addEventListener("click", () => this.onFilter!(detail.filter!)); this.element.append(button);
      }
    }).catch(error => { if (!controller.signal.aborted) this.element.textContent = String(error); });
  }
  clear(): void { this.controller?.abort(); this.controller = null; this.element.replaceChildren(); }
}
