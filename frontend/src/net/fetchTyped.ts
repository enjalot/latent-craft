/**
 * Thin typed wrappers around `fetch`. The chunk server is a plain static file
 * server. Production may fetch it directly with CORS; development normally
 * reaches it through Vite's same-origin proxy. The useful common behavior is
 * turning a non-2xx into a typed error and threading `AbortSignal` through
 * consistently, since streaming cancels in-flight work when it is obsolete.
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
  // Name-based detection also covers DOMExceptions created in another realm
  // (an iframe/worker) and libraries that preserve the standard name while
  // wrapping the original fetch exception in an Error.
  return (
    (error instanceof DOMException || error instanceof Error) && error.name === "AbortError"
  );
}

/** Whether retrying a failed resource request can plausibly succeed without
 * changing the pack. Parse/validation errors and definitive 4xx responses do
 * not qualify. Some Three.js loaders reject with a non-Error event, which is
 * treated as transport-level and retried under the caller's bounded policy. */
export function isRetryableRequestError(error: unknown): boolean {
  if (isAbortError(error)) return false;
  if (error instanceof HttpError) {
    return error.status === 408 || error.status === 425 || error.status === 429 || error.status >= 500;
  }
  if (error instanceof TypeError) return true; // fetch network failure
  if (!(error instanceof Error)) return true;
  // Three.js FileLoader uses a private HttpError whose public `response`
  // property is the only structured status available to us.
  const responseStatus = (error as Error & { response?: { status?: unknown } }).response?.status;
  const messageStatus = error.message.match(
    /\b(?:responded with|HTTP(?: status)?)\s*[: ]\s*(\d{3})\b/i,
  )?.[1];
  const status = typeof responseStatus === "number" ? responseStatus : Number(messageStatus);
  if (Number.isFinite(status)) {
    const code = status;
    return code === 408 || code === 425 || code === 429 || code >= 500;
  }
  return false;
}
