import type { DatasetConfig } from "../config.ts";
import { applyHudPanelChrome, applyHudTitle } from "./hudPanel.ts";

const SYNTHETIC_VALUE = "__synthetic__";

export class DatasetPicker {
  private readonly root: HTMLElement;

  constructor(
    container: HTMLElement,
    currentKey: string,
    datasets: Record<string, DatasetConfig>,
    synthetic = false,
  ) {
    this.root = document.createElement("div");
    this.root.className = "ls-dataset-picker";
    Object.assign(this.root.style, {
      position: "fixed",
      top: "14px",
      left: "14px",
      zIndex: "11",
      display: "flex",
      alignItems: "center",
      gap: "10px",
      padding: "6px 9px",
      pointerEvents: "auto",
      fontSize: "11px",
      width: "min(420px, calc(100vw - 28px))",
      boxSizing: "border-box",
    } satisfies Partial<CSSStyleDeclaration>);
    applyHudPanelChrome(this.root, { variant: "inset", corners: false });

    const label = document.createElement("label");
    label.htmlFor = "ls-dataset-select";
    label.textContent = "Dataset";
    applyHudTitle(label);

    const select = document.createElement("select");
    select.id = "ls-dataset-select";
    select.className = "hud-select";
    Object.assign(select.style, { flex: "1", minWidth: "0", width: "0" });
    select.setAttribute("aria-label", "Dataset");

    const bl = document.createElement("optgroup");
    bl.label = "BL";
    const monet = document.createElement("optgroup");
    monet.label = "MONET";
    for (const [key, dataset] of Object.entries(datasets)) {
      const option = document.createElement("option");
      option.value = key;
      option.textContent = dataset.label;
      (key.startsWith("monet-") ? monet : bl).appendChild(option);
    }
    if (bl.children.length) select.appendChild(bl);
    if (monet.children.length) select.appendChild(monet);
    const playground = document.createElement("optgroup");
    playground.label = "PLAYGROUND";
    const syntheticOption = document.createElement("option");
    syntheticOption.value = SYNTHETIC_VALUE;
    syntheticOption.textContent = "Synthetic · procedural field";
    playground.appendChild(syntheticOption);
    select.appendChild(playground);

    if (!synthetic && !datasets[currentKey]) {
      const unknown = document.createElement("option");
      unknown.value = currentKey;
      unknown.textContent = `Unknown · ${currentKey}`;
      select.prepend(unknown);
    }
    const initialValue = synthetic ? SYNTHETIC_VALUE : currentKey;
    select.value = initialValue;
    select.title = select.selectedOptions[0]?.textContent ?? "Choose dataset";
    select.addEventListener("change", () => {
      if (select.value === initialValue) return;
      const url = new URL(window.location.href);
      if (select.value === SYNTHETIC_VALUE) {
        // Retain the real dataset parameter so leaving the playground returns
        // to the user's last selection, rather than always resetting to the
        // registry default.
        url.searchParams.set("synthetic", "1");
      } else {
        url.searchParams.set("dataset", select.value);
        url.searchParams.delete("synthetic");
      }
      window.location.assign(url);
    });

    this.root.append(label, select);
    container.appendChild(this.root);
  }

  dispose(): void {
    this.root.remove();
  }
}
