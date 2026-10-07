/**
 * R-220 (R-112): the owner's morning digest — four numbers in one email, so the day starts
 * without opening five screens.
 *
 *   1. Money in yesterday  — payments marked received + project payments (the /payments
 *                            "Collected" rule, lib/company/summary.ts collectedInMonth).
 *   2. Overdue             — invoiceIsOverdue + invoiceBalance, the /invoices Overdue tile.
 *   3. Waiting on you      — AI actions HELD for a person (last 7 days) + quotes waiting
 *                            for approval.
 *   4. Renewal risk        — the /subscriptions "Expiring" folder: renews within 30 days,
 *                            or lapsed and still live.
 *
 * Pure: the route fetches, this decides. Money is whole rupees.
 */
import { addDaysISO, istToday, toIstDate } from "@/lib/dates/ist";
import { invoiceIsOverdue, type OverdueInvoice } from "@/lib/invoices/overdue";
import { invoiceBalance } from "@/lib/invoices/kpis";
import { folderCounts, folderMrr, type FolderRow } from "@/lib/subscriptions/folders";

export const HELD_WINDOW_DAYS = 7;

export interface DigestPayment { status: string; amount: number; received_at: string | null }
export interface DigestProjectPayment { amount: number; received_at: string | null }
export interface DigestInvoice extends OverdueInvoice { net_payable?: number | null }
export interface DigestHeld { created_at: string; reason: string | null }
export interface DigestSub extends FolderRow { mrr: number | null }

export interface OwnerDigestInput {
  now: Date;
  payments: readonly DigestPayment[];
  projectPayments: readonly DigestProjectPayment[];
  invoices: readonly DigestInvoice[];
  held: readonly DigestHeld[];
  quotesAwaitingApproval: number;
  subscriptions: readonly DigestSub[];
}

export interface CountValue { count: number; value: number }

export interface OwnerDigest {
  /** IST date the "money in" figure is for (yesterday). */
  day: string;
  moneyIn: CountValue;
  overdue: CountValue;
  waiting: { held: number; quotes: number; total: number; examples: string[] };
  renewals: CountValue;
}

const rupees = (n: number) => Math.round(n);

/** ISO date `days` before today (IST) — the first day of the held-actions window. */
export function heldSince(now: Date): string {
  return addDaysISO(istToday(now), -HELD_WINDOW_DAYS);
}

export function buildOwnerDigest(input: OwnerDigestInput): OwnerDigest {
  const today = istToday(input.now);
  const day = addDaysISO(today, -1);

  const moneyIn: CountValue = { count: 0, value: 0 };
  for (const p of input.payments) {
    if (p.status !== "received" || !p.received_at) continue;
    if (toIstDate(p.received_at) !== day) continue;
    moneyIn.count++; moneyIn.value += p.amount ?? 0;
  }
  for (const p of input.projectPayments) {
    /* project_payments.received_at is a plain date; an instant is read in IST. */
    if (!p.received_at) continue;
    const d = p.received_at.length === 10 ? p.received_at : toIstDate(p.received_at);
    if (d !== day) continue;
    moneyIn.count++; moneyIn.value += p.amount ?? 0;
  }

  const overdue: CountValue = { count: 0, value: 0 };
  for (const inv of input.invoices) {
    if (!invoiceIsOverdue(inv, today)) continue;
    overdue.count++;
    overdue.value += invoiceBalance(inv);
  }

  const since = heldSince(input.now);
  const held = input.held.filter((h) => toIstDate(h.created_at) >= since);
  const examples = held
    .map((h) => (h.reason ?? "").trim())
    .filter(Boolean)
    .slice(0, 3);

  const counts = folderCounts(input.subscriptions, today);
  const renewals: CountValue = { count: counts.expiring, value: folderMrr(input.subscriptions, "expiring", today) };

  return {
    day,
    moneyIn: { count: moneyIn.count, value: rupees(moneyIn.value) },
    overdue: { count: overdue.count, value: rupees(overdue.value) },
    waiting: { held: held.length, quotes: input.quotesAwaitingApproval, total: held.length + input.quotesAwaitingApproval, examples },
    renewals: { count: renewals.count, value: rupees(renewals.value) },
  };
}

/** ₹1,23,456 — Indian grouping, whole rupees. */
export function inr(n: number): string {
  return `₹${rupees(n).toLocaleString("en-IN")}`;
}

export function ownerDigestSubject(d: OwnerDigest): string {
  return `ResellerOS morning: ${inr(d.moneyIn.value)} in, ${d.overdue.count} overdue, ${d.waiting.total} waiting on you`;
}

export function ownerDigestText(d: OwnerDigest, appUrl: string): string {
  const url = (path: string) => (appUrl ? `${appUrl.replace(/\/$/, "")}${path}` : path);
  const lines = [
    `Good morning. Your day at a glance (${d.day} = yesterday, IST).`,
    "",
    `1. Money in yesterday: ${inr(d.moneyIn.value)} from ${d.moneyIn.count} payment${d.moneyIn.count === 1 ? "" : "s"}`,
    `   ${url("/payments")}`,
    `2. Overdue invoices: ${d.overdue.count}, ${inr(d.overdue.value)} still owed`,
    `   ${url("/invoices?tab=overdue")}`,
    `3. Waiting on you: ${d.waiting.total} (${d.waiting.held} AI action${d.waiting.held === 1 ? "" : "s"} held, ${d.waiting.quotes} quote${d.waiting.quotes === 1 ? "" : "s"} to approve)`,
    ...d.waiting.examples.map((e) => `   - ${e.slice(0, 140)}`),
    `   ${url("/quotes")}`,
    `4. Renewals in the next 30 days (or lapsed): ${d.renewals.count}, ${inr(d.renewals.value)} MRR at stake`,
    `   ${url("/subscriptions?tab=expiring")}`,
  ];
  return lines.join("\n");
}
