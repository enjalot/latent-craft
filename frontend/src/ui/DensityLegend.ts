import { DENSITY_STOPS } from "../voxels/DensityView.ts";
import { applyHudPanelChrome, applyHudTitle } from "./hudPanel.ts";

export function createDensityLegend(container: HTMLElement) {
  const root = document.createElement("aside");
  root.className = "ls-density-legend";
  Object.assign(root.style, { position: "absolute", top: "14px", left: "50%", transform: "translateX(-50%)",
    width: "250px", padding: "10px", pointerEvents: "none", fontSize: "10px", display: "none" });
  applyHudPanelChrome(root);
  const title = document.createElement("div"); title.textContent = "X-ray · images per voxel"; applyHudTitle(title);
  const ramp = document.createElement("div");
  Object.assign(ramp.style, { height: "7px", margin: "8px 0 4px", background: `linear-gradient(to right, ${DENSITY_STOPS.join(",")})` });
  const ticks = document.createElement("div"); Object.assign(ticks.style, { display: "flex", justifyContent: "space-between" });
  for (const text of ["1", "10", "100", "1k", "10k+"]) { const tick = document.createElement("span"); tick.textContent = text; ticks.append(tick); }
  const note = document.createElement("div"); note.textContent = "Log scale · hover to reveal image"; note.style.marginTop = "5px";
  root.append(title, ramp, ticks, note); container.append(root);
  return { setActive(active: boolean) { root.style.display = active ? "block" : "none"; } };
}
