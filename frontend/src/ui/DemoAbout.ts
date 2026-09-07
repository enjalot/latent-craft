import { applyHudPanelChrome, applyHudTitle } from "./hudPanel.ts";

/** Release-specific attribution, separate from the explorer and its future skin. */
export function addBLDemoAbout(container: HTMLElement): void {
  const root = document.createElement("details");
  Object.assign(root.style, { position: "fixed", bottom: "14px", left: "14px", width: "min(420px, calc(100vw - 28px))",
    boxSizing: "border-box", padding: "9px", zIndex: "12", pointerEvents: "auto", fontSize: "11px", maxHeight: "45vh", overflowY: "auto" });
  applyHudPanelChrome(root);
  const summary = document.createElement("summary"); summary.textContent = "latent-craft · British Library · about"; applyHudTitle(summary);
  const body = document.createElement("div");
  body.innerHTML = `<p>An independent explorer—not an official British Library product.</p>
    <p>1,080,814 images from British Library Labs’ digitised books, via
    <a href="https://huggingface.co/datasets/biglam/british-library-book-images" target="_blank" rel="noopener noreferrer">Daniel van Strien’s dataset mirror</a>.
    Original release: Public Domain Mark / no known copyright restrictions.</p>
    <p>Historical material may contain offensive depictions. The collection reflects institutional and digitisation choices, not a representative sample of history.</p>
    <p>Progress stays in your browser; export CSV for backup. Search phrases go to this Space. Image requests go to Google Cloud Storage and, when opened, Flickr originals. No query history is intentionally saved.</p>
    <p>Experimental CPU demo: search may need to warm after sleep. Library-specific artwork is planned separately.</p>`;
  root.append(summary, body); container.append(root);
}
