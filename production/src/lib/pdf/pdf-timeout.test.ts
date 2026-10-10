/**
 * R-525 — a hung or failed browser PDF render must stop the spinner with operator copy.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  withPdfTimeout,
  asPdfError,
  PdfGenerationError,
  PDF_FAILED_MESSAGE,
  PDF_TIMEOUT_MS,
} from "./pdf-timeout";
import { describeError } from "@/lib/errors/toast-error";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("withPdfTimeout (R-525)", () => {
  it("passes the render's value through when it finishes in time", async () => {
    await expect(withPdfTimeout(Promise.resolve("blob"), 1000)).resolves.toBe("blob");
  });

  it("the default limit is 20 s", () => {
    expect(PDF_TIMEOUT_MS).toBe(20_000);
  });

  it("rejects with the operator message when the render never settles (the R-525 hang)", async () => {
    vi.useFakeTimers();
    const never = new Promise<Blob>(() => {});
    const p = withPdfTimeout(never);
    const assertion = expect(p).rejects.toMatchObject({
      name: "PdfGenerationError",
      message: PDF_FAILED_MESSAGE,
      timedOut: true,
    });
    await vi.advanceTimersByTimeAsync(PDF_TIMEOUT_MS);
    await assertion;
  });

  it("does not reject before the limit", async () => {
    vi.useFakeTimers();
    let settled = false;
    withPdfTimeout(new Promise(() => {})).catch(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(PDF_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
  });

  it("wraps a render error in the same copy and keeps the raw error as cause", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const raw = new Error("Failed to construct 'Worker': blob: violates script-src");
    const err = await withPdfTimeout(Promise.reject(raw), 1000).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PdfGenerationError);
    expect((err as PdfGenerationError).message).toBe(PDF_FAILED_MESSAGE);
    expect((err as PdfGenerationError).timedOut).toBe(false);
    expect((err as Error & { cause?: unknown }).cause).toBe(raw);
  });

  it("asPdfError maps anything thrown to the operator copy, and keeps a PdfGenerationError as is", () => {
    const timed = new PdfGenerationError({ timedOut: true });
    expect(asPdfError(timed)).toBe(timed);
    const wrapped = asPdfError(new Error("ChunkLoadError: Loading chunk 123 failed"));
    expect(wrapped.message).toBe(PDF_FAILED_MESSAGE);
    expect(wrapped.timedOut).toBe(false);
  });

  it("toastError shows the message unchanged (not rewritten to 'Network problem')", () => {
    const d = describeError(new PdfGenerationError({ timedOut: true }));
    expect(d.message).toBe(PDF_FAILED_MESSAGE);
    expect(d.translated).toBe(false);
  });
});
