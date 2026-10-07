/**
 * R-346 — "Activate now, pay later": a credit sale from an ACCEPTED, unpaid quote.
 *
 * B2B standard (Pardeep, 7 Oct 2026): many customers want the subscription live first and pay
 * later. Until now a subscription only came into being when a payment was recorded. The trial
 * (R-282, lib/trials) is a different thing: 14 days, at most 10 users, no invoice.
 *
 * Pardeep's rules (approved 7 Oct):
 *   - Credit days default to the customer's payment terms, else 15.
 *   - One save: GST invoice (due = today + credit days) + every recurring line's subscription
 *     ACTIVE + owner task "Set up seats (DNS, users)". Done in ONE database transaction by
 *     `activate_quote_on_credit` (migration 20261007073000_activate_on_credit.sql).
 *   - Tasks only, never a message: "send payment link" on due − 3, "payment not in — stop
 *     service?" on due + 15. Nothing is suspended automatically.
 *   - Customer: "Allow pay later" (default on) + "Credit limit" (empty = ₹50,000). Unpaid
 *     invoices + this invoice above the limit → only the OWNER may approve; anyone else is
 *     told plainly why not.
 *
 * Everything here that decides something is a pure function (activate-on-credit.test.ts). The
 * database repeats every check — the screen only explains them before the click.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { addDaysISO, istDayStartUtc, toIstDate } from "@/lib/dates/ist";

export const CREDIT_DEFAULT_DAYS = 15;
export const CREDIT_MIN_DAYS = 1;
export const CREDIT_MAX_DAYS = 180;
/** ₹ — the limit when the customer's own is left empty. */
export const CREDIT_DEFAULT_LIMIT = 50_000;
/** Days before the due date that the "send payment link" task falls. */
export const CREDIT_LINK_DAYS_BEFORE = 3;
/** Days after the due date that the "stop service?" task falls. */
export const CREDIT_STOP_DAYS_AFTER = 15;
/** The two reminder tasks start with this; record_payment closes them when the invoice is paid. */
export const CREDIT_TASK_PREFIX = "Credit:";
export const CREDIT_MIGRATION = "20261007073000_activate_on_credit";

const HOUR_MS = 3_600_000;

// ── Defaults ─────────────────────────────────────────────────────────────────

/** The customer's payment terms when they have some, else 15. "Due on receipt" (0) is not credit. */
export function defaultCreditDays(customerTermsDays: number | null | undefined): number {
  const n = Number(customerTermsDays);
  if (!Number.isFinite(n) || n < CREDIT_MIN_DAYS) return CREDIT_DEFAULT_DAYS;
  return Math.min(Math.floor(n), CREDIT_MAX_DAYS);
}

export function validCreditDays(days: number): boolean {
  return Number.isInteger(days) && days >= CREDIT_MIN_DAYS && days <= CREDIT_MAX_DAYS;
}

/** The customer's limit, or ₹50,000 when it is left empty. */
export function effectiveCreditLimit(limit: number | null | undefined): number {
  return typeof limit === "number" && Number.isFinite(limit) && limit >= 0 ? Math.round(limit) : CREDIT_DEFAULT_LIMIT;
}

// ── Who may see / use it ─────────────────────────────────────────────────────

export interface CreditQuoteFacts {
  status: string;
  payment_status: string | null;
  /** Sum of received payments, whole rupees. */
  received: number;
  is_one_off?: boolean | null;
  is_add_seats?: boolean | null;
  line_items?: ReadonlyArray<{ commitment?: string | null }> | null;
  /** quotes.credit_activated_at — undefined when the migration is not in yet. */
  credit_activated_at?: string | null;
}

export interface CreditLeadFacts {
  trial_started_at: string | null;
  trial_converted_at: string | null;
}

/** A line that becomes a subscription: it has a commitment (monthly or any annual tier). */
export function hasRecurringLine(lines: CreditQuoteFacts["line_items"]): boolean {
  return (lines ?? []).some((l) => typeof l?.commitment === "string" && l.commitment.length > 0);
}

/** A trial that is running or ended-unpaid. Its quote gets no credit button (rule: trial ≠ credit). */
export function onTrial(lead: CreditLeadFacts | null | undefined): boolean {
  return Boolean(lead?.trial_started_at && !lead.trial_converted_at);
}

