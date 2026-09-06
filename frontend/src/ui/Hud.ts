import * as THREE from "three";
import { applyHudPanelChrome, applyHudTitle, HUD_CLASS } from "./hudPanel.ts";

export interface HudStreamingState {
  /** Dataset label from the config registry. */
  dataset: string;
  chunksResident: number;
  chunksLoading: number;
  chunksTotal: number;
  chunksFailed: number;
  /** Voxels currently drawn as flat proxies — every occupied voxel whose
   * chunk is not resident (see `voxels/VoxelProxyCloud.ts`). */
  proxyVoxelsShown: number;
  atlasBytes: number;
}

export interface HudState {
  fps: number;
  residentInstances: number;
  visibleInstances: number;
  cameraPosition: THREE.Vector3;
  hoverLabel: string;
  /** Whether a look-drag (click-and-drag rotate) is currently in progress —
   * shown for debugging only; nothing gates on it the way the old
   * `PointerLockControls`-driven `locked` flag used to. */
  dragging: boolean;
  /** Absent in the Phase 1 synthetic view, which streams nothing. */
  streaming?: HudStreamingState;
  /** Shown in place of everything else while the manifest/proxy load. */
  status?: string;
  sharpPreviews?: { visible: number; slots: number; pending: number; gpuBytes: number };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/**
 * Plain-DOM perf/telemetry HUD — no framework, no VDOM. Scope: FPS,
 * residency/streaming counters, camera position, and whatever the raycaster
 * currently has under the cursor.
 *
 * Collapsible (Phase 4): the whole panel is `pointer-events: none` so the
 * flight controls' drag-to-look still works when the cursor happens to be
 * over the top-left corner — only the small header strip opts back into
 * `pointer-events: auto` so it can be clicked to fold/unfold the body.
 *
 * Phase 6: frame/ground/CRT texture all come from `applyHudPanelChrome`; the
 * only styling left inline here is layout (position, padding, flex).
 */
const COLLAPSE_STORAGE_KEY = "lsv-hud-collapsed";

export class Hud {
  private readonly root: HTMLElement;
  private readonly header: HTMLElement;
  private readonly toggleGlyph: HTMLElement;
  private readonly body: HTMLElement;
  private readonly controls = document.createElement("div");
  private readonly readout = document.createElement("div");
  private radiusInput: HTMLInputElement | null = null;
  private radiusOutput: HTMLOutputElement | null = null;
  private lastText = "";
  private collapsed = false;

  constructor(container: HTMLElement, docked = false) {
    this.root = document.createElement("div");
    Object.assign(this.root.style, {
      position: docked ? "relative" : "fixed",
      // DatasetPicker occupies the first strip in this top-left dock.
      top: docked ? "auto" : "58px",
      left: docked ? "auto" : "14px",
      fontSize: "11px",
      lineHeight: "1.65",
      pointerEvents: "auto",
      width: docked ? "100%" : "min(420px, calc(100vw - 28px))",
      flexShrink: "0",
      boxSizing: "border-box",
      zIndex: "10",
    } satisfies Partial<CSSStyleDeclaration>);
    applyHudPanelChrome(this.root);

    this.header = document.createElement("div");
    Object.assign(this.header.style, {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: "20px",
      padding: "5px 10px",
      cursor: "pointer",
      pointerEvents: "auto",
      userSelect: "none",
    } satisfies Partial<CSSStyleDeclaration>);
    this.header.title = "Expand/collapse settings";
    this.header.tabIndex = 0;
    this.header.setAttribute("role", "button");

    const label = document.createElement("span");
    label.textContent = "Settings";
    applyHudTitle(label);

    this.toggleGlyph = document.createElement("span");
    this.toggleGlyph.classList.add(HUD_CLASS.title);
    this.toggleGlyph.style.letterSpacing = "0";

    const heading = document.createElement("div");
    const help = document.createElement("div");
    help.textContent = "Drag to look · WASD fly · Space / Shift up / down\nDouble-tap W to sprint · Scroll to resize field";
    Object.assign(help.style, { whiteSpace: "pre-line", fontSize: "10px", opacity: ".7", marginTop: "3px" });
    heading.append(label, help);
    this.header.appendChild(heading);
    this.header.appendChild(this.toggleGlyph);
    this.header.addEventListener("click", () => this.setCollapsed(!this.collapsed));
    this.header.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      this.setCollapsed(!this.collapsed);
    });

    this.body = document.createElement("div");
    this.body.classList.add(HUD_CLASS.readout);
    Object.assign(this.body.style, {
      padding: "7px 14px 11px",
      whiteSpace: "normal",
      letterSpacing: "0.02em",
    } satisfies Partial<CSSStyleDeclaration>);
    Object.assign(this.readout.style, { whiteSpace: "pre-wrap", overflowWrap: "anywhere", opacity: ".7" });
    this.body.append(this.controls, this.readout);

