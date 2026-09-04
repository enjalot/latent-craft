import { resolvePointMetaUrl } from "../config.ts";

/**
 * One row of a points table's `point_meta.bin`, as served by the data
 * server's `GET /meta/<points_id>/<row_id>` route: where the ORIGINAL image
 * behind a thumbnail lives, and how big it is.
 *
 * `url` is `null` when no original exists anywhere reachable — BL's `covers`
 * subset (and a few plates), and MONET's ~250K synthetic rows. `width` /
 * `height` are populated EVEN THEN (the synthetic rows report the generator's
 * 1024x1024, a BL cover its scan size), so a caller must never infer "has an
 * original" from `width > 0`; `url !== null` is the only test.
 */
export interface PointMeta {
  rowId: number;
  /** Original-image URL, already upgraded to https (see `upgradeToHttps`),
   * or `null` when there is no original to fetch. */
  url: string | null;
  width: number;
  height: number;
}

/** The wire shape, before validation. */
interface PointMetaJson {
  row_id: number;
  url: string | null;
  width: number;
  height: number;
}

/**
 * What a `/meta` lookup can come back with. Three answers, and the
 * distinction between the last two is the whole point:
 *
 *   `PointMeta`   the row's record (200)
 *   `null`        the server's own final "no such row / no such table" (404)
 *   `undefined`   NOT KNOWN — the lookup itself failed: the fetch threw
 *                 (server down, connection dropped) or the answer was some
 *                 other non-2xx (the Vite proxy's 500/504 while the data
 *                 server restarts, a 5xx from the server). The row may well
 *                 have an original; we simply could not ask.
 *
 * `undefined` is the same value `peekPointMeta` returns for a row nobody has
 * asked about yet, and it means the same thing: nothing is on record for
 * this row, so ask again.
 */
export type PointMetaLookup = PointMeta | null | undefined;

/**
 * `/meta` lookups, cached per `(points_id, row_id)` for the life of the page
 * and de-duplicated while in flight, so paging back and forth through a
 * lightbox stack never re-asks the server about a row it already knows, and
 * two callers asking about the same row at once share one request.
 *
 * Only DEFINITIVE answers are cached — a record, or the 404 that says there
 * is none. A lookup that fails for any other reason resolves `undefined` and
 * leaves nothing behind, so the next visit to the row retries: a transient
 * hiccup (the data server restarting under the Vite proxy) must not label a
 * row "no original" until the page is reloaded. Retrying costs nothing
 * extra — every un-cached row already costs one request per visit, and a
 * failed request is answered at least as fast as a good one.
 *
 * Nothing here ever throws — the lightbox calls this on a keypress — so a
 * thrown fetch collapses to `undefined` like any other failed lookup, and a
 * 200 whose body is not the shape above is a definitive `null` plus one
 * `console.warn`: that is the server's answer, however malformed, and
 * retrying would only warn again.
 */
const cache = new Map<string, PointMeta | null>();
const inFlight = new Map<string, Promise<PointMetaLookup>>();

export async function fetchPointMeta(pointsId: string, rowId: number): Promise<PointMetaLookup> {
  const key = `${pointsId}:${rowId}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const pending = inFlight.get(key);
  if (pending) return pending;

  const request = fetchPointMetaUncached(pointsId, rowId)
    .catch(() => undefined)
    .then((meta) => {
      if (meta !== undefined) cache.set(key, meta);
      inFlight.delete(key);
      return meta;
    });
  inFlight.set(key, request);
  return request;
}

/** The cached answer for a row, if it has already been fetched — for callers
 * that need to decide something synchronously (the lightbox's status line on
 * a keypress) without waiting a round-trip they already paid for. `undefined`
 * when the row has never been looked up, or its last lookup failed. */
export function peekPointMeta(pointsId: string, rowId: number): PointMetaLookup {
  return cache.get(`${pointsId}:${rowId}`);
}

async function fetchPointMetaUncached(pointsId: string, rowId: number): Promise<PointMetaLookup> {
  const response = await fetch(resolvePointMetaUrl(pointsId, rowId));
  // 404 is the server's "no such row / no such table" — silent, final. Any
  // other failure status is the proxy or the server being unwell, not an
  // answer about the row.
  if (response.status === 404) return null;
  if (!response.ok) return undefined;
  const raw = (await response.json()) as Partial<PointMetaJson>;
  if (
    typeof raw.row_id !== "number" ||
    (raw.url !== null && typeof raw.url !== "string") ||
    typeof raw.width !== "number" ||
    typeof raw.height !== "number"
  ) {
    console.warn(`[PointMeta] unexpected /meta payload for ${pointsId}/${rowId}`, raw);
    return null;
  }
  return {
    rowId: raw.row_id,
    url: raw.url ? upgradeToHttps(raw.url) : null,
    width: raw.width,
    height: raw.height,
  };
}

/**
 * `http://` → `https://`. BL's Flickr originals are stored with the scheme
 * Flickr used when the dataset was crawled (`http://farmN.staticflickr.com/
 * …_o.jpg`); every one of them redirects to https today, and loading an
 * `http:` image into a page that may itself be served over https would trip
 * the browser's mixed-content warning before the redirect ever happened. The
 * MONET crawl URLs are already https and pass through untouched.
 */
export function upgradeToHttps(url: string): string {
  return url.replace(/^http:\/\//i, "https://");
}

/** Hostname of an original's URL for the lightbox status line (`farm8.
 * staticflickr.com`), or the raw string if it doesn't parse as a URL. */
export function originHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
