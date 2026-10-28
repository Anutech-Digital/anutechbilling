/**
 * R-2044 (28 Oct 2026, Pardeep) — a subscription billed in parts gets a PAYMENT REQUEST for each
 * part on its date, not a tax invoice. "Customer kai baar commitment break kar deta hai aur
 * payment nahi karta — invoice hamari liability ban jayega." The part's tax invoice is raised
 * when its request is paid (database trigger tg_payments_part_request_invoice →
 * bill_subscription_instalment → raise_subscription_billing, the one instalment invoice path).
 *
 * Pure rules, read by the billing cron (app/api/cron/billing) and its tests:
 *   - what bill_subscription_instalment's answer means for the cron's report;
 *   - the reminder ladder for an unpaid request — the invoice-dunning ladder's steps and ranking
 *     (lib/invoices/dunning: reminder / retry / final, never twice), squeezed into the company's
 *     grace (tenants.grace_period_days, default 7 — Pardeep, 28 Oct): Day 1, Day 3, final on the
 *     grace's last day. Not the renewals ladder: that counts DOWN to a renewal date, which a part
 *     request does not have;
 *   - when the subscription is paused for an unpaid request: after the grace, under the company's
 *     own opt-in (tenants.auto_suspend_on_overdue — the same switch as for unpaid invoices).
 */
import { dunningRank } from "@/lib/invoices/dunning";
import { daysBetweenISO } from "@/lib/dates/ist";

/** What public.bill_subscription_instalment answers. */
export type BillOutcome =
  | { action: "already_invoiced"; invoice_id: string }
  | { action: "invoice"; invoice_id?: string; gross: number; already_raised?: boolean; dry_run?: boolean; reason?: string }
  | { action: "request"; quote_id?: string; created?: boolean; gross: number; dry_run?: boolean }
  | { action: "request_open"; quote_id: string; status: string; gross: number };

export interface BillTally {
  raised: { period_index: number; invoice_id: string; gross: number }[];
  alreadyRaised: number;
  wouldRaise: number;
  requests: { period_index: number; quote_id: string; gross: number }[];
  requestsOpen: { period_index: number; quote_id: string; status: string }[];
  wouldRequest: number;
}

/** Adds one part's outcome to the run's tally. Unknown answers throw — never a silent "0". */
export function applyBillOutcome(out: BillTally, periodIndex: number, data: unknown, dryRun: boolean): void {
  const r = data as BillOutcome | null;
  if (!r || typeof r !== "object" || !("action" in r)) {
    throw new Error(`bill_subscription_instalment returned nothing for part ${periodIndex}`);
  }
  switch (r.action) {
    case "already_invoiced":
      out.alreadyRaised += 1;
      return;
    case "invoice":
      if (dryRun || r.dry_run) { out.wouldRaise += 1; return; }
      if (r.already_raised) { out.alreadyRaised += 1; return; }
      if (!r.invoice_id) throw new Error(`No invoice number came back for part ${periodIndex}`);
      out.raised.push({ period_index: periodIndex, invoice_id: r.invoice_id, gross: r.gross });
      return;
    case "request":
      if (dryRun || r.dry_run) { out.wouldRequest += 1; return; }
      if (!r.quote_id) throw new Error(`No payment request number came back for part ${periodIndex}`);
      out.requests.push({ period_index: periodIndex, quote_id: r.quote_id, gross: r.gross });
      return;
    case "request_open":
      out.requestsOpen.push({ period_index: periodIndex, quote_id: r.quote_id, status: r.status });
      return;
    default:
      throw new Error(`bill_subscription_instalment answered "${(r as { action: string }).action}" for part ${periodIndex}`);
  }
}

/** The steps an unpaid part request is chased with — the dunning ladder's names, so its log ranks the same. */
export type RequestReminderStep = "reminder" | "retry" | "final";

/** The company's grace (tenants.grace_period_days); 0 / unset → 7 days (Pardeep, 28 Oct). */
export const DEFAULT_REQUEST_GRACE_DAYS = 7;
export function requestGraceDays(tenantGraceDays: number | null | undefined): number {
  const n = Math.round(Number(tenantGraceDays ?? 0));
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_REQUEST_GRACE_DAYS;
}

/**
 * Which reminder (if any) to send today for an unpaid request. The request is prepaid: sent on the
 * part's bill date and due that day. Inside the grace: Day 1 reminder, Day 3 retry (when the grace
 * is longer), and the FINAL notice on the grace's last day — then the reminders stop. Never repeats
 * a step already sent (dunningRank), never chases a closed or paid request.
 */
