import type { SearchResult } from "./CompareClient.ts";

export interface CollectionProfile {
  dataset: string; release: string; rows: number; chunks: number;
  endpoint: string; model: string; backendLabel: string; placeholder: string;
  thumbnailPattern: RegExp; identity?: string;
}

export const BL_COLLECTION: CollectionProfile = {
  dataset: "bl-160", release: "bl-20260907a", rows: 1080814, chunks: 1000,
  endpoint: "/api/bl", model: "SigLIP 2", backendLabel: "FAISS SQ8",
  placeholder: "a sailing ship, a botanical illustration…",
  thumbnailPattern: /^\/thumbs\/bl\/(covers|medium|embellishments|plates)\/\d{8}\.webp$/,
};

export const MONET_CLIP_COLLECTION: CollectionProfile = {
  dataset: "monet-clip-basemap-full-4m-512", release: "monet-clip-basemap-full-4m-20260906a",
  rows: 103816750, chunks: 32768, endpoint: "/api/monet", model: "CLIP ViT-B/32",
  backendLabel: "Disk FAISS · IVF-PQ", placeholder: "a red sports car, a misty forest…",
  thumbnailPattern: /^\/thumbs\/monet\/\d{1,10}\.webp$/,
  identity: "ca437bba419cc933455eefbf2af0b797657addce8b2d886db574e7f8f94d6c5f",
};

export function parseCollectionResults(value: unknown, profile: CollectionProfile): SearchResult[] {
  const body = value as { dataset?: string; release?: string; identity?: string; results?: SearchResult[] };
  if (body?.dataset !== profile.dataset || body.release !== profile.release ||
    (profile.identity && body.identity !== profile.identity) || !Array.isArray(body.results) || body.results.length > 24)
    throw new Error("Search response belongs to a different map");
  const seen = new Set<number>();
  for (const r of body.results) {
    if (!r || ![r.row, r.chunk, r.local, r.thumb].every(Number.isSafeInteger) || r.row < 0 || r.row >= profile.rows ||
      r.chunk < 0 || r.chunk >= profile.chunks || r.local < 0 || r.local >= 4096 || r.thumb < 0 || r.thumb > 0xffffffff ||
      !Number.isFinite(r.score) || typeof r.thumbUrl !== "string" || !profile.thumbnailPattern.test(r.thumbUrl) || seen.has(r.row))
      throw new Error("Invalid collection search result");
    seen.add(r.row);
    const id = Number(r.thumbUrl.match(/\/(\d+)\.webp$/)![1]);
    if (id !== r.thumb) throw new Error("Thumbnail identity mismatch");
  }
  return body.results;
}
