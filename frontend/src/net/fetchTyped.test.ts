import { describe, expect, it } from "vitest";
import { HttpError, isAbortError, isRetryableRequestError } from "./fetchTyped.ts";

describe("request error classification", () => {
  it("retries transient fetch and HTTP failures", () => {
    expect(isRetryableRequestError(new TypeError("Failed to fetch"))).toBe(true);
    expect(isRetryableRequestError(new HttpError("/chunk", 503, "Unavailable"))).toBe(true);

    const threeError = Object.assign(
      new Error('fetch for "/atlas.ktx2" responded with 503: Service Unavailable'),
      { response: { status: 503 } },
    );
    expect(isRetryableRequestError(threeError)).toBe(true);
  });

  it("does not retry definitive or malformed resources", () => {
    expect(isRetryableRequestError(new HttpError("/chunk", 404, "Not Found"))).toBe(false);
    expect(
      isRetryableRequestError(
        new Error('fetch for "/atlas.ktx2" responded with 404: Not Found'),
      ),
    ).toBe(false);
    expect(isRetryableRequestError(new Error("invalid chunk metadata"))).toBe(false);
  });

  it("recognizes standard and wrapped abort errors", () => {
    expect(isAbortError(new DOMException("aborted", "AbortError"))).toBe(true);
    const wrapped = new Error("aborted");
    wrapped.name = "AbortError";
    expect(isAbortError(wrapped)).toBe(true);
  });
});
