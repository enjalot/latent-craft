import type { Inventory, InventoryStack } from "../interaction/Inventory.ts";
import { resolveThumbUrl, type PointIndex } from "../streaming/PointIndex.ts";
import { INVENTORY_THUMBS_PAGE_SIZE } from "../config.ts";
import { Lightbox } from "./Lightbox.ts";

const PANEL_STYLE: Partial<CSSStyleDeclaration> = {
  position: "fixed",
  top: "12px",
  right: "12px",
  width: "300px",
  maxHeight: "calc(100vh - 24px)",
  display: "flex",
  flexDirection: "column",
  background: "rgba(5, 6, 10, 0.72)",
  color: "#d7e2ff",
  fontSize: "12px",
  lineHeight: "1.5",
  fontFamily: "system-ui, sans-serif",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: "6px",
  zIndex: "10",
  // Phase 3 scope is functional, not the late-90s cockpit skin (that's a
  // later phase) — plain readable box, but it DOES need real pointer events
  // (unlike Hud.ts, which is display-only), so this cannot inherit the app
  // container's default pointer-events:none.
  pointerEvents: "auto",
};

/**
 * Unskinned mining inventory panel. Lists one row per mined voxel stack;
 * clicking a row toggles an inline grid of that stack's full-resolution
 * thumbnails.
 *
 * Click over hover, deliberately: even now that Phase 3.5 keeps the cursor
 * free/visible at all times (no more `PointerLockControls`), a click is
 * still a more deliberate, more Playwright-testable gesture than
 * hover-to-reveal — and it means this panel's interaction model doesn't
 * depend on whichever control scheme the 3D view happens to be using.
 *
 * Thumbnails are lazy on two axes: (1) a stack's grid is only built the
 * first time its row is expanded, not when it's mined or when the panel
 * lists it, and (2) an expanded grid only renders `INVENTORY_THUMBS_PAGE_SIZE`
 * `<img>`s up front with a "Show N more" button for the rest — a single
 * voxel can hold thousands of points, and rendering that many images at once
 * on click would visibly hang the tab.
 *
 * Phase 3.5: clicking a grid thumbnail opens it in `Lightbox`, a simple
 * enlarge-on-click modal — see that class's doc comment for why "bigger"
 * means upscaled display of the same 256px source, not a higher-res fetch.
 */
export class InventoryPanel {
  private readonly root: HTMLElement;
  private readonly headerEl: HTMLElement;
  private readonly listEl: HTMLElement;
  private readonly emptyEl: HTMLElement;
  private readonly lightbox: Lightbox;

  /** Built once per stack id and reused across store updates, so an
   * already-expanded stack's loaded thumbnails and open/closed state survive
   * an unrelated new stack being mined elsewhere. */
  private readonly rows = new Map<string, HTMLElement>();

  constructor(
    container: HTMLElement,
    private readonly inventory: Inventory,
    /** Resolves once `point_index.bin` has loaded; may still be pending when
     * the panel first renders (mining can happen before it lands), so every
     * thumbnail request awaits it rather than assuming it's ready. */
    private readonly getPointIndex: () => Promise<PointIndex>,
  ) {
    this.root = document.createElement("div");
    this.root.className = "ls-inventory-panel";
    Object.assign(this.root.style, PANEL_STYLE);

    this.headerEl = document.createElement("div");
    Object.assign(this.headerEl.style, {
      padding: "10px 12px",
      borderBottom: "1px solid rgba(255,255,255,0.12)",
      fontWeight: "600",
    } satisfies Partial<CSSStyleDeclaration>);
    this.root.appendChild(this.headerEl);

    this.emptyEl = document.createElement("div");
    this.emptyEl.textContent = "Mine a voxel (click while flying) to fill your inventory.";
    Object.assign(this.emptyEl.style, {
      padding: "10px 12px",
      opacity: "0.7",
      fontStyle: "italic",
    } satisfies Partial<CSSStyleDeclaration>);
    this.root.appendChild(this.emptyEl);

    this.listEl = document.createElement("div");
    Object.assign(this.listEl.style, {
      overflowY: "auto",
    } satisfies Partial<CSSStyleDeclaration>);
    this.root.appendChild(this.listEl);

    container.appendChild(this.root);
    this.lightbox = new Lightbox(container);

    this.render(inventory.stacks);
    inventory.store.subscribe((stacks) => this.render(stacks));
  }

  private render(stacks: InventoryStack[]): void {
    const totalPoints = this.inventory.totalPoints;
    this.headerEl.textContent = `Inventory — ${stacks.length} stack${stacks.length === 1 ? "" : "s"}, ${totalPoints.toLocaleString()} pts`;
    this.emptyEl.hidden = stacks.length > 0;

    for (const stack of stacks) {
      if (!this.rows.has(stack.id)) this.rows.set(stack.id, this.buildRow(stack));
    }
    // Re-append in the store's current order. Existing nodes are MOVED
    // (appendChild on an already-attached node relocates it), not recreated
    // — this is what preserves an expanded row's loaded <img>s across an
    // unrelated new stack arriving.
    for (const stack of stacks) this.listEl.appendChild(this.rows.get(stack.id)!);
  }

