/** Copy works on the plain-HTTP LAN preview as well as HTTPS publication. */
export async function copyMapUrl(value: string, field: HTMLInputElement): Promise<boolean> {
  try { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(value); return true; } } catch { /* HTTP/permission fallback */ }
  field.value = value; field.focus(); field.select(); field.setSelectionRange(0, value.length);
  try { return document.execCommand("copy"); } catch { return false; }
}
export function requestDataConsent(container: HTMLElement): Promise<void> {
  return new Promise(resolve => {
    const dialog = document.createElement("dialog"); dialog.className = "lc-data-consent";
    const heading = document.createElement("h1"); heading.id = "data-title"; heading.textContent = "Explore a world of images";
    const message = document.createElement("p");
    message.textContent = "This is a streaming 3D map. Budget roughly 5–15 MB to get started. Exploring many new areas can use 100 MB or more as images stream in. Usage depends on your route and device; there is no total download limit. Wi-Fi is recommended.";
    const help = document.createElement("p"); help.textContent = "On touch screens: use the direction pad to fly, drag the scene to look, and hold a block to see its image. The mobile view skips the 2D map and uses smaller caches.";
    const buttons = document.createElement("div"); buttons.className = "lc-consent-actions";
    const proceed = document.createElement("button"); proceed.type = "button"; proceed.textContent = "OK, explore";
    const copy = document.createElement("button"); copy.type = "button"; copy.textContent = "Copy URL for computer";
    const url = new URL(location.href); url.searchParams.delete("mobile");
    const field = document.createElement("input"); field.type = "text"; field.readOnly = true; field.value = url.href;
    field.setAttribute("aria-label", "Map URL");
    const status = document.createElement("p"); status.setAttribute("role", "status");
    status.textContent = "Map data will not load until you continue.";
    copy.addEventListener("click", async () => { status.textContent = await copyMapUrl(url.href, field) ? "URL copied. Send it to your computer; no map data has loaded." : "Select and copy the URL below to send it to your computer."; });
    proceed.addEventListener("click", () => { dialog.close(); dialog.remove(); resolve(); }, { once: true });
    dialog.addEventListener("cancel", e => e.preventDefault());
    dialog.setAttribute("aria-labelledby", heading.id);
    buttons.append(proceed, copy); dialog.append(heading, message, help, buttons, field, status); container.append(dialog);
    dialog.showModal();
  });
}
