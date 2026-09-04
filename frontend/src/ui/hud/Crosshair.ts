/**
 * Cursor-anchored extraction progress ring.
 *
 * Phase 1-3 had a fixed center-screen crosshair, because the pointer was
 * locked/hidden and hover targeting always fired from the middle of the
 * viewport by construction — the crosshair WAS the reticle. Phase 3.5
 * dropped pointer lock (see `FlightControls.ts`), so the OS cursor is always
 * visible and IS the reticle now; a redundant fixed-center or
 * cursor-mirroring dot would just double up on what the browser already
 * draws. What the OS cursor can't show is hold-to-extract *progress*, so
 * this component is repurposed for exactly that: a small ring, positioned
 * at the live cursor location, hidden except while a hold is actually armed.
 * Idle hover feedback (is anything targetable here at all) is handled far
 * more cheaply via `main.ts` swapping the canvas's CSS `cursor` style —
 * no DOM/position updates needed for that case.
 *
 * There used to be a second, amber "restore" tint for holding on a drained
 * voxel to push its stack back; drained voxels are pass-through to the
 * cursor now and returns go through the inventory, so the ring has one job
 * and one colour.
 */
export interface HoldProgressRing {
  /** Shows the ring at zero progress. */
  show(): void;
  /** Hides the ring. Safe to call even if already hidden. */
  hide(): void;
  /** 0..1 fraction of the hold's duration elapsed so far. */
  setProgress(fraction: number): void;
  /** Cursor position in CSS pixels, viewport-relative. */
  setPosition(xPx: number, yPx: number): void;
  /** Removes the ring from the document. */
  dispose(): void;
}

const SIZE = 34;
const RADIUS = 12;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

// FUNCTIONAL colour, not chrome: the same hover-highlight teal the 3D
// wireframe uses. Phase 6's cyan skin deliberately does not touch it — the
// ring's job is to say "extraction is arming on the thing you're pointing at".
const RING_COLOR = "#7fffe0";

/** Chrome (static parts of the reticle) — dim cyan so the functional arc
 * above always wins the eye. Mirrors `--hud-accent` / `--hud-line` from
 * `ui/theme.css`; kept as literals here because these are SVG paint
 * attributes, not CSS properties on a themed element. */
const RETICLE_LINE = "rgba(70, 200, 224, 0.38)";
const RETICLE_BRACKET = "rgba(143, 233, 247, 0.72)";

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

  // Four L-shaped corner ticks: the same targeting-bracket motif the panels
  // use, at reticle scale. Static chrome — never recolored per action.
  const bracketArm = 5;
  const bracketInset = 1.5;
  for (const [sx, sy] of [
    [1, 1],
    [-1, 1],
    [1, -1],
    [-1, -1],
  ] as const) {
    const x = sx > 0 ? bracketInset : SIZE - bracketInset;
    const y = sy > 0 ? bracketInset : SIZE - bracketInset;
    const bracket = document.createElementNS(svgNs, "path");
    bracket.setAttribute(
      "d",
      `M ${x + sx * bracketArm} ${y} L ${x} ${y} L ${x} ${y + sy * bracketArm}`,
    );
    bracket.setAttribute("fill", "none");
    bracket.setAttribute("stroke", RETICLE_BRACKET);
    bracket.setAttribute("stroke-width", "1");
    svg.appendChild(bracket);
  }

  const track = document.createElementNS(svgNs, "circle");
  track.setAttribute("cx", String(center));
  track.setAttribute("cy", String(center));
  track.setAttribute("r", String(RADIUS));
  track.setAttribute("fill", "rgba(3, 11, 16, 0.35)");
  track.setAttribute("stroke", RETICLE_LINE);
  track.setAttribute("stroke-width", "2.5");
  svg.appendChild(track);

  // Four cardinal ticks around the track — a graduated dial, the cheapest way
  // to make a plain circle read as instrumentation rather than a spinner.
  for (const [dx, dy] of [
    [0, -1],
    [1, 0],
    [0, 1],
    [-1, 0],
  ] as const) {
    const tick = document.createElementNS(svgNs, "line");
    tick.setAttribute("x1", String(center + dx * (RADIUS + 2)));
    tick.setAttribute("y1", String(center + dy * (RADIUS + 2)));
    tick.setAttribute("x2", String(center + dx * (RADIUS + 4.5)));
    tick.setAttribute("y2", String(center + dy * (RADIUS + 4.5)));
    tick.setAttribute("stroke", RETICLE_LINE);
    tick.setAttribute("stroke-width", "1");
    svg.appendChild(tick);
  }

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
  dot.setAttribute("fill", "rgba(223, 251, 255, 0.92)");
  svg.appendChild(dot);

  container.appendChild(root);

  return {
    show() {
      progress.setAttribute("stroke", RING_COLOR);
      // Phosphor bloom in the arc's own colour, so it reads as lit
      // instrumentation against the dim chrome track underneath it.
      progress.style.filter = `drop-shadow(0 0 3px ${RING_COLOR})`;
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
    dispose() {
      root.remove();
    },
  };
}
