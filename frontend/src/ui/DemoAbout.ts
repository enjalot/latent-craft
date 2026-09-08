import { applyHudPanelChrome, applyHudTitle } from "./hudPanel.ts";
import type { DatasetAttribution } from "../datasets/registry.ts";

/** Collection credits come from data; generated artwork credits from the skin. */
export function addDatasetAbout(container: HTMLElement, attribution: DatasetAttribution, artworkNotice?: string): void {
  const root = document.createElement("details");
  root.className = "lc-about";
  Object.assign(root.style, { position: "relative", width: "100%", flexShrink: "0",
    boxSizing: "border-box", padding: "9px", pointerEvents: "auto", fontSize: "11px" });
  applyHudPanelChrome(root);
  const summary = document.createElement("summary"); summary.textContent = `latent-craft · ${attribution.title}`;
  summary.title = "About latent-craft and this collection"; summary.setAttribute("aria-label", summary.title); applyHudTitle(summary);
  const body = document.createElement("div");
  Object.assign(body.style, { maxHeight: "25dvh", overflowY: "auto", overscrollBehavior: "contain" });
  const paragraph = (text: string) => {
    const p = document.createElement("p"); p.textContent = text; body.append(p);
  };
  paragraph(attribution.description);
  const links = document.createElement("p");
  for (const credit of attribution.links) {
    if (!/^https?:\/\//.test(credit.url)) continue;
    if (links.childNodes.length) links.append(" · ");
    const a = document.createElement("a");
    a.textContent = credit.label; a.href = credit.url; a.target = "_blank"; a.rel = "noopener noreferrer";
    links.append(a);
  }
  body.append(links);
  paragraph(attribution.rights);
  if (attribution.warning) paragraph(attribution.warning);
  paragraph("Progress stays in your browser; export CSV for backup. Search phrases go to the configured search service. Image requests go to the asset host and, when opened, the original provider. No query history is intentionally saved.");
  if (artworkNotice) paragraph(artworkNotice);
  root.append(summary, body); container.append(root);
}
