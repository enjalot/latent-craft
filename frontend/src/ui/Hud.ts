import * as THREE from "three";

export interface HudStreamingState {
  /** Dataset label from the config registry. */
  dataset: string;
  chunksResident: number;
  chunksLoading: number;
  chunksTotal: number;
  chunksFailed: number;
  proxyInstances: number;
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
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/**
 * Minimal plain-DOM perf/debug HUD — no framework, no VDOM. Phase 2 scope:
 * FPS, residency/streaming counters, camera position, and whatever the
 * raycaster currently has under the crosshair. The skinned late-90s cockpit
 * HUD (theme.css, hudPanel() wrapper, lit-html panels) is Phase 6; this is
 * deliberately throwaway-simple until then.
 */
export class Hud {
  private readonly root: HTMLElement;
  private lastText = "";

  constructor(container: HTMLElement) {
    this.root = document.createElement("div");
    Object.assign(this.root.style, {
      position: "fixed",
      top: "12px",
      left: "12px",
      padding: "10px 14px",
      background: "rgba(5, 6, 10, 0.65)",
      color: "#d7e2ff",
      fontSize: "12px",
      lineHeight: "1.6",
      borderRadius: "6px",
      border: "1px solid rgba(255,255,255,0.12)",
      pointerEvents: "none",
      zIndex: "10",
      whiteSpace: "pre",
    } satisfies Partial<CSSStyleDeclaration>);
    container.appendChild(this.root);
  }

  update(state: HudState): void {
    const lines: string[] = [];
    if (state.streaming) {
      const s = state.streaming;
      lines.push(`dataset: ${s.dataset}`);
      lines.push(
        `chunks: ${s.chunksResident}/${s.chunksTotal} resident` +
          (s.chunksLoading > 0 ? `, ${s.chunksLoading} loading` : "") +
          (s.chunksFailed > 0 ? `, ${s.chunksFailed} failed` : ""),
      );
      lines.push(`atlases: ${formatBytes(s.atlasBytes)}   proxy: ${s.proxyInstances} cubes`);
    }
    lines.push(`FPS: ${state.fps.toFixed(0)}`);
    lines.push(`voxels: ${state.residentInstances.toLocaleString()} resident`);
    lines.push(`visible (post-cull): ${state.visibleInstances.toLocaleString()}`);
    const p = state.cameraPosition;
    lines.push(`pos: ${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}`);
    lines.push(`hover: ${state.hoverLabel}`);
    if (state.status) lines.push(state.status);
    // Free-mouse scheme (Phase 3.5): always-on reference line, since there's
    // no more "click to engage" moment to hide it after.
    lines.push(
      state.dragging
        ? "dragging to look…"
        : "drag to look · WASD/QE fly, Shift = boost · hold a voxel to mine/restore",
    );

    // The HUD text changes at most a few characters per frame; skipping the
    // DOM write when nothing changed keeps it off the layout path entirely.
    const text = lines.join("\n");
    if (text !== this.lastText) {
      this.root.textContent = text;
      this.lastText = text;
    }
  }
}