export function requestReminderStep(args: {
  dueOn: string;
  todayISO: string;
  lastStep: string | null | undefined;
  open: boolean;
  amountDue: number;
  graceDays: number;
}): RequestReminderStep | null {
  if (!args.open || args.amountDue <= 0) return null;
  const late = daysBetweenISO(args.dueOn, args.todayISO);
  const grace = requestGraceDays(args.graceDays);
  const ladder: { day: number; step: RequestReminderStep }[] = [
    ...([{ day: 1, step: "reminder" }, { day: 3, step: "retry" }] as const).filter((x) => x.day < grace),
    { day: grace, step: "final" },
  ];
  const due = [...ladder].reverse().find((x) => late >= x.day);
  if (!due) return null;
  if (dunningRank(due.step) <= dunningRank(args.lastStep)) return null;
  return due.step;
}

/** The customer message for one reminder. Plain English; the Pay link is the next step. */
export function requestReminderText(a: {
  step: RequestReminderStep | "new";
  customerName: string;
  companyName: string;
  quoteId: string;
  part: string;
  amount: string;
  dueOn: string;
  payUrl: string | null;
}): { subject: string; body: string } {
  const lead: Record<RequestReminderStep | "new", string> = {
    new:           `Here is your payment request: ${a.part}. It is due on ${a.dueOn}.`,
    reminder:      `A reminder: the payment for ${a.part} was due on ${a.dueOn}.`,
    retry:         `We have not yet received the payment for ${a.part}, due on ${a.dueOn}.`,
    final:         `Final notice: the payment for ${a.part} (due ${a.dueOn}) is still open. Please pay to keep the service running.`,
  };
  const subject = a.step === "new"
    ? `${a.part} — ${a.amount} (${a.quoteId})`
    : `Reminder: payment request ${a.quoteId} — ${a.amount}`;
  const body = [
    `Dear ${a.customerName},`,
    "",
    lead[a.step],
    `Amount: ${a.amount}`,
    a.payUrl ? `Pay here: ${a.payUrl}` : "Reply to this email for the payment details.",
    "",
    "The tax invoice for this part is issued as soon as it is paid.",
    "",
    a.companyName,
  ].join("\n");
  return { subject, body };
}

/**
 * Pause the subscription today for an unpaid request? Only for a company that switched the pause
 * on (tenants.auto_suspend_on_overdue — the same opt-in as unpaid invoices), after the grace, and
 * only once the final notice went out (R-1538's promise: never paused without the notice). The
 * request itself stays open until it is paid or "Customer stopped".
 */
export function requestPauseDue(a: {
  companyOn: boolean;
  graceDays: number;
  dueOn: string;
  todayISO: string;
  lastStep: string | null | undefined;
  open: boolean;
}): boolean {
  if (!a.companyOn || !a.open) return false;
  if (dunningRank(a.lastStep) < dunningRank("final")) return false;
  return daysBetweenISO(a.dueOn, a.todayISO) > requestGraceDays(a.graceDays);
}

/** The pause reason; it names the request so paying it turns the service back on. */
export function requestPauseReason(quoteId: string, dueOn: string, todayISO: string): string {
  return `Payment request ${quoteId} unpaid since ${dueOn} (${daysBetweenISO(dueOn, todayISO)} days) — paused automatically; paying it turns the service back on.`;
}


/**
 * The day the billing cron bills for. `?on=` only with a dry run (nothing is written or sent), and
 * only a real YYYY-MM-DD — the same rule as the invoice-dunning cron.
 */
export function billingCronDay(a: { dryRun: boolean; on: string | null; todayISO: string }): { todayISO: string } | { error: string } {
  if (!a.on) return { todayISO: a.todayISO };
  if (!a.dryRun) return { error: "?on= is accepted only with ?dry=1 — a live run never bills on a pretend date." };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(a.on) || Number.isNaN(Date.parse(`${a.on}T00:00:00Z`))) {
    return { error: `?on= must be a date like 2026-11-01, not "${a.on}".` };
  }
  return { todayISO: a.on };
}

/** "Customer stopped" (R-2044): what happens to the subscription, and why. */
export type CustomerStoppedEnd = "cancel" | "pause";

export function parseCustomerStopped(body: unknown): { end: CustomerStoppedEnd; reason: string } | { error: string } {
  const b = (body ?? {}) as { end?: unknown; reason?: unknown };
  if (b.end !== "cancel" && b.end !== "pause") return { error: "Choose what happens to the subscription: cancel it or pause it." };
  const reason = typeof b.reason === "string" ? b.reason.trim() : "";
  if (reason.length < 5) return { error: "Write why the customer stopped (at least 5 characters) — it is kept on the record." };
  return { end: b.end, reason: reason.slice(0, 500) };
}

/** Show "Customer stopped" on a quote: only an open, unpaid part payment request. */
export function showCustomerStopped(q: {
  subscription_billing_id?: string | null;
  status: string;
  invoice_id: string | null;
  receivedSoFar: number;
}): boolean {
  return Boolean(q.subscription_billing_id)
    && ["sent", "viewed", "accepted"].includes(q.status)
    && !q.invoice_id
    && q.receivedSoFar <= 0;
}
