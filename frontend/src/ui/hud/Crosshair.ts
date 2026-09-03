/**
 * Cursor-anchored mine/restore progress ring.
 *
 * Phase 1-3 had a fixed center-screen crosshair, because the pointer was
 * locked/hidden and hover targeting always fired from the middle of the
 * viewport by construction — the crosshair WAS the reticle. Phase 3.5
 * dropped pointer lock (see `FlightControls.ts`), so the OS cursor is always
 * visible and IS the reticle now; a redundant fixed-center or
 * cursor-mirroring dot would just double up on what the browser already
 * draws. What the OS cursor can't show is hold-to-mine/restore *progress*,
 * so this component is repurposed for exactly that: a small ring, positioned
 * at the live cursor location, hidden except while a hold is actually armed.
 * Idle hover feedback (is anything targetable here at all) is handled far
 * more cheaply via `main.ts` swapping the canvas's CSS `cursor` style —
 * no DOM/position updates needed for that case.
 */
export interface HoldProgressRing {
  /** Shows the ring at zero progress, tinted for the given action. */
  show(kind: "mine" | "restore"): void;
  /** Hides the ring. Safe to call even if already hidden. */
  hide(): void;
  /** 0..1 fraction of the hold's duration elapsed so far. */
  setProgress(fraction: number): void;
  /** Cursor position in CSS pixels, viewport-relative. */
  setPosition(xPx: number, yPx: number): void;
}

const SIZE = 30;
const RADIUS = 11;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

const RING_COLORS: Record<"mine" | "restore", string> = {
  // Matches the existing hover-highlight teal used elsewhere in the HUD.
  mine: "#7fffe0",
  restore: "#ffb15c",
};

export function createHoldProgressRing(container: HTMLElement): HoldProgressRing {
  const root = document.createElement("div");
  root.id = "hold-progress-ring";
  Object.assign(root.style, {
    position: "fixed",
    top: "0",
    left: "0",
    width: `${SIZE}px`,
    height: `${SIZE}px`,
    marginTop: `${-SIZE / 2}px`,
    marginLeft: `${-SIZE / 2}px`,
    pointerEvents: "none",
    zIndex: "15",
    display: "none",
  } satisfies Partial<CSSStyleDeclaration>);

  const svgNs = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNs, "svg");
  svg.setAttribute("width", String(SIZE));
  svg.setAttribute("height", String(SIZE));
  svg.setAttribute("viewBox", `0 0 ${SIZE} ${SIZE}`);
  root.appendChild(svg);

  const center = SIZE / 2;

  const track = document.createElementNS(svgNs, "circle");
  track.setAttribute("cx", String(center));
  track.setAttribute("cy", String(center));
  track.setAttribute("r", String(RADIUS));
  track.setAttribute("fill", "none");
  track.setAttribute("stroke", "rgba(255,255,255,0.28)");
  track.setAttribute("stroke-width", "2.5");
  svg.appendChild(track);

  const progress = document.createElementNS(svgNs, "circle");
  progress.setAttribute("cx", String(center));
  progress.setAttribute("cy", String(center));
  progress.setAttribute("r", String(RADIUS));
  progress.setAttribute("fill", "none");
  progress.setAttribute("stroke-width", "2.5");
  progress.setAttribute("stroke-linecap", "round");
  progress.setAttribute("stroke-dasharray", String(CIRCUMFERENCE));
  progress.setAttribute("stroke-dashoffset", String(CIRCUMFERENCE));
  // Start the fill at 12 o'clock and grow clockwise, matching how most
  // "hold to confirm" UIs read.
  progress.setAttribute("transform", `rotate(-90 ${center} ${center})`);
  svg.appendChild(progress);

  const dot = document.createElementNS(svgNs, "circle");
  dot.setAttribute("cx", String(center));
  dot.setAttribute("cy", String(center));
  dot.setAttribute("r", "1.6");
  dot.setAttribute("fill", "rgba(255,255,255,0.9)");
  svg.appendChild(dot);

  container.appendChild(root);

  return {
    show(kind) {
      progress.setAttribute("stroke", RING_COLORS[kind]);
      progress.setAttribute("stroke-dashoffset", String(CIRCUMFERENCE));
      root.style.display = "block";
    },
    hide() {
      root.style.display = "none";
    },
    setProgress(fraction) {
      const clamped = Math.max(0, Math.min(1, fraction));
      progress.setAttribute("stroke-dashoffset", String(CIRCUMFERENCE * (1 - clamped)));
    },
    setPosition(xPx, yPx) {
      root.style.transform = `translate(${xPx}px, ${yPx}px)`;
    },
  };
}
