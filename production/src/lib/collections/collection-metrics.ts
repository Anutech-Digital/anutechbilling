/**
 * R-2414 — collection health numbers in the owner's "This week" panel on /collections:
 * DSO, best possible DSO, average days late, CEI and promise-kept %.
 *
 * Pure: owner-report.tsx reads the rows, this does the maths (fixtures in collection-metrics.test.ts
 * are worked out by hand).
 *
 * PERIOD — the last 30 days, today included (IST). A single week has too few invoices for a
 * steady DSO (one big invoice swings it by weeks); 30 days is the usual small-business window
 * (web research §3: "measure CEI monthly for a small team").
 *
 * WHERE EACH INPUT COMES FROM — nothing new is invented:
 *   • Closing AR = the /collections lines (lib/queries/collections.ts — invoiceAmountDue, the same
 *     balance as Customer Aging, plus un-invoiced subscription balances). "Current" (not yet due)
 *     = lines whose daysOverdue is 0 or less; the rest is overdue.
 *   • Credit sales = invoices issued in the period (status pending / paid / overdue — no draft,
 *     no cancelled), dated by invoice_date, valued at net_payable (else amount) — the same gross
 *     invoiceAmountDue starts from.
 *   • Received = cash received in the period (promiseReceipts: status received, credit_applied
 *     left out, whole rupees, IST day).
 *   • Opening AR is not stored for a past day, so it is derived: Opening = Closing + Received −
 *     Sales (never below 0). Credit notes and write-offs in the period are then counted as if
 *     collected — a small over-statement of CEI, said in the tooltip.
 *
 * FORMULAS (web-research.md §3):
 *   DSO          = Closing AR ÷ Sales × days
 *   Best DSO     = Current AR ÷ Sales × days
 *   Avg days late = DSO − Best DSO   (average days delinquent)
 *   CEI          = (Opening + Sales − Closing) ÷ (Opening + Sales − Current) × 100
 *   Promise kept = promises kept ÷ promises whose date fell in the period (today's promises are
 *                  left out — not decided yet). Kept / broken = promiseStatus, the rule the list
 *                  and the weekly report use.
 * No sales in the period → DSO / Best DSO / Avg days late show "—" with that reason.
 */
import { addDaysISO, toIstDate } from "@/lib/dates/ist";
import { promiseReceipts, promiseStatus, type PromisePayment } from "./followup-rules";

export const METRICS_DAYS = 30;

export const ISSUED_STATUSES = ["pending", "paid", "overdue"] as const;

export interface MetricsLine {
  /** Balance still owed (whole rupees after rounding). */
  amountDue: number;
  /** 0 or less = not yet due. */
  daysOverdue: number;
}

export interface MetricsInvoice {
  invoice_date: string | null;
  status: string;
  net_payable: number | null;
  amount: number | null;
}

export interface MetricsFollowup {
  id: string;
  customer_id: string;
  promised_on: string | null;
  promised_amount: number | null;
  created_at: string;
}

export interface MetricsInput {
  today: string;
  lines: readonly MetricsLine[];
  invoices: readonly MetricsInvoice[];
  payments: readonly PromisePayment[];
  followups: readonly MetricsFollowup[];
  /** Customers who still owe now (a promise of someone who owes nothing counts as kept). */
  owesNow: ReadonlySet<string>;
}

/** A number, or null with the reason it cannot be worked out. */
export type Metric = { value: number; reason?: undefined } | { value: null; reason: string };

export interface CollectionMetrics {
  periodStart: string;
  today: string;
  days: number;
  closingAr: number;
  currentAr: number;
  overdueAr: number;
  sales: number;
  received: number;
  openingAr: number;
  dso: Metric;
  bestDso: Metric;
  avgDaysLate: Metric;
  cei: Metric;
  promiseKept: Metric & { kept: number; due: number };
}

const whole = (n: number | null | undefined) => (typeof n === "number" && Number.isFinite(n) ? Math.round(n) : 0);

/** First day of the metrics window (today − 29 for 30 days). */
export function metricsStart(today: string, days = METRICS_DAYS): string {
  return addDaysISO(today, -(days - 1));
}

/**
 * Earliest payment date the promise-kept % needs: the window start, or the day the oldest
 * promise due in the window was logged (money paid after logging can keep it).
 */
export function metricsPaymentsFrom(followups: readonly Pick<MetricsFollowup, "promised_on" | "created_at">[], today: string, days = METRICS_DAYS): string {
  const start = metricsStart(today, days);
  let from = start;
  for (const f of followups) {
    const on = f.promised_on?.slice(0, 10);
    if (!on || on < start || on >= today) continue;
    const logged = toIstDate(f.created_at);
    if (logged < from) from = logged;
  }
  return from;
}

