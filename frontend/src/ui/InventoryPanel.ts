import type { Inventory, InventoryStack } from "../interaction/Inventory.ts";
import { resolveSubsetName, resolveThumbUrl, type PointIndex } from "../streaming/PointIndex.ts";
import { INVENTORY_THUMBS_PAGE_SIZE } from "../config.ts";
import { Lightbox } from "./Lightbox.ts";
import { applyHudPanelChrome, applyHudTitle, HUD_CLASS } from "./hudPanel.ts";

const PANEL_STYLE: Partial<CSSStyleDeclaration> = {
  position: "fixed",
  top: "14px",
  right: "14px",
  width: "300px",
  maxHeight: "calc(100vh - 28px)",
  display: "flex",
  flexDirection: "column",
  fontSize: "11px",
  lineHeight: "1.5",
  zIndex: "10",
  // Frame/ground/type all come from `applyHudPanelChrome` below, but this
  // panel DOES need real pointer events (unlike Hud.ts, which is display-only),
  // so it cannot inherit the app container's default pointer-events:none.
  pointerEvents: "auto",
};

export interface InventoryPanelOptions {
  /** Resolves once `point_index.bin` has loaded; may still be pending when
   * the panel first renders (extraction can happen before it lands), so every
   * thumbnail request awaits it rather than assuming it's ready. */
  getPointIndex: () => Promise<PointIndex>;
  /** Sends one extracted point back into its source voxel. Returns whether it
   * actually did (see `MiningController.returnRow`). */
  onReturnRow: (stackId: string, rowId: number) => boolean;
  /** Sends an entire stack back into its source voxel. */
  onReturnStack: (stackId: string) => boolean;
  /** Fired when the pointer enters/leaves a stack row — drives the 3D + 2D
   * flashlight (see `MinimapBridge.highlightVoxel`). `null` on leave. */
  onHoverStack: (stack: InventoryStack | null) => void;
  /** Points-table id for the lightbox's original-image lookup
   * (`DatasetConfig.pointsId`); `null` leaves the lightbox thumbnail-only. */
  pointsId: string | null;
}

interface StackRowView {
  el: HTMLElement;
  /** The stack object this row's closures are bound to. A stack that is fully
   * returned and later re-extracted gets a NEW object under the SAME id, so
   * the row has to be rebuilt rather than reused — comparing identity here is
   * what catches that. */
  stack: InventoryStack;
  update(): void;
}

/**
 * Extraction inventory panel. Lists one row per source voxel; clicking a row
 * toggles an inline grid of that stack's thumbnails.
 *
 * Click over hover for the expand/collapse, deliberately: even now that Phase
 * 3.5 keeps the cursor free/visible at all times (no more
 * `PointerLockControls`), a click is still a more deliberate, more
 * Playwright-testable gesture than hover-to-reveal — and it means this panel's
 * interaction model doesn't depend on whichever control scheme the 3D view
 * happens to be using. Row HOVER is used for something else entirely (the
 * flashlight, below), which is passive and can't be triggered accidentally.
 *
 * Thumbnails are lazy on two axes: (1) a stack's grid is only built the
 * first time its row is expanded, not when it's extracted or when the panel
 * lists it, and (2) an expanded grid only renders `INVENTORY_THUMBS_PAGE_SIZE`
 * `<img>`s up front with a "Show N more" button for the rest — a single
 * voxel can hold tens of thousands of points, and rendering that many images
 * at once on click would visibly hang the tab.
 *
 * ## Phase 6.5 additions
 *
 * - **Rows update in place.** Extraction is continuous, so a stack grows a
 *   batch at a time and shrinks point-by-point when items are returned. Each
 *   row keeps an `update()` that re-reads its (identity-stable, see
 *   `Inventory`) stack, so an already-expanded row's loaded thumbnails survive
 *   its own stack changing, not just some other stack changing.
 * - **Per-item return.** Every grid cell carries a `↩` button revealed on
 *   hover, and the whole cell also accepts a right-click, both of which send
 *   that one point back into its source voxel. Two affordances for one action
 *   because they cover different instincts and cost one shared handler: the
 *   button is the discoverable one (plus the grid's own hint line spells both
 *   out in text), right-click is the fast one. The badge is hover-revealed
 *   rather than always-on because these cells are 28px — a permanent badge
 *   would cover the image it is labelling. A "RETURN ALL" button under the
 *   grid covers "put this whole voxel back" without needing 4,000 clicks.
 * - **Hovering a row aims the flashlight** at that stack's source voxel in
 *   both the 3D world and the 2D minimap (`onHoverStack`).
 * - **The lightbox is a carousel** over the stack's FULL `rowIds`, not just
 *   the page currently rendered here.
 * - **Rows for removed stacks are actually removed.** Pre-6.5 this method
 *   only ever appended, so a restored (stack-removed) voxel left a ghost row
 *   on screen — invisible before, when whole-voxel restore was rare and
 *   manual; unmissable now that returning the last point of a stack deletes
 *   it as a matter of course.
 */