  private buildRow(stack: InventoryStack): HTMLElement {
    const row = document.createElement("div");
    row.className = "ls-inventory-row";
    row.dataset.stackId = stack.id;
    Object.assign(row.style, {
      padding: "8px 12px",
      borderBottom: "1px solid rgba(255,255,255,0.08)",
      cursor: "pointer",
    } satisfies Partial<CSSStyleDeclaration>);

    const summary = document.createElement("div");
    Object.assign(summary.style, {
      display: "flex",
      alignItems: "center",
      gap: "8px",
    } satisfies Partial<CSSStyleDeclaration>);
    row.appendChild(summary);

    const thumb = document.createElement("img");
    thumb.width = 32;
    thumb.height = 32;
    thumb.loading = "lazy";
    thumb.decoding = "async";
    thumb.alt = `row ${stack.reprRowId}`;
    Object.assign(thumb.style, {
      width: "32px",
      height: "32px",
      objectFit: "cover",
      background: "#1b1e28",
      borderRadius: "3px",
      flex: "none",
    } satisfies Partial<CSSStyleDeclaration>);
    summary.appendChild(thumb);
    this.getPointIndex()
      .then((index) => {
        const url = resolveThumbUrl(index, stack.reprRowId);
        if (url) thumb.src = url;
      })
      .catch((error) => console.error("[InventoryPanel] point_index load failed", error));

    const label = document.createElement("div");
    label.style.flex = "1";
    label.innerHTML =
      `<div>${stack.rowIds.length.toLocaleString()} pts</div>` +
      `<div style="opacity:0.6">chunk ${stack.chunkId} · voxel ${stack.localVoxelId}</div>`;
    summary.appendChild(label);

    const caret = document.createElement("span");
    caret.textContent = "▸";
    caret.style.opacity = "0.6";
    summary.appendChild(caret);

    const grid = document.createElement("div");
    grid.className = "ls-inventory-grid";
    grid.hidden = true;
    Object.assign(grid.style, {
      marginTop: "8px",
      display: "grid",
      gridTemplateColumns: "repeat(auto-fill, minmax(28px, 1fr))",
      gap: "3px",
    } satisfies Partial<CSSStyleDeclaration>);
    row.appendChild(grid);

    let expanded = false;
    let shown = 0;
    let builtOnce = false;

    const showMoreBtn = document.createElement("button");
    showMoreBtn.type = "button";
    Object.assign(showMoreBtn.style, {
      gridColumn: "1 / -1",
      marginTop: "4px",
      padding: "4px",
      background: "rgba(255,255,255,0.08)",
      border: "1px solid rgba(255,255,255,0.15)",
      borderRadius: "3px",
      color: "inherit",
      cursor: "pointer",
      font: "inherit",
    } satisfies Partial<CSSStyleDeclaration>);

    const appendBatch = async () => {
      const index = await this.getPointIndex();
      const start = shown;
      const end = Math.min(stack.rowIds.length, start + INVENTORY_THUMBS_PAGE_SIZE);
      const frag = document.createDocumentFragment();
      for (let i = start; i < end; i++) {
        const rowId = stack.rowIds[i];
        const url = resolveThumbUrl(index, rowId);
        if (!url) continue;
        const img = document.createElement("img");
        img.src = url;
        img.width = 28;
        img.height = 28;
        img.loading = "lazy";
        img.decoding = "async";
        img.alt = `row ${rowId}`;
        Object.assign(img.style, {
          width: "100%",
          aspectRatio: "1",
          objectFit: "cover",
          background: "#1b1e28",
          borderRadius: "2px",
          cursor: "zoom-in",
        } satisfies Partial<CSSStyleDeclaration>);
        // Clicking a grid thumbnail opens it enlarged (Lightbox), rather
        // than toggling the row's expand/collapse — stopPropagation is
        // defensive (the grid and the row's `summary` toggle are siblings,
        // not ancestor/descendant, so this click wouldn't reach it anyway),
        // matching the same defensiveness `showMoreBtn` already uses below.
        img.addEventListener("click", (event) => {
          event.stopPropagation();
          this.lightbox.open(url, `row ${rowId} — chunk ${stack.chunkId} · voxel ${stack.localVoxelId}`);
        });
        frag.appendChild(img);
      }
      shown = end;
      grid.insertBefore(frag, showMoreBtn);
      const remaining = stack.rowIds.length - shown;
      showMoreBtn.textContent = `Show ${Math.min(remaining, INVENTORY_THUMBS_PAGE_SIZE)} more (${remaining} left)`;
      showMoreBtn.hidden = remaining <= 0;
    };

    showMoreBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      void appendBatch();
    });

    summary.addEventListener("click", () => {
      expanded = !expanded;
      caret.textContent = expanded ? "▾" : "▸";
      grid.hidden = !expanded;
      if (expanded && !builtOnce) {
        builtOnce = true;
        grid.appendChild(showMoreBtn);
        void appendBatch();
      }
    });

    return row;
  }
}
