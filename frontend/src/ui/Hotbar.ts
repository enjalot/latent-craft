/**
 * Minecraft-style equippable hotbar (Phase 4). Bottom-of-screen bar with
 * numbered slots — plain/unskinned, matching `Hud.ts`'s deliberately
 * throwaway-simple styling for now (the late-90s cockpit skin is Phase 6).
 *
 * Slot "0" is the implicit empty hand, rendered explicitly rather than left
 * as "nothing selected" so it reads as a real, always-present choice the
 * same way Minecraft's own hotbar always shows every slot including empty
 * ones. Equipping empty-hand (slot 0, or Escape) turns off every tool's
 * effect — normal Phase 3.5 mining/restoring keeps working exactly as
 * before, with no tool effect layered on top.
 *
 * This file deliberately owns ALL hotbar/tool-status UI on screen — per the
 * task brief, `ui/Hud.ts` (the collapsible stats panel from the prior
 * agent's pass) is off-limits, so anything about equip state or the
 * Effector Field's live radius/distance gets its own status line here
 * instead of being bolted onto that panel.
 */
export type ToolId = "xray" | "effector";

interface HotbarItemDef {
  id: ToolId;
  keyLabel: string;
  keyCode: string;
  label: string;
}

const ITEMS: HotbarItemDef[] = [
  { id: "xray", keyLabel: "1", keyCode: "Digit1", label: "X-Ray" },
  { id: "effector", keyLabel: "2", keyCode: "Digit2", label: "Effector Field" },
];

const SLOT_BASE_STYLE: Partial<CSSStyleDeclaration> = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: "2px",
  width: "88px",
  padding: "6px 4px",
  borderRadius: "4px",
  border: "1px solid rgba(255,255,255,0.18)",
  background: "rgba(5, 6, 10, 0.65)",
  color: "#d7e2ff",
  cursor: "pointer",
  userSelect: "none",
  textAlign: "center",
};

export class Hotbar {
  private equipped: ToolId | null = null;
  private readonly slotEls = new Map<ToolId | "hand", HTMLElement>();
  private readonly statusEl: HTMLElement;
  private lastStatusText = "";

  constructor(
    container: HTMLElement,
    private readonly onChange: (tool: ToolId | null) => void,
  ) {
    const root = document.createElement("div");
    Object.assign(root.style, {
      position: "fixed",
      bottom: "16px",
      left: "50%",
      transform: "translateX(-50%)",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      gap: "6px",
      zIndex: "10",
      fontSize: "11px",
      lineHeight: "1.4",
      fontFamily: "inherit",
    } satisfies Partial<CSSStyleDeclaration>);

    const bar = document.createElement("div");
    Object.assign(bar.style, {
      display: "flex",
      gap: "6px",
    } satisfies Partial<CSSStyleDeclaration>);

    const handSlot = this.buildSlot("0", "Empty Hand", () => this.equip(null));
    this.slotEls.set("hand", handSlot);
    bar.appendChild(handSlot);

    for (const item of ITEMS) {
      const slot = this.buildSlot(item.keyLabel, item.label, () => this.toggleEquip(item.id));
      this.slotEls.set(item.id, slot);
      bar.appendChild(slot);
    }

    this.statusEl = document.createElement("div");
    Object.assign(this.statusEl.style, {
      background: "rgba(5, 6, 10, 0.65)",
      border: "1px solid rgba(255,255,255,0.12)",
      borderRadius: "4px",
      padding: "3px 10px",
      color: "#9fb3e0",
      whiteSpace: "pre",
      display: "none",
    } satisfies Partial<CSSStyleDeclaration>);

    root.appendChild(bar);
    root.appendChild(this.statusEl);
    container.appendChild(root);

    window.addEventListener("keydown", this.handleKeydown);
    this.renderActiveState();
  }

  get equippedTool(): ToolId | null {
    return this.equipped;
  }

  /** Explicit equip — used by empty-hand (always sets, never toggles off
   * "nothing" since there's nothing lower to toggle to). */
  equip(tool: ToolId | null): void {
    if (tool === this.equipped) return;
    this.equipped = tool;
    this.renderActiveState();
    this.onChange(tool);
  }

  /** Clicking (or pressing the key for) an already-equipped tool slot
   * un-equips it back to empty hand — standard toggle-button feel, and the
   * only way to get back to empty-hand besides slot 0 / Escape. */
  private toggleEquip(tool: ToolId): void {
    this.equip(this.equipped === tool ? null : tool);
  }

  /** Status line under the bar — main.ts's per-frame loop calls this with
   * live tool state (e.g. Effector Field's current radius/distance) so the
   * player has some readout without touching `Hud.ts`. Skips the DOM write
   * when unchanged, same discipline `Hud.ts` uses for its own text. */
  setStatusLine(text: string): void {
    if (text === this.lastStatusText) return;
    this.lastStatusText = text;
    if (text) {
      this.statusEl.textContent = text;
      this.statusEl.style.display = "block";
    } else {
      this.statusEl.style.display = "none";
    }
  }

  private buildSlot(keyLabel: string, name: string, onClick: () => void): HTMLElement {
    const slot = document.createElement("div");
    Object.assign(slot.style, SLOT_BASE_STYLE);

    const key = document.createElement("div");
    key.textContent = keyLabel;
    Object.assign(key.style, { opacity: "0.6", fontSize: "10px" } satisfies Partial<CSSStyleDeclaration>);

    const label = document.createElement("div");
    label.textContent = name;

    slot.appendChild(key);
    slot.appendChild(label);
    slot.addEventListener("click", onClick);
    return slot;
  }

  private renderActiveState(): void {
    for (const [id, el] of this.slotEls) {
      const isActive = (id === "hand" && this.equipped === null) || id === this.equipped;
      el.style.borderColor = isActive ? "#7fffe0" : "rgba(255,255,255,0.18)";
      el.style.background = isActive ? "rgba(127,255,224,0.16)" : "rgba(5, 6, 10, 0.65)";
      el.style.boxShadow = isActive ? "0 0 6px rgba(127,255,224,0.5)" : "none";
    }
  }

  private handleKeydown = (event: KeyboardEvent): void => {
    if (event.code === "Escape" || event.code === "Digit0") {
      this.equip(null);
      return;
    }
    const item = ITEMS.find((i) => i.keyCode === event.code);
    if (item) this.toggleEquip(item.id);
  };

  dispose(): void {
    window.removeEventListener("keydown", this.handleKeydown);
  }
}