export class InventoryPanel {
  private readonly root: HTMLElement;
  private readonly headerEl: HTMLElement;
  /** Right-hand half of the header strip — carries the live stack/point
   * counts, so the (static) "Inventory" title next to it never reflows. */
  private readonly headerCountEl: HTMLElement;
  private readonly listEl: HTMLElement;
  private readonly emptyEl: HTMLElement;
  /** Public so `main.ts` can hang it off `window.lsv` for the headless
   * harness (current row, original-load status). */
  readonly lightbox: Lightbox;

  /** Built once per stack id and reused across store updates, so an
   * already-expanded stack's loaded thumbnails and open/closed state survive
   * an unrelated new stack being extracted elsewhere. */
  private readonly rows = new Map<string, StackRowView>();

  /** Cached once `point_index.bin` resolves, so the lightbox carousel (which
   * navigates synchronously, on a keypress) can resolve URLs without an await
   * per step. Null until then; the grid can't have rendered anything yet in
   * that window, so nothing can be clicked into the lightbox either. */
  private pointIndex: PointIndex | null = null;

  /** id of the stack whose row the pointer is currently over, or null. See
   * `validateHover` for why this is tracked rather than just fired-and-
   * forgotten. */
  private hoveredStackId: string | null = null;

  constructor(
    container: HTMLElement,
    private readonly inventory: Inventory,
    private readonly options: InventoryPanelOptions,
  ) {
    this.root = document.createElement("div");
    this.root.className = "ls-inventory-panel";
    Object.assign(this.root.style, PANEL_STYLE);
    applyHudPanelChrome(this.root);

    this.headerEl = document.createElement("div");
    applyHudTitle(this.headerEl, { bar: true });
    Object.assign(this.headerEl.style, {
      display: "flex",
      alignItems: "baseline",
      justifyContent: "space-between",
      gap: "10px",
      padding: "9px 12px 8px",
      flex: "none",
    } satisfies Partial<CSSStyleDeclaration>);
    const headerTitleEl = document.createElement("span");
    headerTitleEl.textContent = "Inventory";
    this.headerCountEl = document.createElement("span");
    this.headerCountEl.classList.add(HUD_CLASS.dim);
    // The counts run long ("12 STACKS · 123,456 PTS"); at the title's tracking
    // that would wrap the header, so this half drops the letter-spacing.
    this.headerCountEl.style.letterSpacing = "0.04em";
    this.headerEl.append(headerTitleEl, this.headerCountEl);
    this.root.appendChild(this.headerEl);

    this.emptyEl = document.createElement("div");
    this.emptyEl.textContent = "Hold click on a voxel to extract its points into your inventory.";
    this.emptyEl.classList.add(HUD_CLASS.dim);
    Object.assign(this.emptyEl.style, {
      padding: "10px 12px",
      letterSpacing: "0.02em",
    } satisfies Partial<CSSStyleDeclaration>);
    this.root.appendChild(this.emptyEl);

    this.listEl = document.createElement("div");
    this.listEl.classList.add(HUD_CLASS.scroll);
    Object.assign(this.listEl.style, {
      overflowY: "auto",
    } satisfies Partial<CSSStyleDeclaration>);
    this.root.appendChild(this.listEl);

    // Coarse safety net for the row-level hover handlers below: whatever the
    // per-row `pointerleave`s did or didn't fire, leaving the panel entirely
    // means nothing in here is hovered, so the flashlight must be off. Moving
    // BETWEEN rows never reaches this (it doesn't leave the panel), so it
    // can't stomp on a legitimate hover.
    this.root.addEventListener("pointerleave", () => this.setHovered(null));

    container.appendChild(this.root);
    this.lightbox = new Lightbox(container, { pointsId: options.pointsId });

    void this.options
      .getPointIndex()
      .then((index) => {
        this.pointIndex = index;
      })
      .catch(() => {
        /* already logged by the row that requested it */
      });

    this.render(inventory.stacks);
    inventory.store.subscribe((stacks) => this.render(stacks));
  }

