/**
 * Is this PDF password-protected?
 *
 * Bank e-statements (HDFC's among them) are usually encrypted with the customer's
 * password. The AI reader cannot open them — Gemini answers a bare 400 "invalid
 * argument" — and the operator used to see only "Couldn't read this statement".
 * An encrypted PDF declares it in its trailer with an /Encrypt entry, so the file can
 * be checked in the browser before it is sent anywhere, and the message can say what
 * to do instead.
 */
export function isEncryptedPdf(bytes: Uint8Array): boolean {
  // Latin-1 keeps every byte as one char, so a binary PDF decodes without loss.
  const text = new TextDecoder("latin1").decode(bytes);
  return /\/Encrypt\s*\d+\s+\d+\s+R|\/Encrypt\s*<</.test(text);
}

/**
 * How many pages this PDF has — BROWSER only (pdfjs worker from /public, the same set-up as
 * the document viewer). R-1690: a long statement is read a few pages per AI call, and this
 * is how the dialog knows how many calls to make. `null` when pdfjs cannot open the file;
 * the caller then sends the whole file in one call, as before.
 */
export async function pdfPageCount(bytes: Uint8Array): Promise<number | null> {
  try {
    const pdfjs = await import("pdfjs-dist");
    pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
    // pdfjs takes ownership of the buffer it is given — hand it a copy.
    const pdf = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
    const n = pdf.numPages;
    void pdf.destroy();
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}
