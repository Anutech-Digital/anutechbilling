/**
 * R-2405 — the tiles at the top of Renewals, each one a button that filters the queue.
 *
 * Audit (Anutech-HQ/drafts/RENEWALS-AUDIT/page-audit.md): the old Insights line read
 * "Urgent MRR ₹5.8L · Upcoming 30d MRR ₹7.0K · At risk ARR ₹69.2L" — monthly and yearly money
 * mixed, and none of it led to a list. Now six tiles, all in the SAME money the table shows (the
 * row's renewal amount: the open renewal quote's total, else the term amount — queue.ts
 * renewalAmount), and a click shows exactly the rows a tile adds up:
 *
 *   Overdue            the Overdue tab's rows
 *   Due in 30 days     due today .. +30 days (the ≤7 days + 8–30 tabs)
 *   Due in 31–60 days  the 31–60 tab        ┐ windows, not "within 60/90": the three Due tiles
 *   Due in 61–90 days  the 61–90 tab        ┘ never count a renewal twice and add up
 *     — the Due tiles leave out a renewal already paid (status Renewed) and one the customer
 *       said they won't renew: that money is in, or not coming.
 *   Won't renew        rows marked Won't renew, still running (the money that is leaving)
 *   Renewed this month renewals whose renewal date is in this IST month and are paid, as ₹ and
 *                      as % of all renewals due this month (paid + still due). Its click shows
 *                      what is still due this month — the rows to work to lift that %.
 *
 * Paid renewals mostly leave the queue (record_payment moves renewal_date on), so "renewed" comes
 * from the renewal quotes themselves (quotes.is_renewal, renewal_term_date = the renewal date it
 * renewed — R-1574) that are fully paid. Pure — tested in tiles-r2405.test.ts.
 */
import type { QueueTab, RowStatusKey } from "./queue";

export const TILE_KEYS = ["overdue", "due30", "due60", "due90", "wontRenew", "renewedMonth"] as const;
export type TileKey = (typeof TILE_KEYS)[number];

export const TILE_LABEL: Record<TileKey, string> = {
  overdue: "Overdue",
  due30: "Due in 30 days",
  due60: "Due in 31–60 days",
  due90: "Due in 61–90 days",
  wontRenew: "Won't renew",
  renewedMonth: "Renewed this month",
};

/** What the table shows when a tile is pressed (the Renewed tile shows the work still left). */
export const TILE_VIEW_LABEL: Record<TileKey, string> = {
  ...TILE_LABEL,
  renewedMonth: "Still due this month",
};

/** One queue row, as the tiles need it. */
export interface TileRow {
  id: string;
  tab: QueueTab;
  statusKey: RowStatusKey;
  /** The row's renewal amount in whole rupees (queue.ts renewalAmount().value). */
  amount: number;
  renewalDate: string | null;
}

/** A renewal quote, as loaded for the Renewed tile. */
export interface RenewalQuotePayment {
  id: string;
  amount: number | null;
  payment_amount: number | null;
  payment_status: string | null;
  status?: string | null;
  renewal_subscription_id: string | null;
  renewal_term_date: string | null;
}