export function buildCollectionMetrics(input: MetricsInput, days = METRICS_DAYS): CollectionMetrics {
  const { today } = input;
  const periodStart = metricsStart(today, days);
  const inPeriod = (d: string) => d >= periodStart && d <= today;

  let closingAr = 0, currentAr = 0;
  for (const l of input.lines) {
    const due = whole(l.amountDue);
    if (due <= 0) continue;
    closingAr += due;
    if (l.daysOverdue <= 0) currentAr += due;
  }
  const overdueAr = closingAr - currentAr;

  const sales = input.invoices
    .filter((i) => (ISSUED_STATUSES as readonly string[]).includes(i.status) && !!i.invoice_date && inPeriod(i.invoice_date.slice(0, 10)))
    .reduce((s, i) => s + whole(i.net_payable ?? i.amount), 0);

  const receipts = promiseReceipts(input.payments);
  const received = receipts.filter((r) => inPeriod(r.on)).reduce((s, r) => s + r.amount, 0);

  const openingAr = Math.max(0, closingAr + received - sales);

  const noSales = "No invoices issued in the last 30 days";
  const dso: Metric = sales > 0 ? { value: Math.round((closingAr / sales) * days) } : { value: null, reason: noSales };
  const bestDso: Metric = sales > 0 ? { value: Math.round((currentAr / sales) * days) } : { value: null, reason: noSales };
  // From the unrounded parts, so DSO − Best DSO on screen can differ from this by a day at most.
  const avgDaysLate: Metric = sales > 0 ? { value: Math.round((overdueAr / sales) * days) } : { value: null, reason: noSales };

  const ceiDen = openingAr + sales - currentAr;
  const cei: Metric = ceiDen > 0
    ? { value: Math.round(((openingAr + sales - closingAr) / ceiDen) * 100) }
    : { value: null, reason: "Nothing was owed or billed in the last 30 days" };

  // ── Promise kept % — one promise per customer + date, decided (date before today) ──
  const firstLogged = new Map<string, { customerId: string; on: string; amount: number | null; newestAt: string; newestId: string; logged: string }>();
  for (const f of input.followups) {
    const on = f.promised_on?.slice(0, 10);
    if (!on || on < periodStart || on >= today) continue;
    const key = `${f.customer_id}|${on}`;
    const logged = toIstDate(f.created_at);
    const had = firstLogged.get(key);
    if (!had) {
      firstLogged.set(key, { customerId: f.customer_id, on, amount: f.promised_amount, newestAt: f.created_at, newestId: f.id, logged });
      continue;
    }
    if (logged < had.logged) had.logged = logged;
    // The newest entry's amount counts (same as the weekly report).
    if (f.created_at > had.newestAt || (f.created_at === had.newestAt && f.id > had.newestId)) {
      had.amount = f.promised_amount; had.newestAt = f.created_at; had.newestId = f.id;
    }
  }
  let kept = 0, due = 0;
  for (const p of firstLogged.values()) {
    const { status } = promiseStatus({
      promisedOn: p.on,
      promisedAmount: p.amount,
      loggedOn: p.logged,
      today,
      receipts: receipts.filter((r) => r.customerId === p.customerId),
      stillOwes: input.owesNow.has(p.customerId),
    });
    due += 1;
    if (status === "kept") kept += 1;
  }
  const promiseKept = due > 0
    ? { value: Math.round((kept / due) * 100), kept, due }
    : { value: null, reason: "No promise fell due in the last 30 days", kept, due };

  return { periodStart, today, days, closingAr, currentAr, overdueAr, sales, received, openingAr, dso, bestDso, avgDaysLate, cei, promiseKept };
}

/** One-line formula tooltips (English UI). */
export const METRIC_FORMULA = {
  dso: "DSO = amount owed now ÷ invoices issued in the last 30 days × 30",
  bestDso: "Best possible DSO = amount owed that is not due yet ÷ invoices issued in the last 30 days × 30",
  avgDaysLate: "Average days late = DSO − best possible DSO (the overdue part of what is owed, in days of sales)",
  cei: "CEI = (owed 30 days ago + invoiced − owed now) ÷ (owed 30 days ago + invoiced − owed now not yet due) × 100; owed 30 days ago = owed now + received − invoiced (credit notes count as collected)",
  promiseKept: "Promise kept = promises paid in full by their date ÷ promises whose date fell in the last 30 days (today's not counted)",
} as const;
