/**
 * Deals — the money view of the pipeline, as pure functions (30 Sep 2026).
 *
 * A "deal" is a lead that has reached a money stage: quote, demo, trial, won or lost — the
 * same split /deals uses (lib/leads/stage-meta.ts). Three screens read these numbers:
 *   • the dashboard's Deals strip  → summarizeDealStrip
 *   • /today's deal rows           → lib/today/deals.ts (dealTodayItems)
 *   • the Reports hub Deals card   → dealReport
 *
 * ─── DATES ──────────────────────────────────────────────────────────────────
 *   value       = leads.value (whole rupees)
 *   close date  = leads.expected_close_date (a calendar date, no timezone)
 *   won date    = leads.stage_changed_at while stage = 'won' (an instant → read in IST)
 *   lost date   = leads.lost_at, else stage_changed_at while stage = 'lost'
 * "This month" and "today" are the IST calendar (lib/dates/ist.ts), never the browser's.
 *
 * ─── WON ₹ NEEDS MONEY (R-375) ────────────────────────────────────────────────
 * accept_quote sets stage 'won' on ACCEPTANCE, before any payment, so a won deal's value is
 * only won REVENUE when `paid` is true (lib/payments/won-paid.ts: a part/fully-paid quote or a
 * project receipt). Won COUNTS (and win rate) stay by stage — winning is a decision, and the
 * /deals?view=won-mtd list counts the same rows (R-118) — but every won ₹ figure sums paid
 * deals only. Accepted-but-unpaid value is reported separately as awaiting payment.
 *
 * Junk is the caller's to filter (the query does it), as in lib/leads/forecast.ts.
 */
import type { Lead } from "@/lib/supabase/database.types";
import { isOpenStage, weightedValue, winRate } from "@/lib/leads/forecast";
import { istMonth, istToday, monthBounds, toIstDate, daysBetweenISO, addDaysISO } from "@/lib/dates/ist";

/** Stages that make a lead a deal. Order = how far through the funnel. */
export const DEAL_STAGES = ["demo", "trial", "quote", "won", "lost"] as const satisfies readonly Lead["stage"][];
/** Deal stages still in play. */
export const OPEN_DEAL_STAGES = ["demo", "trial", "quote"] as const satisfies readonly Lead["stage"][];

export type DealRow = Pick<
  Lead,
  "id" | "company" | "stage" | "value" | "expected_close_date" | "stage_changed_at" | "created_at" | "owner_id" | "lost_at"
> & {
  /**
   * R-375: a payment is recorded against this deal (lib/payments/won-paid.ts). Filled by
   * useDealRows for won rows. Absent / false = no money yet — its value is NOT won revenue.
   */
  paid?: boolean;
};

/** Won value only when money exists (R-375); 0 for an accepted-but-unpaid deal. */
export function wonRevenue(d: Pick<DealRow, "value" | "paid">): number {
  return d.paid === true ? (d.value ?? 0) : 0;
}

const isDealStage = (s: Lead["stage"] | null | undefined): boolean =>
  !!s && (DEAL_STAGES as readonly string[]).includes(s);

/** An open deal: a deal stage that is not won or lost. */
export function isOpenDeal(d: Pick<DealRow, "stage">): boolean {
  return isDealStage(d.stage) && isOpenStage(d.stage);
}

/**
 * IST calendar date the deal was won, or null (not won / no timestamp).
 * Falls back to created_at like wonThisMonth() in lib/leads/list-selectors.ts, so the
 * dashboard tile and the /deals?view=won-mtd list it links to count the same deals (R-118).
 */
export function wonDate(d: Pick<DealRow, "stage" | "stage_changed_at"> & { created_at?: string | null }): string | null {
  if (d.stage !== "won") return null;
  const at = d.stage_changed_at ?? d.created_at ?? null;
  return at ? toIstDate(at) : null;
}

/** IST calendar date the deal was lost, or null. */
export function lostDate(d: Pick<DealRow, "stage" | "stage_changed_at" | "lost_at">): string | null {
  if (d.stage !== "lost") return null;
  const at = d.lost_at ?? d.stage_changed_at;
  return at ? toIstDate(at) : null;
}

// ─── Dashboard strip ─────────────────────────────────────────────────────────

export interface CountValue { count: number; value: number }

export interface DealStrip {
  /** Open deals (demo / trial / quote) at full value. */
  pipeline: CountValue;
  /** Sum of each open deal's weighted value (forecast.ts probabilities). */
  weighted: number;
  /**
   * Open deals expected to close by the end of the current IST month — overdue close dates
   * included, as the /deals "closing" view counts them (R-118: tile and list must agree; a
   * deal whose close date has passed but is still open is exactly one to chase).
   */
  closingThisMonth: CountValue;
  /**
   * Deals won (stage_changed_at) in the current IST month. `count` = every won deal (matches the
   * won-mtd list); `value` = only those with a recorded payment (R-375).
   */
  wonThisMonth: CountValue;
  /** Won this month but no payment recorded yet — accepted, not revenue (R-375). */
  wonAwaitingPayment: CountValue;
}

