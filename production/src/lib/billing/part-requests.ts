/**
 * R-2044 (28 Oct 2026, Pardeep) — a subscription billed in parts gets a PAYMENT REQUEST for each
 * part on its date, not a tax invoice. "Customer kai baar commitment break kar deta hai aur
 * payment nahi karta — invoice hamari liability ban jayega." The part's tax invoice is raised
 * when its request is paid (database trigger tg_payments_part_request_invoice →
 * bill_subscription_instalment → raise_subscription_billing, the one instalment invoice path).
 *
 * Pure rules, read by the billing cron (app/api/cron/billing) and its tests:
 *   - what bill_subscription_instalment's answer means for the cron's report;
 *   - the reminder ladder for an unpaid request — the invoice-dunning ladder (lib/invoices/dunning:
 *     Day 1 / 3 / 7 / 14 after the bill date), reused rather than a third ladder, because a request
 *     is chased exactly like an unpaid bill; the renewals ladder counts DOWN to a renewal date,
 *     which a part request does not have;
 *   - when the subscription is paused for an unpaid request: the company's own opt-in setting
 *     (tenants.auto_suspend_on_overdue + overdue_suspend_days, the same as for unpaid invoices).
 */
import { decideDunning, dunningRank, type DunningStep } from "@/lib/invoices/dunning";
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

/** The steps an unpaid part request is chased with (the overdue ladder; no pre-due — it is made on its date). */
export type RequestReminderStep = Exclude<DunningStep, "pre_due" | "due_today">;

/**
 * Which reminder (if any) to send today for an unpaid request. `dueOn` is the part's bill date:
 * the request goes out that day, so Day 1 is the day after. Never repeats a step already sent
 * (dunningRank), and never sends one for a request that is closed or paid.
 */
export function requestReminderStep(args: {
  dueOn: string;
  todayISO: string;
  lastStep: string | null | undefined;
  open: boolean;
  amountDue: number;
}): RequestReminderStep | null {
  if (!args.open || args.amountDue <= 0) return null;
  const d = decideDunning(
    { dueDate: args.dueOn, status: "pending", amountDue: args.amountDue, lastStepSent: (args.lastStep ?? null) as DunningStep | null },
    new Date(`${args.todayISO}T12:00:00+05:30`),
  );
  if (d.step === "none" || !d.shouldSend) return null;
  if (d.step === "pre_due" || d.step === "due_today") return null;
  if (dunningRank(d.step) <= dunningRank(args.lastStep)) return null;
  return d.step as RequestReminderStep;
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
    new:           `Here is the payment request for your next part: ${a.part}.`,
    reminder:      `A reminder: the payment for ${a.part} was due on ${a.dueOn}.`,
    retry:         `We have not yet received the payment for ${a.part}, due on ${a.dueOn}.`,
    grace_warning: `The payment for ${a.part} is now a week late (due ${a.dueOn}). Please pay to keep the service running.`,
    final:         `Final notice: the payment for ${a.part} (due ${a.dueOn}) is still open. The service may be paused.`,
  };
  const subject = a.step === "new"
    ? `Payment request ${a.quoteId} — ${a.amount}`
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
 * on (tenants.auto_suspend_on_overdue), after its own "pause after N days" and after the final
 * reminder went out — the same promise the invoice pause keeps (R-116 / R-1538).
 */
export function requestPauseDue(a: {
  companyOn: boolean;
  suspendDays: number;
  dueOn: string;
  todayISO: string;
  lastStep: string | null | undefined;
  open: boolean;
}): boolean {
  if (!a.companyOn || !a.open) return false;
  if (dunningRank(a.lastStep) < dunningRank("final")) return false;
  const late = daysBetweenISO(a.dueOn, a.todayISO);
  /* Never sooner than the final reminder (Day 14) + the 3 days' notice the invoice pause promises. */
  return late > Math.max(1, a.suspendDays, 14 + 3);
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
