import { applyHudPanelChrome, applyHudTitle, HUD_CLASS } from "../ui/hudPanel.ts";
import { composeDensityBase, type DensityBase } from "./DensityBase.ts";
import type { MinimapPack } from "./Manifest.ts";
import {
  MINIMAP_AVATAR_COLOR,
  MINIMAP_BASE_ZOOM,
  MINIMAP_CROSSHAIR_COLOR,
  MINIMAP_FLASHLIGHT_COLOR,
  MINIMAP_SIZE_PX,
} from "../config.ts";

/** A marker position, in the pack's quantized u16 coordinate space. */
export interface MinimapMarker {
  qx: number;
  qy: number;
}

export interface MinimapFlashlight extends MinimapMarker {
  /** Query radius, q units — drawn as a circle so the hit area is honest. */
  radiusQ: number;
}

export interface MinimapCallbacks {
  /** Cursor moved over the map area, at this quantized position. */
  onHover(qx: number, qy: number): void;
  /** Cursor left the map area. */
  onLeave(): void;
  /** Map area clicked at this quantized position. */
  onSelect(qx: number, qy: number): void;
}

/** Two lines because that's the caption box's fixed height (see below) —
 * every readout written into it is also two lines, so nothing ever reflows. */
const HINT = "hover = flashlight\nclick = teleport";

/**
 * The minimap panel: a static density base canvas with a cheap marker overlay
 * canvas on top, plus the pointer plumbing that turns panel pixels back into
 * the pack's quantized coordinate space.
 *
 * Two canvases rather than one because they change at wildly different rates:
 * the base is composited once at load and never redrawn (nothing pans or
 * zooms — see `DensityBase.ts`), while the overlay redraws on pointer move /
 * hover change. Splitting them means the per-interaction cost is one clear +
 * three small vector markers over a 220px square, with no image work at all.
 *
 * Marker roles, all three of which cross the 2D↔3D divide through `row_id`
 * (never through a coordinate transform — see `minimap/Manifest.ts`):
 *
 * - **flashlight** (amber circle): where the cursor is on the map; the 3D
 *   voxels holding those points are simultaneously lit up in the world.
 * - **crosshair** (teal, matching the 3D hover box): the 2D position of the
 *   voxel currently hovered in the 3D view.
 * - **avatar** (white dot): approximately where the camera is — see
 *   `MinimapBridge.updateAvatar` for why "approximately" is the best that
 *   exists here.
 *
 * Deliberately NOT drawn: a facing wedge for the avatar. The plan sketched one,
 * but a heading is meaningless across independent fits — the 3D camera's yaw
 * has no image in 2D minimap space, so any wedge would be decoration that
 * looks like information.
 */
export class MinimapRenderer {
  readonly root: HTMLElement;

  private readonly mapWrap: HTMLElement;
  private readonly baseCanvas: HTMLCanvasElement;
  private readonly overlayCanvas: HTMLCanvasElement;
  private readonly overlayCtx: CanvasRenderingContext2D;
  private readonly captionEl: HTMLElement;

  private readonly dpr: number;
  private readonly sizePx = MINIMAP_SIZE_PX;

  private flashlight: MinimapFlashlight | null = null;
  private crosshair: MinimapMarker | null = null;
  private avatar: MinimapMarker | null = null;

  private overlayScheduled = false;
  private captionText = HINT;
  private base: DensityBase | null = null;

  constructor(
    container: HTMLElement,
    readonly pack: MinimapPack,
    private readonly callbacks: MinimapCallbacks,
  ) {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);

    this.root = document.createElement("div");
    Object.assign(this.root.style, {
      position: "fixed",
      right: "14px",
      bottom: "14px",
      fontSize: "11px",
      lineHeight: "1.4",
      padding: "5px 7px 6px",
      zIndex: "10",
      userSelect: "none",
      // The map area opts back into pointer events below; the chrome around it
      // stays inert so it can't swallow a look-drag that starts near the edge.
      pointerEvents: "none",
    } satisfies Partial<CSSStyleDeclaration>);
    // Frame only. The scanline layer sits at z-index:-1 (see hudPanel.ts), so
    // it textures the panel gutter WITHOUT overlaying the density image — the
    // map has to render exactly as the pipeline drew it.
    applyHudPanelChrome(this.root);

    const header = document.createElement("div");
    applyHudTitle(header, { bar: true });
    Object.assign(header.style, {
      display: "flex",
      justifyContent: "space-between",
      alignItems: "baseline",
      gap: "10px",
      padding: "1px 2px 4px",
    } satisfies Partial<CSSStyleDeclaration>);
    const title = document.createElement("span");
    title.textContent = "Map · 2D UMAP";
    const count = document.createElement("span");
    count.textContent = `${pack.nPoints.toLocaleString()} pts`;
    count.classList.add(HUD_CLASS.dim);
    count.style.letterSpacing = "0.04em";
    header.append(title, count);