/**
 * Should "Activate now, pay later" appear in the quote's More menu at all? Accepted, no money,
 * not already on credit, not a trial, and something recurring to switch on.
 */
export function showActivateOnCredit(quote: CreditQuoteFacts, lead: CreditLeadFacts | null | undefined): boolean {
  if (quote.status !== "accepted") return false;
  if (quote.received > 0 || quote.payment_status === "received" || quote.payment_status === "partial") return false;
  if (quote.credit_activated_at) return false;
  if (onTrial(lead)) return false;
  if (quote.is_one_off || quote.is_add_seats) return false;
  return hasRecurringLine(quote.line_items);
}

export type CreditEligibility = { ok: true } | { ok: false; reason: string };

/** Customer-side gate, said in words (the menu item is shown; this explains a refusal). */
export function customerCreditEligibility(
  customer: { name: string; allow_pay_later?: boolean | null } | null | undefined,
): CreditEligibility {
  if (!customer) {
    return { ok: false, reason: "This quote has no customer yet. Accept it so the customer is created, then activate." };
  }
  if (customer.allow_pay_later === false) {
    return {
      ok: false,
      reason: `Pay later is off for ${customer.name}. The owner can turn it on in the customer's Pay later settings.`,
    };
  }
  return { ok: true };
}

// ── Annual plans need payment first (R-368) ──────────────────────────────────

/** Shortest owner reason the database accepts for activating an annual plan on credit. */
export const ANNUAL_OVERRIDE_MIN_REASON = 5;

/**
 * A line billed for a year (or a legacy multi-month term). Monthly flex, one-time and lines
 * with no commitment are not. Same test as the database's check (migration 20261007123000).
 */
function isAnnualCommitment(c: unknown): boolean {
  return typeof c === "string" && c.length > 0 && c !== "monthly" && c !== "one_time";
}

export function annualLineNames(
  lines: ReadonlyArray<{ commitment?: string | null; name?: string | null }> | null | undefined,
): string[] {
  return (lines ?? [])
    .filter((l) => isAnnualCommitment(l?.commitment))
    .map((l) => (typeof l.name === "string" && l.name.trim() ? l.name.trim() : "Annual plan"));
}

export type AnnualCreditDecision =
  | { kind: "allowed" }
  | { kind: "blocked"; reason: string }
  | { kind: "needs-override" }
  | { kind: "overridden"; reason: string };

/**
 * Pardeep (7 Oct 2026): a year of service on credit is too much risk by default. Annual lines
 * block "Activate now, pay later"; only the OWNER can override, and must write why.
 */
export function annualCreditDecision(
  lines: ReadonlyArray<{ commitment?: string | null; name?: string | null }> | null | undefined,
  role: string | null | undefined,
  overrideReason: string,
): AnnualCreditDecision {
  if (annualLineNames(lines).length === 0) return { kind: "allowed" };
  if (role !== "owner") {
    return { kind: "blocked", reason: "Annual plans need payment first. Only the owner can activate an annual plan on credit." };
  }
  const reason = overrideReason.trim();
  if (reason.length < ANNUAL_OVERRIDE_MIN_REASON) return { kind: "needs-override" };
  return { kind: "overridden", reason };
}

// ── Credit limit ─────────────────────────────────────────────────────────────

export interface OpenInvoice {
  id: string;
  status: string;
  amount: number;
  net_payable: number | null;
  paid_amount: number | null;
}

/** What is still owed on unpaid (pending/overdue) invoices — the same sum the database uses. */
export function owedOnInvoices(invoices: readonly OpenInvoice[]): number {
  return invoices.reduce((sum, i) => {
    if (i.status !== "pending" && i.status !== "overdue") return sum;
    return sum + Math.max(0, (i.net_payable ?? i.amount) - (i.paid_amount ?? 0));
  }, 0);
}

export interface CreditExposure {
  owed: number;
  thisInvoice: number;
  total: number;
  limit: number;
  over: boolean;
}

/**
 * Already owed + this invoice vs the limit. An invoice already raised on this quote is inside
 * `owed`, so it is not added twice.
 */
