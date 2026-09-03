import "./theme.css";

/**
 * The one shared panel-chrome wrapper (Phase 6).
 *
 * Everything on screen that looks like a piece of cockpit hardware — the stats
 * HUD, the inventory, the hotbar, the lightbox, the minimap — gets its frame
 * from `applyHudPanelChrome()` here, and its type/controls from the class-name
 * constants in `HUD_CLASS`. Nothing else in the app should be writing border /
 * glow / background CSS of its own: if a panel needs a new bit of chrome, it
 * belongs in `theme.css` behind a token, not inline in the panel file.
 *
 * This is deliberately an *apply-to-an-existing-element* helper rather than a
 * factory that returns a new wrapper node. Every panel here predates the skin
 * and already owns a carefully-built DOM (with pointer-events opt-ins,
 * fixed-height caption boxes, canvas layering, and so on), so retrofitting the
 * skin must not reparent anything — the visual pass changes how the panels
 * look, never what they are.
 *
 * Layering contract (the reason `hud-panel` sets `isolation: isolate`):
 *
 *   z-index -1  scanline/CRT texture   ← above the panel's own background,
 *                                        BELOW all panel content
 *   z-index  0  panel content          ← untouched, in normal flow
 *   z-index  2  corner brackets        ← above content, `pointer-events: none`
 *
 * Putting the scanlines *under* the content rather than over it is a
 * functional requirement, not a taste call: the minimap's density image must
 * render exactly as the pipeline drew it, and no overlay may ever sit between
 * the cursor and an interactive control.
 */

export const HUD_CLASS = {
  panel: "hud-panel",
  panelInset: "hud-panel--inset",
  title: "hud-title",
  titleBar: "hud-title-bar",
  dim: "hud-dim",
  readout: "hud-readout",
  button: "hud-button",
  slot: "hud-slot",
  slotKey: "hud-slot__key",
  slotLabel: "hud-slot__label",
  slotEquipped: "is-equipped",
  row: "hud-row",
  thumb: "hud-thumb",
  scroll: "hud-scroll",
} as const;

export interface HudPanelChromeOptions {
  /** Targeting-reticle corner ticks. Off for very small/among-content frames. */
  corners?: boolean;
  /** CRT scanline texture. Off where the panel is mostly one opaque image. */
  scanlines?: boolean;
  /** `"inset"` is the quieter sub-frame used for strips nested in/near a
   * bigger panel (hotbar status line, lightbox frame). */
  variant?: "panel" | "inset";
}

const CORNER_CLASSES = [
  "hud-panel__corner--tl",
  "hud-panel__corner--tr",
  "hud-panel__corner--bl",
  "hud-panel__corner--br",
] as const;

/**
 * Skins `el` as a cockpit panel: frame, glow, ground, CRT texture, corner
 * ticks. Idempotent — calling it twice will not stack duplicate overlays.
 *
 * The caller keeps ownership of layout (position, size, padding, flex): this
 * only ever writes `position` when the element is still `static`, since the
 * absolutely-positioned overlays need a containing block.
 */
export function applyHudPanelChrome(el: HTMLElement, options: HudPanelChromeOptions = {}): void {
  const { corners = true, scanlines = true, variant = "panel" } = options;

  el.classList.add(HUD_CLASS.panel);
  if (variant === "inset") el.classList.add(HUD_CLASS.panelInset);

  // Only supply a containing block if the panel doesn't already have one of
  // its own — every existing panel root is `position: fixed`, and clobbering
  // that would drop it back into the document flow.
  if (!el.style.position) el.style.position = "relative";

  if (scanlines && !el.querySelector(":scope > .hud-panel__scan")) {
    const scan = document.createElement("div");
    scan.className = "hud-panel__scan";
    scan.setAttribute("aria-hidden", "true");
    // Prepended rather than appended purely for readability of the DOM tree;
    // paint order comes from `z-index: -1`, not from sibling order.
    el.prepend(scan);
  }

  if (corners && !el.querySelector(":scope > .hud-panel__corner")) {
    for (const cornerClass of CORNER_CLASSES) {
      const corner = document.createElement("div");
      corner.className = `hud-panel__corner ${cornerClass}`;
      corner.setAttribute("aria-hidden", "true");
      el.appendChild(corner);
    }
  }
}

/** Header text styled as a HUD readout label (uppercase, letter-spaced, lit). */
export function applyHudTitle(el: HTMLElement, options: { bar?: boolean } = {}): void {
  el.classList.add(HUD_CLASS.title);
  if (options.bar) el.classList.add(HUD_CLASS.titleBar);
}