  /**
   * Where extracted points should appear to fly TO, in viewport CSS pixels —
   * the panel's own on-screen box (see `ui/ExtractionFlight.ts`). Read live
   * rather than cached: the panel is anchored top-right, so it moves whenever
   * the window is resized.
   */
  dropTargetRect(): DOMRect {
    return this.root.getBoundingClientRect();
  }

  /**
   * Re-checks, against the browser's own authoritative `:hover` state, that the
   * row this panel thinks is hovered really is. Called once per frame from the
   * render loop; early-returns to a single null check when nothing is hovered,
   * so it costs nothing in the normal case.
   *
   * This exists because of a real, reproduced bug, and the mechanism is worth
   * writing down. Returning a point removes its `<img>` cell — the very element
   * the pointer is inside. Chromium responds by re-running its boundary logic
   * against the mutated tree, which dispatches a fresh `pointerenter` on the
   * (still-hovered) ROW. That re-entry is legitimate, but it is queued to a
   * later lifecycle update, and if the pointer leaves the panel in the meantime
   * the app sees `pointerleave` … then that stale `pointerenter` — leaving the
   * 3D+2D flashlight lit with the cursor nowhere near the panel. Traced with a
   * pointer-event log: `row:pointerout(return-button) → panel:pointerenter →
   * row:pointerenter` fired as a unit right after the DOM mutation.
   *
   * No ordering fix wins that race reliably, because the spurious event is
   * indistinguishable from a real one at dispatch time. So the hover state is
   * made SELF-CORRECTING instead: `:hover` is Chromium's own answer to "is the
   * pointer over this element", it is always up to date by the next frame, and
   * one frame of a stuck highlight is invisible.
   */
  validateHover(): void {
    if (!this.hoveredStackId) return;
    const el = this.rows.get(this.hoveredStackId)?.el;
    if (el?.matches(":hover")) return;
    this.setHovered(null);
  }

  /** Single funnel for every hover change, so the tracked id and the callback
   * can never disagree, and a repeat of the same row costs nothing. */
  private setHovered(stack: InventoryStack | null): void {
    const id = stack?.id ?? null;
    if (id === this.hoveredStackId) return;
    this.hoveredStackId = id;
    this.options.onHoverStack(stack);
  }

  private render(stacks: InventoryStack[]): void {
    const totalPoints = this.inventory.totalPoints;
    this.headerCountEl.textContent = `${stacks.length} stack${stacks.length === 1 ? "" : "s"} · ${totalPoints.toLocaleString()} pts`;
    this.emptyEl.hidden = stacks.length > 0;

    const live = new Set<string>();
    for (const stack of stacks) {
      live.add(stack.id);
      const existing = this.rows.get(stack.id);
      // Identity check, not just presence: a stack that was fully returned and
      // then re-extracted is a NEW object under the same id, and every closure
      // in the cached row still points at the dead one.
      if (!existing || existing.stack !== stack) {
        existing?.el.remove();
        this.rows.set(stack.id, this.buildRow(stack));
      }
    }

    // Drop rows whose stack is gone (fully returned / restored).
    for (const [id, view] of this.rows) {
      if (live.has(id)) continue;
      view.el.remove();
      this.rows.delete(id);
      if (this.hoveredStackId === id) this.setHovered(null);
    }

    // Reorder to match the store, touching the DOM ONLY where the order
    // actually differs. The obvious version of this — `appendChild` every row
    // every render — relocates each node (appendChild on an attached node is a
    // move), and moving the node the pointer is currently inside scrambles
    // Chromium's hover chain: the detach fires `pointerleave`, the re-attach
    // re-enters, and the NEXT real mouse-move out of the row then produces no
    // leave at all. Caught for real — returning a point (which mutates the
    // stack, hence re-renders) left the inventory-hover flashlight stuck on
    // after the pointer had left the panel. Rows almost never reorder, so this
    // loop is normally zero DOM writes.
    for (let i = 0; i < stacks.length; i++) {
      const view = this.rows.get(stacks[i].id)!;
      const current = this.listEl.children[i];
      if (current !== view.el) this.listEl.insertBefore(view.el, current ?? null);
      view.update();
    }
  }