export function creditExposure(input: {
  openInvoices: readonly OpenInvoice[];
  quoteAmount: number;
  quoteInvoiceId: string | null | undefined;
  creditLimit: number | null | undefined;
}): CreditExposure {
  const owed = owedOnInvoices(input.openInvoices);
  const thisInvoice = input.quoteInvoiceId ? 0 : Math.max(0, Math.round(input.quoteAmount));
  const total = owed + thisInvoice;
  const limit = effectiveCreditLimit(input.creditLimit);
  return { owed, thisInvoice, total, limit, over: total > limit };
}

export type OverLimitDecision =
  | { kind: "within" }
  | { kind: "owner-approve" }
  | { kind: "refused"; reason: string };

/** Over the limit: the owner gets an "Approve over limit" tick, everyone else a plain no. */
export function overLimitDecision(exposure: CreditExposure, role: string | null | undefined, fmt: (n: number) => string): OverLimitDecision {
  if (!exposure.over) return { kind: "within" };
  if (role === "owner") return { kind: "owner-approve" };
  return {
    kind: "refused",
    reason: `Over the credit limit: ${fmt(exposure.owed)} already owed + ${fmt(exposure.thisInvoice)} this invoice = ${fmt(exposure.total)}, limit ${fmt(exposure.limit)}. Only the owner can approve this.`,
  };
}

// ── The plan (what the dialog shows before saving) ───────────────────────────

export interface CreditTaskPlan {
  title: string;
  /** IST calendar day the task falls on. */
  day: string;
}

export interface CreditPlan {
  /** IST calendar day the invoice is due. */
  dueDate: string;
  tasks: CreditTaskPlan[];
}

/**
 * Same dates the database writes: the set-up task today, the payment-link task on due − 3 (never
 * before today), the stop-service question on due + 15. Titles without the customer suffix.
 */
export function planCredit(now: Date, days: number): CreditPlan {
  if (!validCreditDays(days)) {
    throw new Error(`Credit days must be ${CREDIT_MIN_DAYS}–${CREDIT_MAX_DAYS}.`);
  }
  const today = toIstDate(now);
  const dueDate = addDaysISO(today, days);
  const linkDay = addDaysISO(dueDate, -CREDIT_LINK_DAYS_BEFORE) < today ? today : addDaysISO(dueDate, -CREDIT_LINK_DAYS_BEFORE);
  return {
    dueDate,
    tasks: [
      { title: "Set up seats (DNS, users)", day: today },
      { title: `${CREDIT_TASK_PREFIX} send payment link`, day: linkDay },
      { title: `${CREDIT_TASK_PREFIX} payment not in — stop service?`, day: addDaysISO(dueDate, CREDIT_STOP_DAYS_AFTER) },
    ],
  };
}

/** 10:00 IST on an IST day, as an instant — the time the database gives each task. */
export function creditTaskInstant(isoDay: string): Date {
  return new Date(istDayStartUtc(isoDay).getTime() + 10 * HOUR_MS);
}

// ── Reading it back on the quote ─────────────────────────────────────────────

export interface CreditInvoiceFacts {
  id: string;
  status: string;
  amount: number;
  net_payable: number | null;
  paid_amount: number | null;
  due_date: string | null;
}

export type QuoteCreditState =
  | { kind: "due"; amountDue: number; dueDate: string; daysLeft: number }
  | { kind: "overdue"; amountDue: number; dueDate: string; daysLate: number }
  | { kind: "paid" };

