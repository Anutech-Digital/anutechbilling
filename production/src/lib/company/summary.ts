/**
 * Company — how the business is doing this month, one function per team role (1 Oct 2026).
 *
 * Pardeep: "4 team member se AI software company chalana chahta hu". The dashboard's Company
 * section shows one small card per function, and every number links to the screen it sums
 * up. So each number here is computed by the SAME rule that screen uses — either the helper
 * the screen imports, or a helper that the screen now imports from here:
 *
 *   Growth (Pawan)        new leads, from the website ........ /lead-gen  (captureChannel)
 *                         trials started / running ............ /subscriptions → Trials tab
 *   Sales (Pardeep)       won this month, pipeline ............ /deals     (summarizeDealStrip,
 *                                                                           read by the caller)
 *   Money (Hitesh)        invoiced, outstanding, overdue ...... /invoices  (invoiceBucket)
 *                         collected ........................... /payments  (collectedInMonth)
 *   Customers & Ops       new customers ....................... /customers
 *     (Abhishek)          MRR, renewals due ................... /subscriptions (folderCounts)
 *                         open tickets ........................ /support   (its own counts)
 *                         waiting to activate ................. /provisioning (its own counts)
 *
 * "This month" is the IST calendar month (lib/dates/ist.ts), never the browser's clock.
 * Money is read as stored — no GST is recomputed here.
 */
import { istMonth, istToday, monthBounds, toIstDate, istDayStartUtc } from "@/lib/dates/ist";
import { invoiceBucket, type OverdueInvoice } from "@/lib/invoices/overdue";
import { invoiceBalance, invoiceInFocus } from "@/lib/invoices/kpis";
import { folderCounts, folderMrr, type FolderRow } from "@/lib/subscriptions/folders";
import { captureChannel } from "@/lib/leads/capture-channel";
import { cashReceived } from "@/lib/payments/cash-received";

// ─── Month helpers ───────────────────────────────────────────────────────────

/**
 * Is this date / instant inside the IST month of `now`?
 * A bare `YYYY-MM-DD` is a calendar date and is not shifted; a timestamp is read in IST.
 */
export function inIstMonth(at: string | null | undefined, now: Date = new Date()): boolean {
  if (!at) return false;
  const day = /^\d{4}-\d{2}-\d{2}$/.test(at) ? at : toIstDate(at);
  const { start, end } = monthBounds(istMonth(now));
  return day >= start && day <= end;
}

/** The instant the current IST month began — for a `created_at >= …` query bound. */
export function istMonthStartUtc(now: Date = new Date()): Date {
  return istDayStartUtc(monthBounds(istMonth(now)).start);
}

// ─── Growth ──────────────────────────────────────────────────────────────────

export interface GrowthLead { source: string | null; created_at: string | null }

export interface GrowthSummary {
  /** Leads created this IST month — the sum of /lead-gen's channel rows. */
  newLeads: number;
  /** Of those, the ones in /lead-gen's "Website form" row (public enquiry / buy / trial). */
  fromWebsite: number;
}

export function growthSummary(leads: readonly GrowthLead[], now: Date = new Date()): GrowthSummary {
  let newLeads = 0, fromWebsite = 0;
  for (const l of leads) {
    if (!inIstMonth(l.created_at, now)) continue;
    newLeads++;
    if (captureChannel(l.source) === "website") fromWebsite++;
  }
  return { newLeads, fromWebsite };
}

/** Trials whose `trial_started_at` falls in this IST month. */
export function trialsStartedInMonth(
  trials: readonly { trial_started_at: string | null }[],
  now: Date = new Date(),
): number {
  return trials.filter((t) => inIstMonth(t.trial_started_at, now)).length;
}

// ─── Money ───────────────────────────────────────────────────────────────────

export interface MoneyInvoice extends OverdueInvoice {
  invoice_date: string | null;
  net_payable?: number | null;
}

export interface CountValue { count: number; value: number }

