/**
 * Report printing → PDF.
 *
 * ─── WHY THERE IS NO PDF LIBRARY HERE ────────────────────────────────────────
 * The obvious move is jsPDF + html2canvas, and it is the wrong one for this app:
 *
 *   • CLAUDE.md §2 — no new dependency without strong justification. jsPDF plus
 *     autotable plus html2canvas is roughly 300 KB against a 200 KB total JS
 *     budget (§12). One button would blow the budget for every page.
 *   • html2canvas renders the report to a BITMAP. The CA cannot select an amount,
 *     search for an invoice number, or copy a column out. A P&L nobody can copy
 *     from is a screenshot with a .pdf extension.
 *   • Page breaks land wherever the pixels fall, so a table splits mid-row and a
 *     total ends up orphaned on its own page.
 *
 * `window.print()` uses the browser's own engine: real vector text, selectable
 * and searchable, `break-inside: avoid` respected, and "Save as PDF" built into
 * the print dialog on every desktop OS. It costs zero bytes.
 *
 * The one honest trade-off: it opens the system print dialog rather than
 * downloading silently, so it is two clicks, not one. That is the price of not
 * shipping a rasteriser, and it buys a document the accountant can actually use.
 */

import { logExport } from "@/lib/export-log";

/**
 * Print the current report.
 *
 * `documentTitle` matters more than it looks: browsers use `document.title` as
 * the default PDF filename, so without this the CA saves twelve files all called
 * "ResellerOS". The previous title is restored afterwards so the tab (and the
 * workspace tab strip, which reads it) does not stay renamed.
 *
 * R-1006: the print is the report's PDF export, so it is recorded in export_log
 * (`rowCount` = rows on the report, when the caller knows it).
 */
export function printReport(documentTitle?: string, rowCount = 0): void {
  if (typeof window === "undefined") return;
  void logExport({ what: documentTitle || "report", rowCount, format: "pdf" });

  const previous = document.title;
  if (documentTitle) document.title = documentTitle;

  // Restore on the way back. `afterprint` covers both "printed" and "cancelled";
  // the timeout is a backstop for browsers that fire it unreliably, because a
  // permanently renamed tab is a worse bug than a redundant restore.
  const restore = () => {
    document.title = previous;
    window.removeEventListener("afterprint", restore);
  };
  window.addEventListener("afterprint", restore);
  window.setTimeout(restore, 60_000);

  window.print();
}

/**
 * Filename stem for an export: `saas-metrics-2026-08-13`.
 * Kept here so the CSV and the PDF of the same report agree on their name.
 */
export function reportFilename(slug: string, on: Date = new Date()): string {
  const iso = on.toISOString().slice(0, 10);
  return `${slug}-${iso}`;
}