  private buildRow(stack: InventoryStack): StackRowView {
    const row = document.createElement("div");
    row.className = `ls-inventory-row ${HUD_CLASS.row}`;
    row.dataset.stackId = stack.id;
    Object.assign(row.style, {
      padding: "8px 12px",
      cursor: "pointer",
    } satisfies Partial<CSSStyleDeclaration>);

    // Hovering the row aims the flashlight at this stack's source voxel, in
    // the 3D world AND on the 2D minimap — the same highlight the minimap's
    // own hover drives (see `MinimapBridge.highlightVoxel`).
    row.addEventListener("pointerenter", () => this.setHovered(stack));
    row.addEventListener("pointerleave", () => {
      if (this.hoveredStackId === stack.id) this.setHovered(null);
    });

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
    thumb.classList.add(HUD_CLASS.thumb);
    Object.assign(thumb.style, {
      width: "32px",
      height: "32px",
      objectFit: "cover",
      flex: "none",
    } satisfies Partial<CSSStyleDeclaration>);
    summary.appendChild(thumb);
    this.options
      .getPointIndex()
      .then((index) => {
        const url = resolveThumbUrl(index, stack.reprRowId);
        if (url) thumb.src = url;
      })
      .catch((error) => console.error("[InventoryPanel] point_index load failed", error));

    const label = document.createElement("div");
    label.style.flex = "1";
    const countEl = document.createElement("div");
    countEl.className = "ls-inventory-count";
    countEl.classList.add(HUD_CLASS.readout);
    countEl.style.letterSpacing = "0.06em";
    const originEl = document.createElement("div");
    originEl.classList.add(HUD_CLASS.dim);
    originEl.style.fontSize = "10px";
    originEl.textContent = `chunk ${stack.chunkId} · voxel ${stack.localVoxelId}`;
    label.append(countEl, originEl);
    summary.appendChild(label);

    const caret = document.createElement("span");
    caret.textContent = "▸";
    caret.classList.add(HUD_CLASS.dim);
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

    // Spelled out in text so the two return affordances below are discoverable
    // without the user first hovering a 28px tile to find a hidden button.
    const hint = document.createElement("div");
    hint.classList.add(HUD_CLASS.dim);
    Object.assign(hint.style, {
      gridColumn: "1 / -1",
      fontSize: "9px",
      letterSpacing: "0.04em",
      paddingBottom: "2px",
    } satisfies Partial<CSSStyleDeclaration>);
    hint.textContent = "click = enlarge (◄ ► to page) · ↩ or right-click = return to voxel";

    /** rowId → its grid cell, so a return can drop exactly one tile without
     * rebuilding the page (and so `update()` can reconcile cheaply). */
    const cells = new Map<number, HTMLElement>();

    const showMoreBtn = document.createElement("button");
    showMoreBtn.type = "button";
    showMoreBtn.className = "ls-inventory-more";
    showMoreBtn.classList.add(HUD_CLASS.button);
    Object.assign(showMoreBtn.style, {
      gridColumn: "1 / -1",
      marginTop: "5px",
      padding: "5px 4px",
    } satisfies Partial<CSSStyleDeclaration>);

    const returnAllBtn = document.createElement("button");
    returnAllBtn.type = "button";
    returnAllBtn.className = "ls-inventory-return-all";
    returnAllBtn.classList.add(HUD_CLASS.button);
    Object.assign(returnAllBtn.style, {
      gridColumn: "1 / -1",
      marginTop: "4px",
      padding: "5px 4px",
    } satisfies Partial<CSSStyleDeclaration>);

    let expanded = false;
    let builtOnce = false;

    const buildCell = (rowId: number, url: string): HTMLElement => {
      const cell = document.createElement("div");
      cell.className = "ls-inventory-cell";
      cell.dataset.rowId = String(rowId);
      Object.assign(cell.style, {
        position: "relative",
        width: "100%",
        aspectRatio: "1",
      } satisfies Partial<CSSStyleDeclaration>);

      const img = document.createElement("img");
      img.src = url;
      img.width = 28;
      img.height = 28;
      img.loading = "lazy";
      img.decoding = "async";
      img.alt = `row ${rowId}`;
      img.classList.add(HUD_CLASS.thumb);
      Object.assign(img.style, {
        width: "100%",
        height: "100%",
        objectFit: "cover",
        cursor: "zoom-in",
        display: "block",
      } satisfies Partial<CSSStyleDeclaration>);
      cell.appendChild(img);

      const returnBtn = document.createElement("button");
      returnBtn.type = "button";
      returnBtn.className = "ls-inventory-return";
      returnBtn.classList.add(HUD_CLASS.button);
      returnBtn.textContent = "↩";
      returnBtn.title = `Return row ${rowId} to chunk ${stack.chunkId} · voxel ${stack.localVoxelId}`;
      Object.assign(returnBtn.style, {
        position: "absolute",
        top: "0",
        right: "0",
        width: "13px",
        height: "13px",
        lineHeight: "11px",
        padding: "0",
        fontSize: "9px",
        letterSpacing: "0",
        // Hover-revealed via JS rather than a CSS `:hover` rule: `theme.css` is
        // the shared skin asset and this is one panel's local affordance, so it
        // does not belong in there.
        opacity: "0",
        transition: "opacity 120ms ease",
      } satisfies Partial<CSSStyleDeclaration>);
      cell.addEventListener("pointerenter", () => {
        returnBtn.style.opacity = "1";
      });
      cell.addEventListener("pointerleave", () => {
        returnBtn.style.opacity = "0";
      });

      const returnThisPoint = (event: Event): void => {
        event.preventDefault();
        // Must not reach the row's own expand/collapse toggle, nor the
        // lightbox-opening click on the image underneath.
        event.stopPropagation();
        this.options.onReturnRow(stack.id, rowId);
        // No DOM surgery here on purpose: the return mutates the stack, which
        // publishes through the store, which re-renders this row via
        // `update()` — one reconciliation path for every source of change.
      };
      returnBtn.addEventListener("click", returnThisPoint);
      cell.addEventListener("contextmenu", returnThisPoint);

      img.addEventListener("click", (event) => {
        // Opening the lightbox must not also toggle the row's expand/collapse
        // — stopPropagation is defensive (the grid and the row's `summary`
        // toggle are siblings, not ancestor/descendant, so this click wouldn't
        // reach it anyway), matching the same defensiveness the buttons use.
        event.stopPropagation();
        this.lightbox.open({
          // The FULL list, not this page — that's the whole point of the
          // carousel (see `Lightbox`).
          rowIds: stack.rowIds,
          index: Math.max(0, stack.rowIds.indexOf(rowId)),
          resolveUrl: (id) => (this.pointIndex ? resolveThumbUrl(this.pointIndex, id) : null),
          resolveSubsetName: (id) => (this.pointIndex ? resolveSubsetName(this.pointIndex, id) : null),
          contextLabel: `chunk ${stack.chunkId} · voxel ${stack.localVoxelId}`,
        });
      });

      cell.appendChild(returnBtn);
      return cell;
    };

    /** Materializes up to one page of not-yet-rendered points. Walks the
     * stack's live `rowIds` and skips ids that already have a cell, so it
     * behaves correctly both when the stack GREW (a new extraction cycle
     * appended points) and when it SHRANK (points were returned). */
    const appendPage = async (): Promise<void> => {
      const index = await this.options.getPointIndex();
      const frag = document.createDocumentFragment();
      let added = 0;
      for (const rowId of stack.rowIds) {
        if (added >= INVENTORY_THUMBS_PAGE_SIZE) break;
        if (cells.has(rowId)) continue;
        const url = resolveThumbUrl(index, rowId);
        if (!url) continue;
        const cell = buildCell(rowId, url);
        cells.set(rowId, cell);
        frag.appendChild(cell);
        added++;
      }
      grid.insertBefore(frag, showMoreBtn);
      updateGridControls();
    };

    const updateGridControls = (): void => {
      const remaining = stack.rowIds.length - cells.size;
      showMoreBtn.textContent = `Show ${Math.min(remaining, INVENTORY_THUMBS_PAGE_SIZE).toLocaleString()} more (${remaining.toLocaleString()} left)`;
      showMoreBtn.hidden = remaining <= 0;
      returnAllBtn.textContent = `Return all ${stack.rowIds.length.toLocaleString()} to voxel`;
    };

    showMoreBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      void appendPage();
    });

    returnAllBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      this.options.onReturnStack(stack.id);
    });

    summary.addEventListener("click", () => {
      expanded = !expanded;
      caret.textContent = expanded ? "▾" : "▸";
      grid.hidden = !expanded;
      if (expanded && !builtOnce) {
        builtOnce = true;
        grid.append(hint, showMoreBtn, returnAllBtn);
        void appendPage();
      }
    });

    const update = (): void => {
      const extracted = stack.rowIds.length;
      countEl.textContent =
        `${extracted.toLocaleString()} / ${stack.totalPoints.toLocaleString()} PTS · ` +
        `${Math.round((extracted / Math.max(1, stack.totalPoints)) * 100)}%`;
      if (!builtOnce) return;
      // Drop cells for points that went back into the voxel. Cheap: `cells` is
      // at most a few hundred entries (one page at a time), and the Set is
      // built once per update rather than per cell.
      if (cells.size > 0) {
        const liveRows = new Set(stack.rowIds);
        for (const [rowId, cell] of cells) {
          if (liveRows.has(rowId)) continue;
          cell.remove();
          cells.delete(rowId);
        }
      }
      updateGridControls();
    };

    update();
    return { el: row, stack, update };
  }
}
