/**
 * Small centered crosshair overlay. Exists because the pointer is hidden
 * while pointer-locked, so hover/raycast targeting needs a fixed on-screen
 * reference point to aim with instead of a cursor.
 */
export function createCrosshair(container: HTMLElement): HTMLElement {
  const el = document.createElement("div");
  el.id = "crosshair";
  Object.assign(el.style, {
    position: "fixed",
    top: "50%",
    left: "50%",
    width: "10px",
    height: "10px",
    marginTop: "-5px",
    marginLeft: "-5px",
    pointerEvents: "none",
    zIndex: "10",
  } satisfies Partial<CSSStyleDeclaration>);

  // Simple plus-shaped crosshair built from two bars, cheaper than SVG and
  // trivial to re-skin later (Phase 6 HUD retrofit).
  const barStyle: Partial<CSSStyleDeclaration> = {
    position: "absolute",
    background: "rgba(255, 255, 255, 0.85)",
    boxShadow: "0 0 2px rgba(0, 0, 0, 0.8)",
  };
  const hBar = document.createElement("div");
  Object.assign(hBar.style, barStyle, {
    top: "4px",
    left: "0",
    width: "10px",
    height: "2px",
  } satisfies Partial<CSSStyleDeclaration>);
  const vBar = document.createElement("div");
  Object.assign(vBar.style, barStyle, {
    top: "0",
    left: "4px",
    width: "2px",
    height: "10px",
  } satisfies Partial<CSSStyleDeclaration>);

  el.appendChild(hBar);
  el.appendChild(vBar);
  container.appendChild(el);
  return el;
}
