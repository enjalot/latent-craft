import { PagedRecords, rangeReader } from "./RangeReader.ts";
import { fetchJson } from "../net/fetchTyped.ts";

interface ThumbnailPack { version: number; shard_rows: number;
  subsets: Record<string, { count: number; sizes: number[] }> }
const manifestUrl = import.meta.env.VITE_THUMB_PACK_URL as string | undefined;
let pack: Promise<ThumbnailPack> | undefined;
const generations = new WeakMap<HTMLImageElement, number>();

function address(url: string): { subset: string; id: number } | null {
  if (!manifestUrl) return null;
  const match = new URL(url, location.href).pathname.match(/^\/thumbs\/bl\/(covers|medium|embellishments|plates)\/(\d{8})\.webp$/);
  return match ? { subset: match[1], id: Number(match[2]) } : null;
}

/** Permanent URLs stay in saves; display bytes come directly from CDN ranges. */
export async function fetchThumbnailBlob(url: string, signal?: AbortSignal): Promise<Blob> {
  signal?.throwIfAborted();
  const item = address(url);
  if (!item) {
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(`Thumbnail HTTP ${response.status}`);
    return response.blob();
  }
  pack ??= fetchJson<ThumbnailPack>(manifestUrl!).catch(error => { pack = undefined; throw error; });
  const manifest = await pack;
  if (manifest.version !== 1 || !Number.isInteger(manifest.shard_rows) || manifest.shard_rows <= 0) throw new Error("Invalid thumbnail pack");
  const subset = manifest.subsets[item.subset];
  if (!subset || !Number.isSafeInteger(subset.count) || subset.count <= 0 || item.id >= subset.count ||
    !Array.isArray(subset.sizes) || subset.sizes.length !== Math.ceil(subset.count / manifest.shard_rows)) throw new Error("Thumbnail outside pack");
  const base = new URL(`${item.subset}/`, manifestUrl).href;
  const record = await new PagedRecords(`${base}offsets.bin`, subset.count, 8).record(item.id);
  signal?.throwIfAborted();
  const shard = Math.floor(item.id / manifest.shard_rows);
  const size = subset.sizes[shard], length = record.getUint32(4, true);
  if (!Number.isSafeInteger(size) || size <= 0 || length < 1 || length > 1024 * 1024) throw new Error("Invalid thumbnail extent");
  const buffer = await rangeReader.read(`${base}${String(shard).padStart(5, "0")}.blob`,
    record.getUint32(0, true), length, size);
  signal?.throwIfAborted();
  return new Blob([buffer], { type: "image/webp" });
}

/** Revoke object URLs after decoding; reject stale completions on recycled UI. */
export function setThumbnailSource(img: HTMLImageElement, url: string, valid = () => true): void {
  const generation = (generations.get(img) ?? 0) + 1;
  generations.set(img, generation);
  if (!address(url)) { img.src = url; return; }
  void fetchThumbnailBlob(url).then(blob => {
    if (!valid() || generations.get(img) !== generation || !img.isConnected) return;
    const objectUrl = URL.createObjectURL(blob);
    const release = () => {
      URL.revokeObjectURL(objectUrl);
      img.removeEventListener("load", release); img.removeEventListener("error", release);
      clearTimeout(timer);
    };
    const timer = setTimeout(release, 30000);
    img.addEventListener("load", release, { once: true }); img.addEventListener("error", release, { once: true });
    img.src = objectUrl;
  }).catch(() => {
    if (valid() && generations.get(img) === generation && img.isConnected) img.src = url;
  });
}
