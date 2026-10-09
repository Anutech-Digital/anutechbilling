/**
 * R-525 (9 Oct 2026) — a browser PDF render must END, one way or the other.
 *
 * The quote "Download PDF" button spun forever in the production build: the CSP refused
 * the renderer's blob: worker and @react-pdf's toBlob() never resolved or rejected. The
 * CSP is fixed (worker-src), but the next thing that hangs the renderer would bring the
 * same symptom back. So every client render goes through `withPdfTimeout`: it rejects with
 * a `PdfGenerationError` carrying operator copy after PDF_TIMEOUT_MS, and also wraps any
 * other render error in the same copy — the raw renderer text ("Failed to construct
 * 'Worker'…") is kept on `cause` for the console, never shown.
 */

export const PDF_TIMEOUT_MS = 20_000;
export const PDF_FAILED_MESSAGE = "Could not make the PDF — try again";
export const PDF_FAILED_DESCRIPTION =
  "If it keeps failing, reload the page once, then report it from AI Help.";

export class PdfGenerationError extends Error {
  readonly timedOut: boolean;
  constructor(opts: { timedOut: boolean; cause?: unknown }) {
    super(PDF_FAILED_MESSAGE, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "PdfGenerationError";
    this.timedOut = opts.timedOut;
  }
}

/** Any failure on the way to a PDF (chunk load, logo fetch, render) → the one operator
 *  message. Callers pass the result to toastError with PDF_FAILED_DESCRIPTION. */
export function asPdfError(err: unknown): PdfGenerationError {
  return err instanceof PdfGenerationError ? err : new PdfGenerationError({ timedOut: false, cause: err });
}

/** Race a PDF render against a timer. Resolves with the render's value; on timeout or
 *  on any render error rejects with PdfGenerationError (operator-safe message). */
export function withPdfTimeout<T>(work: Promise<T>, ms: number = PDF_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new PdfGenerationError({ timedOut: true }));
    }, ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        console.error("PDF render failed:", err);
        reject(err instanceof PdfGenerationError ? err : new PdfGenerationError({ timedOut: false, cause: err }));
      },
    );
  });
}
