/** Local-only source-quality experiment; permanent inventory URLs stay intact. */
export const thumbnailPreviewSize = import.meta.env.DEV &&
  new URLSearchParams(globalThis.location?.search ?? "").get("thumbSize") === "128" ? 128 : 256;

export function localThumbnailPreview(url: string): string | null {
  if (thumbnailPreviewSize !== 128) return null;
  const path = new URL(url, location.href).pathname;
  if (!/^\/thumbs\/(monet\/\d{1,10}|bl\/(covers|medium|embellishments|plates)\/\d{8})\.webp$/.test(path)) return null;
  return `/api/thumb-preview${path.slice("/thumbs".length)}?size=128`;
}

export function addThumbnailQualityControl(container: HTMLElement): void {
  if (!import.meta.env.DEV) return;
  const label = document.createElement("label"), select = document.createElement("select");
  label.textContent = "Thumbnail source · local test";
  Object.assign(label.style, { display: "grid", gap: "4px", margin: "10px 0" });
  select.setAttribute("aria-label", "Thumbnail source resolution");
  select.className = "hud-select";
  select.add(new Option("256px · current source", "256"));
  select.add(new Option("128px · smaller WebP source", "128"));
  select.value = String(thumbnailPreviewSize);
  select.addEventListener("change", () => {
    const url = new URL(location.href); url.searchParams.set("thumbSize", select.value);
    location.href = url.href; // Pagehide saves camera/inventory for the A/B reload.
  });
  label.append(select); container.append(label);
}
