/**
 * R-1518 — the owner's week on /collections (owner / manager / accountant only).
 *
 * Pure: the page reads the rows (each read paged past 1000) and this does the maths, so the
 * tests check the numbers on fixtures.
 *
 * WHAT EACH NUMBER MEANS
 *   • Week = Monday to today, IST calendar.
 *   • Received: payments with status "received", dated (IST) inside the week, from customers
 *     on the follow-up list — anyone who owes now, or anyone who has a follow-up logged
 *     (a customer who paid in full this week has left the list but still counts).
 *   • Promises made: follow-ups logged this week that carry a promise date.
 *   • Promises due this week (promise date Monday … today), one per customer + date (a promise
 *     logged twice is one promise; the newest entry's amount counts). R-1540: kept / broken
 *     come from promiseStatus (followup-rules.ts) — the very rule /collections and the
 *     follow-up history use, so the report and the list never disagree:
 *       kept   — the customer paid at least the promised amount in cash (any amount when none
 *                was given) between the day the promise was logged and the promise date, or
 *                owes nothing any more;
 *       broken — not kept and the date has passed (before today);
 *       today  — due today and not paid yet: neither kept nor broken.
 *   • Follow-ups per person: entries logged this week, by who logged them (created_by).
 *   • Gone quiet: customers who owe now and have had no follow-up for 7+ days (or never).
 */
import { addDaysISO, daysBetweenISO, toIstDate } from "@/lib/dates/ist";
import { promiseReceipts, promiseStatus, type PromisePayment } from "./followup-rules";

export const QUIET_DAYS = 7;

export const REPORT_ROLES = ["owner", "manager", "accountant"] as const;
export function maySeeCollectionsReport(role: string | null | undefined): boolean {
  return !!role && (REPORT_ROLES as readonly string[]).includes(role);
}

export interface ReportFollowup {
  id: string;
  customer_id: string;
  promised_on: string | null;
  promised_amount: number | null;
  created_by: string | null;
  created_at: string;
}

/** R-1565: credit_applied (advance credit) is not money the customer paid this week. */
export type ReportPayment = PromisePayment;

export interface ReportOwing {
  customerId: string;
  customerName: string;
  amountDue: number;
}

export interface WeeklyReportInput {
  today: string;
  /** Customers who owe now (the /collections rows with a customer record). */
  owing: readonly ReportOwing[];
  followups: readonly ReportFollowup[];
  /** Payments from at least `paymentsFrom(followups, today)` onward. */
  payments: readonly ReportPayment[];
}

export interface PromiseOutcome {
  customerId: string;
  promisedOn: string;
  promisedAmount: number | null;
  paid: number;
  result: "kept" | "broken" | "today";
}

export interface WeeklyReport {
  weekStart: string;
  today: string;
  received: { total: number; payments: number; customers: number };
  promises: { made: number; madeAmount: number; due: number; kept: number; broken: number; today: number; outcomes: PromiseOutcome[] };
  perPerson: { userId: string | null; count: number }[];
  quiet: { customerId: string; customerName: string; amountDue: number; lastOn: string | null; days: number | null }[];
}

/** Monday of today's IST week (YYYY-MM-DD). */
export function weekStartOf(today: string): string {
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay();   // 0 = Sunday
  return addDaysISO(today, -((dow + 6) % 7));
}

/**
 * The earliest payment date the report needs: the week start, or the day the oldest promise
 * that falls due this week was logged (a payment before the promise date can keep it).
 */
export function paymentsFrom(followups: readonly ReportFollowup[], today: string): string {
  const start = weekStartOf(today);
  let from = start;
  for (const f of followups) {
    const on = f.promised_on?.slice(0, 10);
    if (!on || on < start || on > today) continue;
    const logged = toIstDate(f.created_at);
    if (logged < from) from = logged;
  }
  return from;
}

const rupees = (n: number | null | undefined) => (typeof n === "number" && Number.isFinite(n) ? Math.round(n) : 0);

