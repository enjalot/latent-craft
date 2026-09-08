import type { FlightControls } from "../engine/FlightControls.ts";

/** Pointer-ID ownership allows D-pad flight and a separate look finger together. */
export class TouchControls {
  private readonly lifetime = new AbortController();
  private readonly held = new Map<number, { code: string; button: HTMLButtonElement }>();
  readonly root = document.createElement("div");
  private readonly hint = document.createElement("div");
  constructor(container: HTMLElement, private readonly flight: FlightControls, radius: (delta: number) => void) {
    this.root.className = "lc-touch-controls";
    const pad = document.createElement("div"); pad.className = "lc-dpad";
    const vertical = document.createElement("div"); vertical.className = "lc-vertical";
    const button = (parent: HTMLElement, text: string, label: string) => {
      const b = document.createElement("button"); b.type = "button"; b.textContent = text; b.setAttribute("aria-label", label); parent.append(b); return b;
    };
    for (const [code, text, label, position] of [["KeyW", "▲", "Fly forward", "1 / 2"], ["KeyA", "◀", "Fly left", "2 / 1"],
      ["KeyS", "▼", "Fly backward", "3 / 2"], ["KeyD", "▶", "Fly right", "2 / 3"],
      ["Space", "↑", "Fly up", ""], ["ShiftLeft", "↓", "Fly down", ""]]) {
      const b = button(position ? pad : vertical, text, label); if (position) b.style.gridArea = position;
      b.addEventListener("pointerdown", e => {
        e.preventDefault(); e.stopPropagation(); b.setPointerCapture(e.pointerId);
        this.held.set(e.pointerId, { code, button: b }); this.flight.setTouchKey(code, true); b.setAttribute("aria-pressed", "true");
      }, { signal: this.lifetime.signal });
      for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) b.addEventListener(type, e => this.release((e as PointerEvent).pointerId), { signal: this.lifetime.signal });
    }
    const shrink = button(pad, "−", "Shrink effector"); shrink.style.gridArea = "3 / 1"; shrink.addEventListener("click", () => radius(-1));
    const grow = button(pad, "+", "Grow effector"); grow.style.gridArea = "3 / 3"; grow.addEventListener("click", () => radius(1));
    this.root.append(pad, vertical); container.append(this.root);
    this.hint.className = "lc-touch-hint"; this.hint.textContent = "Drag to look · hold a block to preview & collect"; container.append(this.hint);
    window.addEventListener("blur", this.clear, { signal: this.lifetime.signal });
    document.addEventListener("visibilitychange", this.clear, { signal: this.lifetime.signal });
  }
  private release(id: number): void {
    const held = this.held.get(id); if (!held) return;
    this.held.delete(id);
    if (![...this.held.values()].some(v => v.code === held.code)) { this.flight.setTouchKey(held.code, false); held.button.setAttribute("aria-pressed", "false"); }
  }
  private clear = () => { for (const id of this.held.keys()) this.release(id); };
  dispose(): void { this.clear(); this.lifetime.abort(); this.root.remove(); this.hint.remove(); }
}
