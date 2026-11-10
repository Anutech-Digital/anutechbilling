/**
 * Open a PDF in the BROWSER — with its password when it has one — and read its text, page by
 * page (R-2662, 10 Nov 2026).
 *
 * Why: Indian bank and credit-card e-statements are almost always password-protected, and the
 * import dialog used to stop at "This PDF is password-protected, so it can't be read". The AI
 * reader on the server cannot open a locked file — and the password must never travel there.
 * So the file is opened here with pdfjs-dist (the same set-up as the document viewer), and only
 * the TEXT of its pages goes on to the AI reader.
 *
 * Password rules: it is handed to pdfjs only (which decrypts in its web worker, inside this
 * browser tab); it is never put in a request, a log line, an error, Sentry or storage, and this
 * module keeps no copy. The caller clears its input as soon as the call returns.
 */

export type PdfTextResult =
  | { ok: true; pages: string[] }
  /** need-password: locked and no password given · wrong-password: the given one did not open it ·
      no-text: it opened but has no text layer (a scanned statement) · unreadable: anything else. */
  | { ok: false; reason: "need-password" | "wrong-password" | "no-text" | "unreadable" };

type TextItem = { str?: string; transform?: number[]; width?: number };
type PdfDoc = {
  numPages: number;
  getPage(n: number): Promise<{ getTextContent(): Promise<{ items: unknown[] }> }>;
};
type LoadingTask = { promise: Promise<PdfDoc>; destroy(): Promise<void> | void };
export type PdfjsLike = {
  getDocument(args: { data: Uint8Array; password?: string; isEvalSupported?: boolean }): LoadingTask;
};

/** pdfjs in the browser — its worker from /public, the same set-up as the document viewer. */
export async function browserPdfjs(): Promise<PdfjsLike> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
  return pdfjs as unknown as PdfjsLike;
}

/** Points per character for the "layout" text: ~4.5 pt keeps 8–10 pt statement columns apart. */
const PT_PER_CHAR = 4.5;

/**
 * The lines of one page as they read on paper: items on the same baseline, left to right, top
 * line first.
 * - "layout" (bank statements): each item starts at the column its x-position gives
 *   (x / PT_PER_CHAR), so an EMPTY column stays an empty gap — an amount stays under the
 *   "Withdrawal" or the "Deposit" heading it was printed under (review: a plain join lost which
 *   column a lone amount sat in).
 * - "plain" (the Google bill check's parser): items joined with one space, e.g.
 *   "accesstel.in C04e9zwp8 529.20".
 */
export function pageLines(items: unknown[], mode: "layout" | "plain" = "layout"): string[] {
  const rows = new Map<number, { x: number; s: string }[]>();
  for (const it of items as TextItem[]) {
    // pdfjs adds whitespace-only items across gaps — positions carry the gap instead.
    if (!it || typeof it.str !== "string" || !it.str.trim() || !Array.isArray(it.transform)) continue;
    const y = Math.round(it.transform[5]);
    rows.set(y, [...(rows.get(y) ?? []), { x: it.transform[4], s: it.str.trim() }]);
  }
  const out: string[] = [];
  for (const y of [...rows.keys()].sort((a, b) => b - a)) {
    const cells = rows.get(y)!.sort((a, b) => a.x - b.x);
    let line = "";
    for (const c of cells) {
      if (mode === "plain") { line += (line ? " " : "") + c.s; continue; }
      const col = Math.max(0, Math.round(c.x / PT_PER_CHAR));
      line += line ? " ".repeat(Math.max(1, col - line.length)) : " ".repeat(col);
      line += c.s;
    }
    const clean = mode === "plain" ? line.replace(/\s+/g, " ").trim() : line.replace(/\s+$/, "");
    if (clean.trim()) out.push(clean);
  }
  if (mode === "layout") {
    // Drop the common left margin so the lines start at column 0.
    const margin = Math.min(...out.map((l) => l.length - l.trimStart().length));
    return Number.isFinite(margin) && margin > 0 ? out.map((l) => l.slice(margin)) : out;
  }
  return out;
}

/**
 * Open `bytes` (with `password`, "" = none) and return each page's text. `bytes` is not
 * consumed (pdfjs gets a copy). Never throws. The pdfjs loading task (and its worker, which holds
 * a copy of the file) is destroyed on every path, a failed password too.
 */
export async function pdfTextPages(
  bytes: Uint8Array,
  password = "",
  opts: { mode?: "layout" | "plain"; pdfjs?: () => Promise<PdfjsLike> } = {},
): Promise<PdfTextResult> {
  let task: LoadingTask | null = null;
  try {
    const pdfjs = await (opts.pdfjs ?? browserPdfjs)();
    task = pdfjs.getDocument({ data: bytes.slice(), password, isEvalSupported: false });
    let doc: PdfDoc;
    try {
      doc = await task.promise;
    } catch (e) {
      // pdfjs: PasswordException code 1 = needs one, 2 = incorrect. Its message never holds the password.
      if ((e as { name?: string })?.name === "PasswordException") {
        return { ok: false, reason: password === "" ? "need-password" : "wrong-password" };
      }
      return { ok: false, reason: "unreadable" };
    }
    const pages: string[] = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const tc = await (await doc.getPage(p)).getTextContent();
      pages.push(pageLines(tc.items, opts.mode).join("\n"));
    }
    if (!pages.some((t) => t.trim())) return { ok: false, reason: "no-text" };
    return { ok: true, pages };
  } catch {
    return { ok: false, reason: "unreadable" };
  } finally {
    if (task) void Promise.resolve().then(() => task!.destroy()).catch(() => {});
  }
}

/**
 * The statement text the AI reader gets for an unlocked PDF — pages `from`..`to` (1-based, all
 * when no range), each under a "=== Page N ===" line, as base64 of UTF-8 (the route's
 * `fileBase64`, mimeType text/plain). A chunk also carries the page BEFORE and AFTER its range
 * (review): the route's prompt says to read only `from`..`to`, but a row that runs onto the
 * next page needs that page's top to be complete, and the first row's money direction is checked
 * against the previous page's last balance — the PDF path always had the whole file for this.
 */
export function statementTextBase64(pages: string[], range?: { from: number; to: number }): string {
  const from = range ? Math.max(1, range.from - 1) : 1;
  const to = range ? Math.min(pages.length, range.to + 1) : pages.length;
  const text = pages
    .slice(from - 1, to)
    .map((t, i) => `=== Page ${from + i} ===\n${t}`)
    .join("\n\n");
  const utf8 = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < utf8.length; i += 0x8000) bin += String.fromCharCode(...utf8.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Plain words for each failure — what the person sees under the password box. */
export function unlockMessage(reason: Exclude<PdfTextResult, { ok: true }>["reason"], what: "statement" | "document" = "statement"): string {
  if (what === "document") {
    switch (reason) {
      case "need-password": return "This PDF is locked with a password. Type it below to open it here in your browser.";
      case "wrong-password": return "That password did not open the PDF. Check it and try again.";
      case "no-text": return "The PDF opened, but it has no text to read (it looks like a scanned copy). Paste the text instead.";
      default: return "This PDF could not be opened. Paste the text instead.";
    }
  }
  switch (reason) {
    case "need-password": return "This PDF is locked with a password. Type it below to open it here in your browser.";
    case "wrong-password": return "That password did not open the PDF. Check it and try again — the bank's statement email usually says how the password is made.";
    case "no-text": return "The PDF opened, but it has no text to read (it looks like a scanned copy). Download the statement as CSV / Excel from net banking instead.";
    default: return "This PDF could not be opened. Download the statement as CSV / Excel from net banking instead.";
  }
}
