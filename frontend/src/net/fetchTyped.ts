/**
 * Thin typed wrappers around `fetch`. The chunk server is a plain static file
 * server with `Access-Control-Allow-Origin: *`, so no proxy or credentials are
 * involved — the only thing worth centralizing is turning a non-2xx into a
 * useful error and threading `AbortSignal` through consistently, since
 * streaming cancels in-flight chunk fetches when the camera moves away.
 */

export class HttpError extends Error {
  constructor(
    readonly url: string,
    readonly status: number,
    readonly statusText: string,
  ) {
    super(`${status} ${statusText} — ${url}`);
    this.name = "HttpError";
  }
}

async function request(url: string, signal?: AbortSignal): Promise<Response> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new HttpError(url, response.status, response.statusText);
  return response;
}

export async function fetchJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await request(url, signal);
  return (await response.json()) as T;
}

export async function fetchArrayBuffer(url: string, signal?: AbortSignal): Promise<ArrayBuffer> {
  const response = await request(url, signal);
  return await response.arrayBuffer();
}

/** True for the `AbortError` a cancelled fetch rejects with — callers treat
 * these as "no longer wanted", not as failures worth surfacing. */
export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