export interface MonthRange {
  /** YYYY-MM-01 */
  start: string;
  /** last day, YYYY-MM-DD */
  end: string;
  /** "Nov" */
  label: string;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The calendar month of an IST date (YYYY-MM-DD). */
export function monthOf(todayIst: string): MonthRange {
  const y = Number(todayIst.slice(0, 4));
  const m = Number(todayIst.slice(5, 7));
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const mm = String(m).padStart(2, "0");
  return { start: `${y}-${mm}-01`, end: `${y}-${mm}-${String(last).padStart(2, "0")}`, label: MONTHS[m - 1] };
}

const inMonth = (d: string | null | undefined, month: MonthRange) => !!d && d >= month.start && d <= month.end;

/**
 * A renewal quote whose money is fully in: received (or received and then invoiced — the invoice
 * keeps payment_amount) for at least the quote total. A partial payment is not a renewal.
 */
export function isFullyPaidRenewal(q: RenewalQuotePayment): boolean {
  if (q.status === "rejected" || q.status === "cancelled" || q.status === "void") return false;
  if (q.payment_status !== "received" && q.payment_status !== "invoiced") return false;
  const total = Math.round(q.amount ?? 0);
  return total > 0 && Math.round(q.payment_amount ?? 0) >= total;
}

const NOT_DUE: ReadonlySet<RowStatusKey> = new Set(["renewed", "non-renewing"]);

/**
 * Is this row one the tile adds up (and the table shows when the tile is pressed)?
 * `paidSubs` = subscriptions with a fully paid renewal quote this month (Renewed tile only).
 */
export function tileMatches(key: TileKey, r: TileRow, month: MonthRange, paidSubs: ReadonlySet<string> = new Set()): boolean {
  switch (key) {
    case "overdue":   return r.tab === "overdue";
    case "due30":     return (r.tab === "due7" || r.tab === "d30") && !NOT_DUE.has(r.statusKey);
    case "due60":     return r.tab === "d60" && !NOT_DUE.has(r.statusKey);
    case "due90":     return r.tab === "d90" && !NOT_DUE.has(r.statusKey);
    case "wontRenew": return r.statusKey === "non-renewing";
    case "renewedMonth":
      return inMonth(r.renewalDate, month) && !NOT_DUE.has(r.statusKey) && !paidSubs.has(r.id);
  }
}

export interface TileFigure {
  count: number;
  /** Whole rupees. */
  amount: number;
}

export interface RenewedFigure extends TileFigure {
  /** Paid + still due this month, whole rupees. */
  dueAmount: number;
  /** Renewed ₹ ÷ due ₹, whole percent; null when nothing was due this month. */
  pct: number | null;
  /** What the tile's click shows: renewals of this month not paid yet. */
  stillDue: TileFigure;
}

export type RenewalTiles = Record<Exclude<TileKey, "renewedMonth">, TileFigure> & { renewedMonth: RenewedFigure };

/** Subscriptions with a fully paid renewal quote for a renewal date in this month. */
export function paidRenewalsInMonth(quotes: readonly RenewalQuotePayment[], month: MonthRange): RenewalQuotePayment[] {
  const seen = new Set<string>();
  return quotes.filter((q) => {
    if (seen.has(q.id) || !inMonth(q.renewal_term_date, month) || !isFullyPaidRenewal(q)) return false;
    seen.add(q.id);
    return true;
  });
}

export function renewalTiles(rows: readonly TileRow[], quotes: readonly RenewalQuotePayment[], month: MonthRange): RenewalTiles {
  const paid = paidRenewalsInMonth(quotes, month);
  const paidSubs = new Set(paid.map((q) => q.renewal_subscription_id).filter((x): x is string => !!x));
  const sum = (key: TileKey): TileFigure => {
    let count = 0, amount = 0;
    for (const r of rows) if (tileMatches(key, r, month, paidSubs)) { count += 1; amount += Math.round(r.amount); }
    return { count, amount };
  };
  /* a row already Renewed (paid, its date not moved yet) with no paid quote loaded counts as renewed too */
  const renewedRows = rows.filter((r) => r.statusKey === "renewed" && inMonth(r.renewalDate, month) && !paidSubs.has(r.id));
  const renewedCount = paid.length + renewedRows.length;
  const renewedAmount = paid.reduce((s, q) => s + Math.round(q.amount ?? 0), 0)
    + renewedRows.reduce((s, r) => s + Math.round(r.amount), 0);
  const stillDue = sum("renewedMonth");
  const dueAmount = renewedAmount + stillDue.amount;
  return {
    overdue: sum("overdue"),
    due30: sum("due30"),
    due60: sum("due60"),
    due90: sum("due90"),
    wontRenew: sum("wontRenew"),
    renewedMonth: {
      count: renewedCount,
      amount: renewedAmount,
      dueAmount,
      pct: dueAmount > 0 ? Math.round((renewedAmount / dueAmount) * 100) : null,
      stillDue,
    },
  };
}
