import { PagedRecords, rangeReader } from "./RangeReader.ts";
import { fetchJson } from "../net/fetchTyped.ts";

interface ThumbnailPack { version: number; shard_rows: number;
  subsets: Record<string, { count: number; sizes: number[] }> }
const manifestUrl = import.meta.env.VITE_THUMB_PACK_URL as string | undefined;
const monetManifestUrl = import.meta.env.VITE_MONET_THUMB_PACK_URL as string | undefined;
interface MonetThumbnailPack { version: 1; encoding: "monet-u64-offsets"; shards: [number, number][] }
let pack: Promise<ThumbnailPack> | undefined;
let monetPack: Promise<MonetThumbnailPack> | undefined;
const generations = new WeakMap<HTMLImageElement, number>();

function address(url: string): { subset: string; id: number } | null {
  if (!manifestUrl) return null;
  const match = new URL(url, location.href).pathname.match(/^\/thumbs\/bl\/(covers|medium|embellishments|plates)\/(\d{8})\.webp$/);
  return match ? { subset: match[1], id: Number(match[2]) } : null;
}

function monetAddress(url: string): number | null {
  if (!monetManifestUrl) return null;
  const match = new URL(url, location.href).pathname.match(/^\/thumbs\/monet\/(\d+)\.webp$/);
  const ref = match ? Number(match[1]) : -1;
  return Number.isSafeInteger(ref) && ref >= 0 && ref < 2 ** 32 ? ref : null;
}

async function fetchMonetThumbnail(ref: number, signal?: AbortSignal): Promise<Blob> {
  monetPack ??= fetchJson<MonetThumbnailPack>(monetManifestUrl!).catch(error => { monetPack = undefined; throw error; });
  const manifest = await monetPack;
  signal?.throwIfAborted();
  const shard = ref >>> 16, row = ref & 65535;
  if (manifest.version !== 1 || manifest.encoding !== "monet-u64-offsets" || !Array.isArray(manifest.shards)) throw Error("Invalid MONET thumbnail pack");
  const entry = manifest.shards[shard];
  if (!entry || !entry.every(Number.isSafeInteger) || entry[0] < 1 || entry[0] > 65536 || entry[1] < 1 || row >= entry[0]) throw Error("Thumbnail outside MONET pack");
  const [rows, bytes] = entry;
  const base = new URL(`shards/${String(shard).padStart(4, "0")}`, new URL(monetManifestUrl!, location.href)).href;
  // Exact 16B extent pair, not an arbitrary 32KiB offset page: nearby voxels'
  // images can come from unrelated source shards. Two cold CDN ranges, no API.
  const offsets = new DataView(await rangeReader.read(`${base}.offsets.u64`, row * 8, 16, (rows + 1) * 8));
  signal?.throwIfAborted();
  const start = Number(offsets.getBigUint64(0, true)), end = Number(offsets.getBigUint64(8, true));
  if (![start, end].every(Number.isSafeInteger) || start < 0 || end <= start || end > bytes || end - start > 1024 * 1024) throw Error("Missing or invalid MONET thumbnail span");
  const buffer = await rangeReader.read(`${base}.blob`, start, end - start, bytes);
  signal?.throwIfAborted();
  return new Blob([buffer], { type: "image/webp" });
}

/** Permanent URLs stay in saves; display bytes come directly from CDN ranges. */
export async function fetchThumbnailBlob(url: string, signal?: AbortSignal): Promise<Blob> {
  signal?.throwIfAborted();
  const monet = monetAddress(url);
  if (monet !== null) return fetchMonetThumbnail(monet, signal);
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
  const base = new URL(`${item.subset}/`, new URL(manifestUrl!, location.href)).href;
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
  if (!address(url) && monetAddress(url) === null) { img.src = url; return; }
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