/** null = this quote was not activated on credit (or the invoice has not loaded). */
export function quoteCreditState(
  quote: { credit_activated_at?: string | null; credit_due_date?: string | null },
  invoice: CreditInvoiceFacts | null | undefined,
  now: Date = new Date(),
): QuoteCreditState | null {
  if (!quote.credit_activated_at || !invoice) return null;
  if (invoice.status === "paid") return { kind: "paid" };
  if (invoice.status === "void") return null;
  const amountDue = Math.max(0, (invoice.net_payable ?? invoice.amount) - (invoice.paid_amount ?? 0));
  if (amountDue === 0) return { kind: "paid" };
  const dueDate = (invoice.due_date ?? quote.credit_due_date ?? "").slice(0, 10);
  if (!dueDate) return null;
  const today = toIstDate(now);
  const diff = Math.round((Date.parse(`${dueDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
  if (diff < 0) return { kind: "overdue", amountDue, dueDate, daysLate: -diff };
  return { kind: "due", amountDue, dueDate, daysLeft: diff };
}

// ── Receivables summary ──────────────────────────────────────────────────────

export interface CreditSummary {
  /** Subscriptions live on a credit quote whose invoice is still unpaid. */
  subscriptions: number;
  /** ₹ still due on those invoices. */
  amountDue: number;
}

export function creditSummary(
  quotes: ReadonlyArray<{ id: string; invoice_id: string | null }>,
  invoices: readonly OpenInvoice[],
  subscriptions: ReadonlyArray<{ quote_id: string | null; status: string }>,
): CreditSummary {
  const byId = new Map(invoices.map((i) => [i.id, i]));
  const unpaidQuotes = new Set<string>();
  let amountDue = 0;
  for (const q of quotes) {
    const inv = q.invoice_id ? byId.get(q.invoice_id) : undefined;
    if (!inv) continue;
    const due = owedOnInvoices([inv]);
    if (due <= 0) continue;
    unpaidQuotes.add(q.id);
    amountDue += due;
  }
  const subs = subscriptions.filter((s) => s.quote_id && unpaidQuotes.has(s.quote_id) && s.status === "active").length;
  return { subscriptions: subs, amountDue };
}

// ── Database not updated yet ─────────────────────────────────────────────────

export const NEEDS_DB_UPDATE_MESSAGE =
  "This needs a database update before it can run. Ask the owner to apply the latest update, then try again.";

/** PostgREST "function/column not found" — the migration is not applied on this database. */
export function isMissingDbObject(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: unknown; message?: unknown };
  const code = typeof e.code === "string" ? e.code : "";
  if (code === "PGRST202" || code === "PGRST204" || code === "42883" || code === "42703") return true;
  const msg = typeof e.message === "string" ? e.message : "";
  return /could not find the function|schema cache/i.test(msg) && /activate_quote_on_credit|allow_pay_later|credit_limit|credit_activated_at/.test(msg);
}

export class NeedsDatabaseUpdateError extends Error {
  constructor() {
    super(NEEDS_DB_UPDATE_MESSAGE);
    this.name = "NeedsDatabaseUpdateError";
  }
}

// ── The writer ───────────────────────────────────────────────────────────────

export interface ActivateOnCreditResult {
  alreadyActive: boolean;
  invoiceId: string | null;
  dueDate: string | null;
  amountDue: number | null;
  subscriptionsCreated: number;
  tasksCreated: number;
  overLimit: boolean;
}

/** One RPC: invoice + subscriptions + tasks in one transaction, or nothing at all. */
export async function activateQuoteOnCredit(
  supabase: SupabaseClient,
  input: { quoteId: string; days: number; approveOverLimit: boolean; annualOverrideReason?: string | null },
): Promise<ActivateOnCreditResult> {
  if (!validCreditDays(input.days)) {
    throw new Error(`Credit days must be ${CREDIT_MIN_DAYS}–${CREDIT_MAX_DAYS}.`);
  }
  /* R-368: an annual line needs the owner's written reason (migration 20261007123000). Sent
     only when there is one, so a monthly quote still activates on a database that has
     R-346's function but not this one yet. */
  const reason = input.annualOverrideReason?.trim();
  const { data, error } = await supabase.rpc("activate_quote_on_credit", {
    p_quote_id: input.quoteId,
    p_credit_days: input.days,
    p_approve_over_limit: input.approveOverLimit,
    ...(reason ? { p_annual_override_reason: reason } : {}),
  });
  if (error) {
    if (isMissingDbObject(error)) throw new NeedsDatabaseUpdateError();
    throw new Error(error.message);
  }
  const r = (data ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
  const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
  return {
    alreadyActive: r.already_active === true,
    invoiceId: str(r.invoice_id),
    dueDate: str(r.due_date),
    amountDue: num(r.amount_due),
    subscriptionsCreated: num(r.subscriptions_created) ?? 0,
    tasksCreated: num(r.tasks_created) ?? 0,
    overLimit: r.over_limit === true,
  };
}
