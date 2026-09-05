import type { Manifest } from "../streaming/Manifest.ts";
import type { StackDescriptor } from "./Inventory.ts";

export interface SavedStack extends StackDescriptor {
  rowIds: number[];
  cursor: number;
  returned: number[];
  firstExtractedAt: number;
  lastExtractedAt: number;
}
export interface MiningSave { version: 1; dataset: string; pack: string; stacks: SavedStack[] }

/** Validate the whole document before mutating anything. Pinning the immutable
 * pack prevents applying a 160-grid save to 512, or a rebuilt projection. */
export function validateMiningSave(value: unknown, dataset: string, manifest: Manifest): MiningSave {
  const save = value as MiningSave;
  if (!save || save.version !== 1 || save.dataset !== dataset || save.pack !== manifest.baseUrl || !Array.isArray(save.stacks))
    throw new Error("This save belongs to a different dataset or map revision.");
  const ids = new Set<string>(), rows = new Set<number>();
  const integer = (n: number, max: number) => Number.isSafeInteger(n) && n >= 0 && n <= max;
  for (const s of save.stacks) {
    if (!s || !manifest.chunksById.has(s.chunkId) || !integer(s.localVoxelId, manifest.voxelsPerChunk ** 3 - 1) ||
      s.id !== `${s.chunkId}:${s.localVoxelId}` || ids.has(s.id) || !integer(s.totalPoints, manifest.totalPoints) ||
      !integer(s.reprRowId, manifest.totalPoints - 1) || !integer(s.cursor, s.totalPoints) ||
      !Array.isArray(s.rowIds) || !s.rowIds.length || !Array.isArray(s.returned) ||
      s.rowIds.length + s.returned.length !== s.cursor ||
      !integer(s.firstExtractedAt, Number.MAX_SAFE_INTEGER) || !integer(s.lastExtractedAt, Number.MAX_SAFE_INTEGER) ||
      s.lastExtractedAt < s.firstExtractedAt) throw new Error("Invalid or duplicate block in save.");
    ids.add(s.id);
    for (const list of [s.rowIds, s.returned]) for (const row of list) {
      if (!integer(row, manifest.totalPoints - 1) || rows.has(row)) throw new Error("Invalid or duplicate image row in save.");
      rows.add(row);
    }
  }
  return save;
}

const COLUMNS = ["version", "dataset", "pack", "chunk_id", "voxel_id", "row_id", "thumbnail_url", "total_points", "repr_row_id", "cursor", "returned_row_ids", "first_extracted_at", "last_extracted_at"];
const quote = (v: string | number) => `"${String(v).replaceAll('"', '""')}"`;

/** One mined image per row. Block state appears on its first row only; the
 * return queue preserves exact re-mining order without downloading postings. */
export async function miningSaveCsv(save: MiningSave, url: (row: number) => Promise<string>): Promise<string> {
  const lines = [COLUMNS.join(",")];
  for (const s of save.stacks) for (let start = 0; start < s.rowIds.length; start += 32) {
    const batch = s.rowIds.slice(start, start + 32);
    const urls = await Promise.all(batch.map(url));
    batch.forEach((row, i) => {
      const first = start + i === 0;
      lines.push([1, save.dataset, save.pack, s.chunkId, s.localVoxelId, row, urls[i],
        ...(first ? [s.totalPoints, s.reprRowId, s.cursor, s.returned.join(";"), s.firstExtractedAt, s.lastExtractedAt] : Array(6).fill(""))].map(quote).join(","));
    });
  }
  return lines.join("\r\n") + "\r\n";
}

/** RFC4180 fields, including quoted commas/newlines and escaped quotes. */
export function parseCsv(text: string): string[][] {
  text = text.replace(/^\uFEFF/, "");
  const records: string[][] = []; let record: string[] = [], field = "", quoted = false, closed = false;
  const cell = () => { record.push(field); field = ""; closed = false; };
  const row = () => { cell(); if (record.some(s => s !== "")) records.push(record); record = []; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i+1] === '"') { field += '"'; i++; } else { quoted = false; closed = true; } }
      else field += c;
    } else if (c === ",") cell();
    else if (c === "\r" || c === "\n") { row(); if (c === "\r" && text[i+1] === "\n") i++; }
    else if (c === '"' && !field && !closed) quoted = true;
    else { if (closed || c === '"') throw new Error("Malformed CSV quoting."); field += c; }
  }
  if (quoted) throw new Error("Unclosed CSV quote.");
  if (field || record.length || closed) row();
  return records;
}

export function miningSaveFromCsv(text: string): MiningSave {
  const records = parseCsv(text);
  if (records.shift()?.join(",") !== COLUMNS.join(",")) throw new Error("Not a Latent Scope inventory CSV.");
  if (!records.length) throw new Error("The CSV contains no mined images.");
  const save: MiningSave = { version: 1, dataset: records[0][1], pack: records[0][2], stacks: [] };
  const stacks = new Map<string, SavedStack>();
  const number = (s: string) => { if (!/^\d+$/.test(s)) throw new Error("Invalid integer in CSV."); return Number(s); };
  for (const r of records) {
    if (r.length !== COLUMNS.length || r[0] !== "1" || r[1] !== save.dataset || r[2] !== save.pack) throw new Error("Mixed datasets or malformed CSV row.");
    const chunkId = number(r[3]), localVoxelId = number(r[4]), id = `${chunkId}:${localVoxelId}`;
    let s = stacks.get(id);
    if (!s) {
      s = { id, chunkId, localVoxelId, rowIds: [], totalPoints: number(r[7]), reprRowId: number(r[8]), cursor: number(r[9]),
        returned: r[10] ? r[10].split(";").map(number) : [], firstExtractedAt: number(r[11]), lastExtractedAt: number(r[12]) };
      stacks.set(id, s); save.stacks.push(s);
    } else if (r.slice(7).some(Boolean)) throw new Error("Repeated block metadata in CSV.");
    // URLs are a portable reference, never an import-time fetch instruction.
    s.rowIds.push(number(r[5]));
  }
  return save;
}