    this.mapWrap = document.createElement("div");
    Object.assign(this.mapWrap.style, {
      position: "relative",
      width: `${this.sizePx}px`,
      height: `${this.sizePx}px`,
      // Slightly lighter than the panel so the extent of the 2D frame is
      // legible even where the embedding has no points. Opaque on purpose —
      // it's what keeps the panel's CRT scanline layer off the density image.
      background: "#04141b",
      border: "1px solid var(--hud-line)",
      cursor: "crosshair",
      pointerEvents: "auto",
      overflow: "hidden",
    } satisfies Partial<CSSStyleDeclaration>);

    this.baseCanvas = this.createLayer();
    this.overlayCanvas = this.createLayer();
    const overlayCtx = this.overlayCanvas.getContext("2d");
    if (!overlayCtx) throw new Error("minimap: could not get a 2D context for the overlay");
    this.overlayCtx = overlayCtx;
    this.mapWrap.append(this.baseCanvas, this.overlayCanvas);

    this.captionEl = document.createElement("div");
    this.captionEl.classList.add(HUD_CLASS.dim);
    Object.assign(this.captionEl.style, {
      width: `${this.sizePx}px`,
      // Fixed two-line box: the readouts here change on every pointer move,
      // and a caption that grows/shrinks would jitter the whole panel (which
      // is anchored bottom-right, so it would move the MAP, not just the text).
      // The 26px/13px geometry is load-bearing — the Phase 6 skin only changes
      // color and tracking here, never the box.
      height: "26px",
      padding: "4px 1px 0",
      fontSize: "10px",
      lineHeight: "13px",
      // No extra tracking here, unlike the rest of the skin: the readout lines
      // are already sized to fill this fixed 220px box, and letter-spacing
      // pushed the longest one ("… in loaded chunks") past the clip edge.
      letterSpacing: "0",
      whiteSpace: "pre",
      overflow: "hidden",
    } satisfies Partial<CSSStyleDeclaration>);
    this.captionEl.textContent = HINT;

    this.root.append(header, this.mapWrap, this.captionEl);
    container.appendChild(this.root);