export interface InvoiceMoney {
  /** Real invoices (not draft / void / cancelled) dated this IST month, at their stored total. */
  invoicedThisMonth: CountValue;
  /** Invoices still owed, at what is still owed — the /invoices Outstanding tile's set
   *  (lib/invoices/kpis.ts#invoiceInFocus "unpaid"), so the row and its list agree. */
  outstanding: CountValue;
  /** The Overdue tab's count on /invoices — invoiceBucket, the function the tab uses. */
  overdueCount: number;
}

/** Statuses that are not a bill anybody owes. */
const NOT_A_BILL = new Set(["draft", "void", "cancelled"]);

export function invoiceMoney(invoices: readonly MoneyInvoice[], now: Date = new Date()): InvoiceMoney {
  const today = istToday(now);
  const out: InvoiceMoney = {
    invoicedThisMonth: { count: 0, value: 0 },
    outstanding: { count: 0, value: 0 },
    overdueCount: 0,
  };
  for (const inv of invoices) {
    if (NOT_A_BILL.has(inv.status)) continue;
    if (inIstMonth(inv.invoice_date, now)) {
      out.invoicedThisMonth.count++;
      out.invoicedThisMonth.value += inv.amount;
    }
    const bucket = invoiceBucket(inv, today);
    if (bucket === "overdue") out.overdueCount++;
    /* R-118 (2 Oct 2026): this summed the full bill (net_payable ?? amount) without taking
       off receipts, so a half-paid ₹1L invoice showed ₹1L "still owed" here and ₹50K on
       /invoices. Now the same balance, and the same set, as the Outstanding tile. */
    if (invoiceInFocus(inv, "unpaid", now)) {
      out.outstanding.count++;
      out.outstanding.value += invoiceBalance(inv);
    }
  }
  return out;
}

/**
 * Money received this IST month: sales payments marked received plus project payments —
 * the /payments "Collected MTD" figure (that page calls this).
 * `payments.received_at` is an instant (read in IST); `project_payments.received_at` is a date.
 */
export function collectedInMonth(
  payments: readonly { status: string; amount: number; credit_applied?: number | null; received_at: string }[],
  projectPayments: readonly { amount: number; received_at: string }[],
  now: Date = new Date(),
): number {
  let sum = 0;
  /* R-1565: only the money that came in — advance credit applied to a payment was already
     collected on the payment that created the credit (lib/payments/cash-received.ts). */
  for (const p of payments) if (p.status === "received" && inIstMonth(p.received_at, now)) sum += cashReceived(p);
  for (const p of projectPayments) if (inIstMonth(p.received_at, now)) sum += p.amount;
  return sum;
}

// ─── Customers & Ops ─────────────────────────────────────────────────────────

/** Customers created this IST month. */
export function newCustomersInMonth(
  customers: readonly { created_at: string | null }[],
  now: Date = new Date(),
): number {
  return customers.filter((c) => inIstMonth(c.created_at, now)).length;
}

export interface SubscriptionSummary {
  /** status = active — the /subscriptions "Active MRR" tile counts these. */
  activeCount: number;
  /** Sum of mrr over active subscriptions — /subscriptions "Active MRR". */
  mrr: number;
  /** The Expiring tab on /subscriptions: renews within 30 days, or lapsed and still live. */
  renewalsDue: CountValue;
}

export function subscriptionSummary(
  subs: readonly (FolderRow & { mrr: number | null })[],
  now: Date = new Date(),
): SubscriptionSummary {
  const today = istToday(now);
  const active = subs.filter((s) => s.status === "active");
  return {
    activeCount: active.length,
    mrr: active.reduce((sum, s) => sum + (s.mrr ?? 0), 0),
    renewalsDue: { count: folderCounts(subs, today).expiring, value: folderMrr(subs, "expiring", today) },
  };
}

/** Ticket statuses that still need somebody — everything but resolved and closed. */
export const OPEN_TICKET_STATUSES = ["open", "in_progress", "awaiting_customer"] as const;

/** Open tickets from the per-status counts /api/support/tickets returns to /support. */
export function openTicketCount(counts: Readonly<Record<string, number>> | null | undefined): number {
  return OPEN_TICKET_STATUSES.reduce((n, s) => n + (counts?.[s] ?? 0), 0);
}