export function buildWeeklyReport(input: WeeklyReportInput): WeeklyReport {
  const { today } = input;
  const weekStart = weekStartOf(today);
  const inWeek = (d: string) => d >= weekStart && d <= today;

  const listed = new Set<string>([...input.owing.map((o) => o.customerId), ...input.followups.map((f) => f.customer_id)]);
  const received = promiseReceipts(input.payments).filter((p) => listed.has(p.customerId));
  const owesNow = new Set(input.owing.filter((o) => o.amountDue > 0).map((o) => o.customerId));

  const thisWeek = received.filter((p) => inWeek(p.on));

  // ── Promises ──
  const made = input.followups.filter((f) => !!f.promised_on && inWeek(toIstDate(f.created_at)));

  const newestFirst = [...input.followups].sort((a, b) =>
    a.created_at !== b.created_at ? (a.created_at < b.created_at ? 1 : -1) : a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
  const seen = new Map<string, { f: ReportFollowup; firstLogged: string }>();
  for (const f of newestFirst) {
    const on = f.promised_on?.slice(0, 10);
    if (!on || !inWeek(on)) continue;
    const key = `${f.customer_id}|${on}`;
    const logged = toIstDate(f.created_at);
    const had = seen.get(key);
    if (!had) seen.set(key, { f, firstLogged: logged });
    else if (logged < had.firstLogged) had.firstLogged = logged;   // keep the newest amount, the earliest start
  }
  const outcomes: PromiseOutcome[] = [...seen.values()].map(({ f, firstLogged }): PromiseOutcome => {
    const on = f.promised_on!.slice(0, 10);
    // R-1540: the same rule as /collections and the follow-up history (followup-rules.ts).
    const { status, paid, want } = promiseStatus({
      promisedOn: on,
      promisedAmount: f.promised_amount,
      loggedOn: firstLogged,
      today,
      receipts: received.filter((p) => p.customerId === f.customer_id),
      stillOwes: owesNow.has(f.customer_id),
    });
    return {
      customerId: f.customer_id, promisedOn: on, promisedAmount: want, paid,
      // A promise due this week is never "open" (its date is today or earlier).
      result: status === "kept" ? "kept" : status === "broken" ? "broken" : "today",
    };
  }).sort((a, b) => a.promisedOn.localeCompare(b.promisedOn) || a.customerId.localeCompare(b.customerId));

  // ── Per person ──
  const counts = new Map<string | null, number>();
  for (const f of input.followups) {
    if (!inWeek(toIstDate(f.created_at))) continue;
    counts.set(f.created_by, (counts.get(f.created_by) ?? 0) + 1);
  }
  const perPerson = [...counts.entries()]
    .map(([userId, count]) => ({ userId, count }))
    .sort((a, b) => b.count - a.count || String(a.userId).localeCompare(String(b.userId)));

  // ── Gone quiet ──
  const lastBy = new Map<string, string>();
  for (const f of input.followups) {
    const d = toIstDate(f.created_at);
    const had = lastBy.get(f.customer_id);
    if (!had || d > had) lastBy.set(f.customer_id, d);
  }
  const quietSince = addDaysISO(today, -QUIET_DAYS);
  const quiet = input.owing
    .filter((o) => o.amountDue > 0)
    .map((o) => {
      const lastOn = lastBy.get(o.customerId) ?? null;
      return { customerId: o.customerId, customerName: o.customerName, amountDue: rupees(o.amountDue), lastOn, days: lastOn ? daysBetweenISO(lastOn, today) : null };
    })
    .filter((q) => q.lastOn === null || q.lastOn <= quietSince)
    .sort((a, b) => b.amountDue - a.amountDue || a.customerName.localeCompare(b.customerName));

  return {
    weekStart,
    today,
    received: {
      total: thisWeek.reduce((s, p) => s + p.amount, 0),
      payments: thisWeek.length,
      customers: new Set(thisWeek.map((p) => p.customerId)).size,
    },
    promises: {
      made: made.length,
      madeAmount: made.reduce((s, f) => s + rupees(f.promised_amount), 0),
      due: outcomes.length,
      kept: outcomes.filter((o) => o.result === "kept").length,
      broken: outcomes.filter((o) => o.result === "broken").length,
      today: outcomes.filter((o) => o.result === "today").length,
      outcomes,
    },
    perPerson,
    quiet,
  };
}
