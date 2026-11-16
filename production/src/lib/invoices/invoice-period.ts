/**
 * R-2853 (Pardeep, 16 Nov 2026: "agar invoice subscription ka hai to uske neeche subscription period
 * bhi show ho") — the one line under an invoice number on /invoices (table + phone cards), the
 * customer page's Transactions tab and the invoice page header:
 *   one subscription      "Google Workspace Business Starter · 1 Oct 2026 – 30 Sep 2027"
 *   a part bill           "Part 2 of 12 · 1–31 Oct 2026"
 *   several subscriptions "2 subscriptions · 1 Oct 2026 – 14 Nov 2027" (Bill together)
 *
 * Only STORED periods, never a recomputed term (the R-2737 rule):
 *   1. a part's invoice — subscription_billings.invoice_id (R-2101): the part's own period
 *      (period_end exclusive, as schedule.ts keeps it) and "Part n of N" (quote-kind.ts partShortText);
 *   2. else the period each invoice line stored at issue — line_items[].service_period
 *      (R-2744; a together renewal quote's lines each their own subscription's, R-2848) read with
 *      stored-line-period.ts. An invoice issued before R-2744 stored none → no line (as before).
 * A one-time / non-subscription invoice → null: nothing changes for it. Words only, no money rule.
 */
import { invoiceStoredLinePeriods } from "@/lib/quotes/stored-line-period";
import { periodDate, type LinePeriod } from "@/lib/quotes/service-period";
import { partShortText, partsInTerm } from "@/lib/quotes/quote-kind";
import { periodLastDay } from "@/lib/billing/schedule";

/** A billed part (subscription_billings) with its subscription's cycle + term — one read per list. */
export interface InvoicePartRow {
  invoice_id: string | null;
  subscription_id: string;
  period_index: number;
  /** YYYY-MM-DD */
  period_start: string;
  /** YYYY-MM-DD, exclusive (schedule.ts). */
  period_end: string;
  billing_cycle?: string | null;
  term_months?: number | null;
}

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "1 Oct 2026 – 30 Sep 2027", "1–31 Oct 2026", "1 Oct – 31 Dec 2026", "5 Oct 2026" (both ends inclusive). */
export function rangeWords(from: string, to: string): string {
  if (from === to) return periodDate(from);
  const [fy, fm] = [from.slice(0, 4), from.slice(5, 7)];
  const [ty, tm] = [to.slice(0, 4), to.slice(5, 7)];
  if (fy !== ty) return `${periodDate(from)} – ${periodDate(to)}`;
  const fd = Number(from.slice(8, 10));
  if (fm === tm) return `${fd}–${periodDate(to)}`;
  return `${fd} ${MON[Number(fm) - 1]} – ${periodDate(to)}`;
}

/** The invoices' billed parts, by invoice id (rows with no invoice dropped). */
export function partRowsByInvoice(rows: readonly InvoicePartRow[] | null | undefined): Map<string, InvoicePartRow[]> {
  const out = new Map<string, InvoicePartRow[]>();
  for (const r of rows ?? []) {
    if (!r.invoice_id) continue;
    const list = out.get(r.invoice_id);
    if (list) list.push(r);
    else out.set(r.invoice_id, [r]);
  }
  return out;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

function span(ranges: ReadonlyArray<{ from: string; to: string }>): string {
  const from = ranges.reduce((a, r) => (r.from < a ? r.from : a), ranges[0].from);
  const to = ranges.reduce((a, r) => (r.to > a ? r.to : a), ranges[0].to);
  return rangeWords(from, to);
}

function partsLine(parts: readonly InvoicePartRow[]): string | null {
  const ok = parts.filter((p) => ISO.test(p.period_start?.slice(0, 10) ?? "") && ISO.test(p.period_end?.slice(0, 10) ?? ""));
  if (ok.length === 0) return null;
  const ranges = ok.map((p) => ({ from: p.period_start.slice(0, 10), to: periodLastDay(p.period_end) }));
  const subs = new Set(ok.map((p) => p.subscription_id));
  if (subs.size > 1) return `${subs.size} subscriptions · ${span(ranges)}`;
  const p = ok[0];
  if (ok.length === 1) {
    const short = partShortText({
      periodIndex: p.period_index, periodStart: p.period_start, periodEnd: p.period_end, termStart: p.period_start,
      subStartDate: null, firstTermStart: null, subQuoteId: null,
      billingCycle: p.billing_cycle ?? null, termMonths: p.term_months ?? null,
    });
    return short ? `${short} · ${span(ranges)}` : span(ranges);
  }
  const idx = ok.map((r) => r.period_index).filter((n) => Number.isInteger(n) && n > 0);
  if (idx.length !== ok.length) return span(ranges);
  const n = partsInTerm(p.billing_cycle ?? null, p.term_months ?? null);
  const lo = Math.min(...idx), hi = Math.max(...idx);
  return `Parts ${lo}–${hi}${n != null && hi <= n ? ` of ${n}` : ""} · ${span(ranges)}`;
}

/** The plan a line names, without an add-seats window "(pro-rata from … to …)". */
function planOf(line: unknown): string {
  const name = line && typeof line === "object" ? (line as { name?: unknown }).name : null;
  return typeof name === "string" ? name.replace(/\s*\([^)]*\)\s*$/, "").trim() : "";
}

/** Which subscription a line is: its subscription_id (together quotes), else domain + plan. */
function subKeyOf(line: unknown): string {
  const l = (line && typeof line === "object" ? line : {}) as { subscription_id?: unknown; domain?: unknown };
  if (typeof l.subscription_id === "string" && l.subscription_id) return `id:${l.subscription_id}`;
  const domain = typeof l.domain === "string" ? l.domain.trim().toLowerCase() : "";
  return `pd:${domain}|${planOf(line).toLowerCase()}`;
}

/** The line under the invoice number, or null (not a subscription invoice / no stored period). */
export function invoicePeriodLine(
  invoice: { line_items?: unknown } | null | undefined,
  parts?: readonly InvoicePartRow[] | null,
): string | null {
  if (parts && parts.length > 0) {
    const line = partsLine(parts);
    if (line) return line;
  }
  const periods = invoiceStoredLinePeriods(invoice);
  if (!periods) return null;
  const lines = invoice!.line_items as unknown[];
  const withPeriod: Array<{ line: unknown; p: LinePeriod }> = [];
  periods.forEach((p, i) => { if (p) withPeriod.push({ line: lines[i], p }); });
  if (withPeriod.length === 0) return null;
  const ranges = withPeriod.map((x) => ({ from: x.p.from, to: x.p.to }));
  const keys = new Set(withPeriod.map((x) => subKeyOf(x.line)));
  if (keys.size > 1) return `${keys.size} subscriptions · ${span(ranges)}`;
  const plan = planOf(withPeriod[0].line);
  return plan ? `${plan} · ${span(ranges)}` : span(ranges);
}
