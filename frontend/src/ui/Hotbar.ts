/**
 * Minecraft-style equippable hotbar (Phase 4). Bottom-of-screen bar with
 * numbered slots.
 *
 * Slot 1 is the explicit empty hand; slot 2 is the Pickaxe; slot 3 is X-ray.
 * Empty hand and X-ray mine one image per cycle. Pickaxe mines a bulk
 * batch; only X-ray enables the glass view. The always-on Effector Field is no longer
 * equipment and therefore deliberately does not appear here.
 *
 * This file deliberately owns ALL hotbar/tool-status UI on screen — per the
 * task brief, `ui/Hud.ts` (the collapsible stats panel) remains independent,
 * so concise live tool/field state gets its own status line here.
 */
import { applyHudPanelChrome, HUD_CLASS } from "./hudPanel.ts";

export type ToolId = "pickaxe" | "xray";

interface HotbarItemDef {
  id: ToolId;
  keyLabel: string;
  keyCode: string;
  label: string;
}

const ITEMS: HotbarItemDef[] = [
  { id: "pickaxe", keyLabel: "2", keyCode: "Digit2", label: "Pickaxe" },
  { id: "xray", keyLabel: "3", keyCode: "Digit3", label: "X-ray" },
];

/** The empty-hand slot's key — slot 1, the leftmost. */
const HAND_KEY_LABEL = "1";
const HAND_KEY_CODE = "Digit1";

/** Layout only — the frame/ground/equipped-state colors all live in
 * `theme.css` behind `.hud-slot` (see `renderActiveState`). */
const SLOT_BASE_STYLE: Partial<CSSStyleDeclaration> = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: "3px",
  width: "92px",
  padding: "7px 4px 6px",
  cursor: "pointer",
  userSelect: "none",
  textAlign: "center",
};

export class Hotbar {
  private readonly root: HTMLElement;
  private equipped: ToolId | null = null;
  private readonly slotEls = new Map<ToolId | "hand", HTMLElement>();
  private readonly statusEl: HTMLElement;
  /** The status strip's text node holder. Separate from `statusEl` because
   * `statusEl` carries the panel chrome's overlay children, and writing
   * `textContent` on it would delete them. */
  private readonly statusTextEl: HTMLElement;
  private lastStatusText = "";

  constructor(
    container: HTMLElement,
    private readonly onChange: (tool: ToolId | null) => void,
  ) {
    // Bottom-anchored column, so it grows UPWARD: the rack is the last child
    // and sits at a fixed 16px from the bottom edge whether or not the status
    // strip above it is showing. (The strip used to hang under the rack, and
    // every time it appeared it shoved the rack up by its own height.)
    this.root = document.createElement("div");
    Object.assign(this.root.style, {
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
      gap: "5px",
      padding: "5px",
    } satisfies Partial<CSSStyleDeclaration>);
    // One frame around the whole rack (the slots themselves are cells inside
    // it), which is how a cockpit weapon/system selector reads.
    applyHudPanelChrome(bar);

    const handSlot = this.buildSlot(HAND_KEY_LABEL, "Empty Hand", () => this.equip(null));
    this.slotEls.set("hand", handSlot);
    bar.appendChild(handSlot);

    for (const item of ITEMS) {
      const slot = this.buildSlot(item.keyLabel, item.label, () => this.toggleEquip(item.id));
      this.slotEls.set(item.id, slot);
      bar.appendChild(slot);
    }

    this.statusEl = document.createElement("div");
    this.statusEl.classList.add(HUD_CLASS.dim);
    Object.assign(this.statusEl.style, {
      padding: "4px 12px",
      letterSpacing: "0.03em",
      textAlign: "center",
      whiteSpace: "pre",
      display: "none",
    } satisfies Partial<CSSStyleDeclaration>);
    // Quieter sub-frame + no corner ticks: this strip is a readout floating
    // over the rack below it, not a panel in its own right.
    applyHudPanelChrome(this.statusEl, { variant: "inset", corners: false });
    this.statusTextEl = document.createElement("div");
    this.statusEl.appendChild(this.statusTextEl);

    // Strip first, rack last — see the root's comment for why the order is
    // load-bearing.
    this.root.appendChild(this.statusEl);
    this.root.appendChild(bar);
    container.appendChild(this.root);

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
   * only way to get back to empty-hand besides slot 1. */
  private toggleEquip(tool: ToolId): void {
    this.equip(this.equipped === tool ? null : tool);
  }

  /** Status line above the bar. Skips the DOM write when unchanged, the same
   * discipline `Hud.ts` uses for its own text. */
  setStatusLine(text: string): void {
    if (text === this.lastStatusText) return;
    this.lastStatusText = text;
    if (text) {
      this.statusTextEl.textContent = text;
      this.statusEl.style.display = "block";
    } else {
      this.statusEl.style.display = "none";
    }
  }

  private buildSlot(keyLabel: string, name: string, onClick: () => void): HTMLElement {
    const slot = document.createElement("div");
    slot.classList.add(HUD_CLASS.slot);
    Object.assign(slot.style, SLOT_BASE_STYLE);

    const key = document.createElement("div");
    key.textContent = keyLabel;
    key.classList.add(HUD_CLASS.slotKey);

    const label = document.createElement("div");
    label.textContent = name;
    label.classList.add(HUD_CLASS.slotLabel);

    // Exactly two children, in this order (key then label) — the Phase 4
    // verification harness identifies slots structurally by that shape.
    slot.appendChild(key);
    slot.appendChild(label);
    slot.addEventListener("click", onClick);
    return slot;
  }

  /** Equip highlight. The lit state is the SIGNAL teal (#7fffe0, the same
   * color the 3D hover wireframe uses) at full strength against deliberately
   * dim cyan chrome — see `.hud-slot.is-equipped` in theme.css. Toggling the
   * class instead of writing inline colors keeps the whole skin in one file. */
  private renderActiveState(): void {
    for (const [id, el] of this.slotEls) {
      const isActive = (id === "hand" && this.equipped === null) || id === this.equipped;
      el.classList.toggle(HUD_CLASS.slotEquipped, isActive);
    }
  }

  private handleKeydown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented) return;
    const target = event.target as HTMLElement | null;
    if (
      target?.isContentEditable ||
      target?.tagName === "INPUT" ||
      target?.tagName === "TEXTAREA" ||
      target?.tagName === "SELECT"
    ) {
      return;
    }
    if (event.code === HAND_KEY_CODE) {
      this.equip(null);
      return;
    }
    const item = ITEMS.find((i) => i.keyCode === event.code);
    if (item) this.toggleEquip(item.id);
  };

  dispose(): void {
    window.removeEventListener("keydown", this.handleKeydown);
    this.root.remove();
  }
}