    this.mapWrap.addEventListener("pointermove", this.handlePointerMove);
    this.mapWrap.addEventListener("pointerleave", this.handlePointerLeave);
    this.mapWrap.addEventListener("pointerdown", this.handlePointerDown);
    this.mapWrap.addEventListener("click", this.handleClick);
  }

  private createLayer(): HTMLCanvasElement {
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(this.sizePx * this.dpr);
    canvas.height = Math.round(this.sizePx * this.dpr);
    Object.assign(canvas.style, {
      position: "absolute",
      inset: "0",
      width: `${this.sizePx}px`,
      height: `${this.sizePx}px`,
    } satisfies Partial<CSSStyleDeclaration>);
    return canvas;
  }

  /** Fetches + composites the density base. Safe to call once; the panel is
   * already interactive (and already shows its markers) before it resolves. */
  async loadBase(signal?: AbortSignal): Promise<DensityBase> {
    const base = await composeDensityBase(this.pack, MINIMAP_BASE_ZOOM, signal);
    this.base = base;
    const ctx = this.baseCanvas.getContext("2d");
    if (!ctx) throw new Error("minimap: could not get a 2D context for the base layer");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.clearRect(0, 0, this.baseCanvas.width, this.baseCanvas.height);
    // The composited base spans the FULL quantized range at its zoom level, so
    // the whole image maps onto the whole panel with a plain uniform scale —
    // the pack's frame is square (`frame.squared`), and so is the panel.
    ctx.drawImage(base.canvas, 0, 0, this.baseCanvas.width, this.baseCanvas.height);
    return base;
  }

  get densityBase(): DensityBase | null {
    return this.base;
  }

  // --- markers ---------------------------------------------------------------

  setFlashlight(flashlight: MinimapFlashlight | null): void {
    if (sameMarker(this.flashlight, flashlight)) return;
    this.flashlight = flashlight;
    this.scheduleOverlay();
  }

  setCrosshair(marker: MinimapMarker | null): void {
    if (sameMarker(this.crosshair, marker)) return;
    this.crosshair = marker;
    this.scheduleOverlay();
  }

  setAvatar(marker: MinimapMarker | null): void {
    if (sameMarker(this.avatar, marker)) return;
    this.avatar = marker;
    this.scheduleOverlay();
  }

  /** One-line readout under the map; `null` restores the static hint. */
  setCaption(text: string | null): void {
    const next = text ?? HINT;
    if (next === this.captionText) return;
    this.captionText = next;
    this.captionEl.textContent = next;
  }

  // --- panel px ↔ q ---------------------------------------------------------

  /** Panel-local CSS pixel for a quantized coordinate, on either axis. */
  pxFromQ(q: number): number {
    return this.pack.unitFromQ(q) * this.sizePx;
  }

  /** Quantized coordinate for a panel-local CSS pixel, on either axis. */
  qFromPx(px: number): number {
    return this.pack.qFromUnit(px / this.sizePx);
  }

  /** Radius in q units for a radius in panel pixels (used to size queries so
   * the lit region matches what the user sees under the cursor). */
  radiusQFromPx(radiusPx: number): number {
    return (radiusPx / this.sizePx) * 65536;
  }

  // --- overlay drawing -----------------------------------------------------

  private scheduleOverlay(): void {
    if (this.overlayScheduled) return;
    this.overlayScheduled = true;
    requestAnimationFrame(() => {
      this.overlayScheduled = false;
      this.drawOverlay();
    });
  }

  private drawOverlay(): void {
    const ctx = this.overlayCtx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
    // Draw in CSS pixels; the transform handles device-pixel scaling.
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    if (this.flashlight) {
      const x = this.pxFromQ(this.flashlight.qx);
      const y = this.pxFromQ(this.flashlight.qy);
      // `pxFromQ` is a pure scale with no offset, so it converts a q *radius*
      // as correctly as it converts a q *position*.
      const r = Math.max(3, this.pxFromQ(this.flashlight.radiusQ));
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = `${MINIMAP_FLASHLIGHT_COLOR}33`;
      ctx.fill();
      ctx.strokeStyle = MINIMAP_FLASHLIGHT_COLOR;
      ctx.lineWidth = 1.25;
      ctx.stroke();
    }

    if (this.crosshair) {
      const x = this.pxFromQ(this.crosshair.qx);
      const y = this.pxFromQ(this.crosshair.qy);
      ctx.strokeStyle = MINIMAP_CROSSHAIR_COLOR;
      ctx.lineWidth = 1.25;
      const gap = 3;
      const arm = 8;
      ctx.beginPath();
      ctx.moveTo(x - arm, y);
      ctx.lineTo(x - gap, y);
      ctx.moveTo(x + gap, y);
      ctx.lineTo(x + arm, y);
      ctx.moveTo(x, y - arm);
      ctx.lineTo(x, y - gap);
      ctx.moveTo(x, y + gap);
      ctx.lineTo(x, y + arm);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x, y, 3.5, 0, Math.PI * 2);
      ctx.stroke();
    }

    if (this.avatar) {
      const x = this.pxFromQ(this.avatar.qx);
      const y = this.pxFromQ(this.avatar.qy);
      // Dark halo first so the marker survives being drawn over a bright
      // (dense) part of the map.
      ctx.beginPath();
      ctx.arc(x, y, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(5,6,10,0.85)";
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x, y, 2.6, 0, Math.PI * 2);
      ctx.fillStyle = MINIMAP_AVATAR_COLOR;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x, y, 6.5, 0, Math.PI * 2);
      ctx.strokeStyle = MINIMAP_AVATAR_COLOR;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  // --- pointer -------------------------------------------------------------

  private localPx(event: PointerEvent | MouseEvent): { x: number; y: number } {
    const rect = this.mapWrap.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  private handlePointerMove = (event: PointerEvent): void => {
    const { x, y } = this.localPx(event);
    this.callbacks.onHover(this.qFromPx(x), this.qFromPx(y));
  };

  private handlePointerLeave = (): void => {
    this.callbacks.onLeave();
  };

  /** Swallow the press so it can't turn into a text selection / drag ghost.
   * The 3D look-drag never sees it either way: `PointerController` listens on
   * the renderer canvas, which is a sibling of this panel, not an ancestor. */
  private handlePointerDown = (event: PointerEvent): void => {
    event.preventDefault();
  };

  private handleClick = (event: MouseEvent): void => {
    const { x, y } = this.localPx(event);
    this.callbacks.onSelect(this.qFromPx(x), this.qFromPx(y));
  };

  dispose(): void {
    this.mapWrap.removeEventListener("pointermove", this.handlePointerMove);
    this.mapWrap.removeEventListener("pointerleave", this.handlePointerLeave);
    this.mapWrap.removeEventListener("pointerdown", this.handlePointerDown);
    this.mapWrap.removeEventListener("click", this.handleClick);
    this.root.remove();
  }
}

function sameMarker(a: MinimapMarker | null, b: MinimapMarker | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const aRadius = (a as MinimapFlashlight).radiusQ;
  const bRadius = (b as MinimapFlashlight).radiusQ;
  return a.qx === b.qx && a.qy === b.qy && aRadius === bRadius;
}