export function summarizeDealStrip(rows: readonly DealRow[], now: Date = new Date()): DealStrip {
  const { start, end } = monthBounds(istMonth(now));
  const inMonth = (iso: string | null) => !!iso && iso >= start && iso <= end;
  const out: DealStrip = {
    pipeline: { count: 0, value: 0 },
    weighted: 0,
    closingThisMonth: { count: 0, value: 0 },
    wonThisMonth: { count: 0, value: 0 },
    wonAwaitingPayment: { count: 0, value: 0 },
  };
  for (const d of rows) {
    const v = d.value ?? 0;
    if (isOpenDeal(d)) {
      out.pipeline.count++;
      out.pipeline.value += v;
      out.weighted += weightedValue(d);
      const close = d.expected_close_date?.slice(0, 10) ?? null;
      if (close && close <= end) {
        out.closingThisMonth.count++;
        out.closingThisMonth.value += v;
      }
    } else if (inMonth(wonDate(d))) {
      out.wonThisMonth.count++;
      out.wonThisMonth.value += wonRevenue(d);
      if (d.paid !== true) {
        out.wonAwaitingPayment.count++;
        out.wonAwaitingPayment.value += v;
      }
    }
  }
  return out;
}

// ─── Reports hub ─────────────────────────────────────────────────────────────

export const REPORT_WINDOW_DAYS = 90;

export interface OwnerDealRow {
  /** users.id, or null for deals nobody owns. */
  ownerId: string | null;
  won: number;
  /** R-375: paid won deals only. */
  wonValue: number;
  lost: number;
  /** won ÷ (won + lost), integer percent; null when nothing was decided. */
  winRatePct: number | null;
}

export interface DealReport {
  windowDays: number;
  /** First IST date inside the window (inclusive). */
  since: string;
  won: number;
  lost: number;
  /** R-375: value of won deals WITH a recorded payment — accepted-but-unpaid is not revenue. */
  wonValue: number;
  /** Won deals in the window with a recorded payment. */
  paidWon: number;
  /** Value of won deals in the window still awaiting any payment. */
  awaitingPaymentValue: number;
  /** won ÷ (won + lost) in the window, integer percent; null when nothing was decided. */
  winRatePct: number | null;
  /** Mean value of PAID won deals in the window, whole rupees; null when none were paid. */
  avgWonValue: number | null;
  /** Mean IST days from created_at to the won date, one decimal; null when none. */
  avgDaysToClose: number | null;
  /** Sorted by won ₹ desc, then won count desc, then lost asc. */
  byOwner: OwnerDealRow[];
}

/**
 * Win rate, average won deal and time-to-close over deals DECIDED in the last `windowDays`
 * IST days (today counts as one of them). A deal is placed in the window by its decision
 * date — won date or lost date — not by when it was created.
 */
export function dealReport(
  rows: readonly DealRow[],
  now: Date = new Date(),
  windowDays: number = REPORT_WINDOW_DAYS,
): DealReport {
  const today = istToday(now);
  const since = addDaysISO(today, -(windowDays - 1));
  const inWindow = (iso: string | null) => !!iso && iso >= since && iso <= today;

  const won: DealRow[] = [];
  const decided: DealRow[] = [];
  for (const d of rows) {
    if (inWindow(wonDate(d))) { won.push(d); decided.push(d); }
    else if (inWindow(lostDate(d))) decided.push(d);
  }

  const wr = winRate(decided);
  const wonValue = won.reduce((s, d) => s + wonRevenue(d), 0);
  const paidWon = won.filter((d) => d.paid === true).length;
  const awaitingPaymentValue = won.reduce((s, d) => s + (d.paid === true ? 0 : (d.value ?? 0)), 0);

  let daySum = 0;
  for (const d of won) daySum += Math.max(0, daysBetweenISO(toIstDate(d.created_at), wonDate(d)!));

  const owners = new Map<string | null, OwnerDealRow>();
  for (const d of decided) {
    const key = d.owner_id ?? null;
    const o = owners.get(key) ?? { ownerId: key, won: 0, wonValue: 0, lost: 0, winRatePct: null };
    if (d.stage === "won") { o.won++; o.wonValue += wonRevenue(d); } else o.lost++;
    owners.set(key, o);
  }
  const byOwner = [...owners.values()]
    .map((o) => ({ ...o, winRatePct: Math.round((o.won * 100) / (o.won + o.lost)) }))
    .sort((a, b) => b.wonValue - a.wonValue || b.won - a.won || a.lost - b.lost);

  return {
    windowDays,
    since,
    won: wr.won,
    lost: wr.lost,
    wonValue,
    paidWon,
    awaitingPaymentValue,
    winRatePct: wr.pct,
    avgWonValue: paidWon > 0 ? Math.round(wonValue / paidWon) : null,
    avgDaysToClose: won.length > 0 ? Math.round((daySum / won.length) * 10) / 10 : null,
    byOwner,
  };
}