    this.root.appendChild(this.header);
    this.root.appendChild(this.body);
    container.appendChild(this.root);

    this.setCollapsed(this.readPersistedCollapsed());
  }

  configure(options: { speed: number; radius: number; maxRadius: number; onSpeed: (value: number) => void; onRadius: (value: number) => void }): void {
    this.controls.replaceChildren();
    const slider = (name: string, value: number, min: number, max: number, step: number, unit: string, change: (n: number) => void) => {
      const label = document.createElement("label");
      const output = document.createElement("output");
      const input = document.createElement("input");
      input.type = "range"; input.min = String(min); input.max = String(max); input.step = String(step); input.value = String(value);
      input.setAttribute("aria-label", name);
      Object.assign(label.style, { display: "grid", gridTemplateColumns: "1fr auto", gap: "3px", marginBottom: "10px" });
      Object.assign(input.style, { gridColumn: "1 / -1", width: "100%", accentColor: "#7fffe0", margin: "0" });
      const update = () => { output.value = `${Number(input.value)} ${unit}`; };
      update(); input.addEventListener("input", () => { update(); change(Number(input.value)); });
      label.append(document.createTextNode(name), output, input); this.controls.append(label);
      return { input, output };
    };
    slider("Flying speed", options.speed, 1, 64, 1, "voxels/s", options.onSpeed);
    const radius = slider("Effector radius", options.radius, 1, options.maxRadius, .25, "voxels", options.onRadius);
    this.radiusInput = radius.input; this.radiusOutput = radius.output;
  }

  updateRadius(radius: number): void {
    if (!this.radiusInput || !this.radiusOutput) return;
    const value = String(Math.round(radius * 100) / 100);
    if (this.radiusInput.value !== value) this.radiusInput.value = value;
    if (this.radiusOutput.value !== `${value} voxels`) this.radiusOutput.value = `${value} voxels`;
  }

  private readPersistedCollapsed(): boolean {
    try {
      return localStorage.getItem(COLLAPSE_STORAGE_KEY) === "1";
    } catch {
      // Storage can throw in private-browsing/locked-down contexts; just
      // fall back to the "start expanded" default in that case.
      return false;
    }
  }

  private setCollapsed(collapsed: boolean): void {
    this.collapsed = collapsed;
    this.body.style.display = collapsed ? "none" : "block";
    // The header rule is part of the skin, so it's a class toggle rather than
    // an inline border write (see theme.css `.hud-title-bar`).
    this.header.classList.toggle(HUD_CLASS.titleBar, !collapsed);
    this.header.style.padding = collapsed ? "5px 10px" : "5px 10px 4px";
    this.toggleGlyph.textContent = collapsed ? "[+]" : "[-]";
    this.header.setAttribute("aria-expanded", String(!collapsed));
    try {
      localStorage.setItem(COLLAPSE_STORAGE_KEY, collapsed ? "1" : "0");
    } catch {
      // Non-fatal — collapse state just won't survive a reload.
    }
  }

  update(state: HudState): void {
    const lines: string[] = [];
    if (state.streaming) {
      const s = state.streaming;
      lines.push(
        `chunks: ${s.chunksResident}/${s.chunksTotal} resident` +
          (s.chunksLoading > 0 ? `, ${s.chunksLoading} loading` : "") +
          (s.chunksFailed > 0 ? `, ${s.chunksFailed} failed` : "") +
          `\nproxies: ${s.proxyVoxelsShown.toLocaleString()} voxels`,
      );
      lines.push(`atlas + chunk data: ${formatBytes(s.atlasBytes)}`);
    }
    lines.push(`FPS: ${state.fps.toFixed(0)}`);
    lines.push(`voxels: ${state.residentInstances.toLocaleString()} resident`);
    lines.push(`visible (post-cull): ${state.visibleInstances.toLocaleString()}`);
    if (state.sharpPreviews) {
      const p = state.sharpPreviews;
      lines.push(`sharp 128px: ${p.visible} shown · ${p.slots}/128 cached · ${p.pending} loading · ${(p.gpuBytes / 1048576).toFixed(2)} MiB GPU`);
    }
    const p = state.cameraPosition;
    lines.push(`pos: ${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}`);
    if (state.status) lines.push(state.status);
    // Free-mouse scheme (Phase 3.5): always-on reference line, since there's
    // no more "click to engage" moment to hide it after.

    // The HUD text changes at most a few characters per frame; skipping the
    // DOM write when nothing changed keeps it off the layout path entirely.
    const text = lines.join("\n");
    if (text !== this.lastText) {
      this.readout.textContent = text;
      this.lastText = text;
    }
  }

  dispose(): void {
    this.root.remove();
  }
}
