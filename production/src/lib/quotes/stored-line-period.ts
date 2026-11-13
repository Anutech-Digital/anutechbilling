/**
 * R-2744 — the service period an invoice line STORED when the invoice was issued.
 *
 * Before this card an invoice stored no period: the PDF, the invoice screen and the emailed PDF
 * worked it out from the backing quote + the live subscription every time they were drawn
 * (lineServicePeriod, R-1764 / R-2727), so editing the quote or the subscription later re-printed a
 * different period on an issued GST invoice. Now the BEFORE INSERT trigger of migration
 * 20261113210500 writes `service_period` on every line of an invoice made from a quote —
 * {from, to, months} (YYYY-MM-DD, both ends inclusive; months null for a dated add-seats window),
 * or an explicit JSON null for a line with no period — using its SQL copy of the same rule
 * (public.invoice_line_service_period; the parity test keeps the two equal). The value is frozen
 * with the lines (tg_invoices_freeze_issued: line_items is once-set).
 *
 * The key PRESENT on every line = the invoice was stamped; absent = issued before R-2744, and the
 * old computed path prints it exactly as before. Nothing here backfills an old invoice (a data
 * repair is the owner's call — scripts/ops/r2744-invoice-line-period-backfill-report.sql only lists
 * what one would store).
 */
import type { LinePeriod, LinePeriodContext } from "@/lib/quotes/service-period";

export const STORED_PERIOD_KEY = "service_period";

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

function realDate(v: unknown): v is string {
  if (typeof v !== "string" || !ISO_RE.test(v)) return false;
  const [y, m, d] = v.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** One line's stored period: undefined = not stored (old invoice), null = stored "no period" (or a
 *  malformed value — printing nothing beats printing a wrong date), else the stored dates. */
export function storedLinePeriod(line: unknown): LinePeriod | null | undefined {
  if (!line || typeof line !== "object" || !(STORED_PERIOD_KEY in line)) return undefined;
  const p = (line as Record<string, unknown>)[STORED_PERIOD_KEY];
  if (!p || typeof p !== "object") return null;
  const { from, to, months } = p as { from?: unknown; to?: unknown; months?: unknown };
  if (!realDate(from) || !realDate(to) || to < from) return null;
  if (months === null || months === undefined) return { from, to, months: null };
  if (typeof months !== "number" || !Number.isInteger(months) || months <= 0) return null;
  return { from, to, months };
}

/** The stored period of every line, in order — null when the invoice was not stamped (any line
 *  without the key, no lines). */
export function invoiceStoredLinePeriods(invoice: { line_items?: unknown } | null | undefined): Array<LinePeriod | null> | null {
  const lines = invoice?.line_items;
  if (!Array.isArray(lines) || lines.length === 0) return null;
  const out: Array<LinePeriod | null> = [];
  for (const l of lines) {
    const p = storedLinePeriod(l);
    if (p === undefined) return null;
    out.push(p);
  }
  return out;
}

/**
 * The lines an invoice surface prints, each carrying the period the invoice stored for it, and the
 * context marked `storedPeriods` so lineServicePeriod reads the stored value instead of working it
 * out again. The printed lines are usually the quote's (build-props / invoice screen, R-375); the
 * invoice's own lines were copied from them at issue, so they match by position. When the invoice
 * was not stamped, the counts differ (the quote changed shape after issue), or there is no context
 * (nothing is printed anyway) → the same lines and context objects come back: the old path, unchanged.
 */
export function withStoredLinePeriods<L extends object>(
  printed: L[],
  invoice: { line_items?: unknown } | null | undefined,
  ctx: LinePeriodContext | null,
): { lines: L[]; ctx: LinePeriodContext | null } {
  if (!ctx) return { lines: printed, ctx };
  const stored = invoiceStoredLinePeriods(invoice);
  if (!stored || stored.length !== printed.length) return { lines: printed, ctx };
  return {
    lines: printed.map((l, i) => ({ ...l, [STORED_PERIOD_KEY]: stored[i] })),
    ctx: { ...ctx, storedPeriods: true },
  };
}
