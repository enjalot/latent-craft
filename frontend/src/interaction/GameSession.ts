import type { MiningController } from "./MiningController.ts";
import { miningSaveCsv, miningSaveFromCsv, validateMiningSave } from "./MiningSave.ts";
import type { Manifest } from "../streaming/Manifest.ts";
import { verifyMiningPostings } from "./VerifyMiningSave.ts";
import { resolveThumbUrl, type PointIndex } from "../streaming/PointIndex.ts";
import type { InventoryPanel } from "../ui/InventoryPanel.ts";
import { HUD_CLASS } from "../ui/hudPanel.ts";

export interface PlaySettings { speed: number; radius: number; position?: number[]; quaternion?: number[] }

/** Dataset/revision-scoped saves. Inventory writes only after mutations, never
 * per frame; tiny flight settings save independently. Quota errors stay visible
 * and do not erase the last successful save. CSV is the portable backup. */
export class GameSession {
  readonly settings: PlaySettings = { speed: 8, radius: 2 };
  private readonly key: string;
  private readonly message = document.createElement("div");
  private timer: ReturnType<typeof setTimeout> | undefined;
  private dirty = false;
  private disposed = false;
  private readonly unsubscribe: () => void;
  private lastSettings = "";
  private lastSettingsAt = -Infinity;
  private storageWarning = "";

  constructor(private readonly dataset: string, private readonly manifest: Manifest,
    private readonly mining: MiningController, private readonly panel: InventoryPanel,
    private readonly getIndex: () => Promise<PointIndex>) {
    this.key = `lsv-game-v1:${dataset}:${manifest.baseUrl}`;
    const bar = document.createElement("div");
    Object.assign(bar.style, { display: "flex", gap: "6px", padding: "8px 12px 2px" });
    const button = (text: string) => {
      const b = document.createElement("button"); b.type = "button"; b.textContent = text; b.classList.add(HUD_CLASS.button); bar.append(b); return b;
    };
    const exportButton = button("Export CSV"), importButton = button("Import CSV");
    const file = document.createElement("input"); file.type = "file"; file.accept = ".csv,text/csv"; file.hidden = true;
    importButton.addEventListener("click", () => file.click());
    exportButton.addEventListener("click", async () => {
      exportButton.disabled = true;
      try {
        if (!this.mining.inventory.totalPoints) throw new Error("Mine an image before exporting.");
        const save = this.mining.snapshot(this.dataset), index = await this.getIndex();
        this.status("Preparing CSV and image URLs…");
        const csv = await miningSaveCsv(save, async row => {
          if (this.disposed) throw new DOMException("Map closed", "AbortError");
          await index.ensure?.(row);
          const thumbnail = resolveThumbUrl(index, row);
          if (!thumbnail) throw new Error(`No thumbnail reference for row ${row}`);
          return new URL(thumbnail, window.location.href).href;
        });
        if (this.disposed) return;
        const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
        const link = document.createElement("a"); link.href = url; link.download = `${this.dataset}-inventory.csv`;
        link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
        this.status("CSV exported (includes thumbnail URLs).");
      } catch (error) { this.status(String(error)); }
      finally { exportButton.disabled = false; }
    });
    file.addEventListener("change", async () => {
      const selected = file.files?.[0]; file.value = ""; if (!selected) return;
      importButton.disabled = true;
      try {
        if (selected.size > 64 * 1024 ** 2) throw new Error("CSV is over the 64 MiB import limit.");
        const save = validateMiningSave(miningSaveFromCsv(await selected.text()), this.dataset, this.manifest);
        this.status("Checking CSV against this map’s image index…");
        await verifyMiningPostings(save, this.manifest, () => this.disposed);
        if (this.disposed) return;
        if (this.mining.inventory.totalPoints && !window.confirm("Replace this dataset’s current inventory with the imported CSV?")) {
          this.status("Import cancelled; inventory unchanged."); return;
        }
        this.mining.restore(save, this.dataset); this.focusLatest(); this.flush();
      } catch (error) { this.status(`Import failed; inventory unchanged. ${String(error)}`); }
      finally { importButton.disabled = false; }
    });
    Object.assign(this.message.style, { padding: "3px 12px 7px", fontSize: "10px", opacity: ".75", overflowWrap: "anywhere" });
    this.message.setAttribute("role", "status");
    this.panel.actionsDock.append(bar, file, this.message);
    this.restore();
    this.unsubscribe = mining.inventory.store.subscribe(() => {
      this.dirty = true; this.status("Saving…");
      // A fixed trailing deadline also saves during a continuous mining hold.
      if (this.timer === undefined) this.timer = setTimeout(() => this.flush(), 750);
    });
  }

  private restore(): void {
    try {
      const settings = JSON.parse(localStorage.getItem(`${this.key}:settings`) ?? "null") as PlaySettings | null;
      if (settings) {
        if (Number.isFinite(settings.speed)) this.settings.speed = Math.max(1, Math.min(64, settings.speed));
        if (Number.isFinite(settings.radius)) this.settings.radius = Math.max(1, Math.min(48, settings.radius));
        const finite = (v: unknown, length: number): v is number[] => Array.isArray(v) && v.length === length && v.every(n => Number.isFinite(n));
        if (finite(settings.position, 3) && settings.position.every(n => Math.abs(n) < this.manifest.worldScale * 10)) this.settings.position = settings.position;
        if (finite(settings.quaternion, 4) && Math.abs(Math.hypot(...settings.quaternion) - 1) < .01) this.settings.quaternion = settings.quaternion;
      }
      const raw = localStorage.getItem(this.key);
      if (raw) { this.mining.restore(JSON.parse(raw), this.dataset); this.focusLatest(); this.status("Restored saved progress for this map."); }
      else this.status("Progress saves in this browser, per dataset.");
    } catch (error) { this.status(`Could not restore saved progress: ${String(error)}. Existing save kept.`); }
  }

  private focusLatest(): void {
    const latest = this.mining.inventory.stacks.reduce<typeof this.mining.inventory.stacks[number] | null>((a,b) => !a || b.lastExtractedAt > a.lastExtractedAt ? b : a, null);
    if (latest) this.panel.focusMined(latest.id, latest.rowIds.at(-1)!);
  }

  private status(text: string): void { this.message.textContent = this.storageWarning || text; }

  flush(): void {
    clearTimeout(this.timer); this.timer = undefined;
    if (!this.dirty) return;
    try {
      const value = JSON.stringify(this.mining.snapshot(this.dataset));
      localStorage.setItem(this.key, value);
      this.dirty = false; this.storageWarning = "";
      this.status(`Saved · ${this.mining.inventory.totalPoints.toLocaleString()} images · ${(value.length / 1024).toFixed(0)} KiB JSON`);
    } catch {
      this.storageWarning = "Browser storage is full/unavailable. Export CSV to keep current progress; last saved copy is unchanged.";
      this.status("");
    }
  }

  saveSettings(position: readonly number[], quaternion: readonly number[], radius: number, force = false): void {
    if (!force && performance.now() - this.lastSettingsAt < 2000) return;
    this.lastSettingsAt = performance.now();
    Object.assign(this.settings, { position: [...position], quaternion: [...quaternion], radius });
    const value = JSON.stringify(this.settings);
    if (value === this.lastSettings) return;
    try { localStorage.setItem(`${this.key}:settings`, value); this.lastSettings = value; }
    catch { this.status("Movement settings could not be saved in this browser."); }
  }

  dispose(): void { this.disposed = true; this.flush(); this.unsubscribe(); clearTimeout(this.timer); }
}
