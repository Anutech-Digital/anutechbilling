/**
 * R-2852 — reminders for a renewal quote billed TOGETHER (R-2847 / R-2849).
 *
 * A together quote renews 2+ yearly subscriptions of one customer, and every member's
 * `renewal_quote_id` points at it. The renewals cron and Send now work per subscription, so
 * before this each member emailed (and WhatsApp'd) the SAME quote at its own reminder steps,
 * each saying the WHOLE quote amount against that one member's plan and seats.
 *
 * Now: the quote is reminded about ONCE per step, from its LEAD member — the member with the
 * earliest renewal term (then the lowest id) among those the run may remind about — and the
 * body lists every plan · seats · period plus the quote's own total. Other members skip with a
 * logged reason. A single renewal quote is untouched (no entry in the map → "single").
 *
 * Pure (no I/O): the cron / Send now read the link rows with together-reminder.server.ts.
 */
import { followingTermStart } from "@/lib/billing/subscription-schedule";
import { termEndInclusive } from "@/lib/billing/schedule";
import { formatIstDate } from "@/lib/dates/ist";
import { decideCadence, type RenewalState } from "./cadence";

/** renewal_email_log.recipient_email of a member's "billed together" skip row (the drawer reads it). */
export const TOGETHER_SKIP_RECIPIENT = "(billed together)";

/** One subscription on a together quote (a live renewal_quote_subscriptions row + its subscription). */
export interface TogetherMember {
  subscriptionId:  string;
  /** The term the quote renews (renewal_quote_subscriptions.renewal_term_date). */
  renewalTermDate: string;
  extensionMonths: number;
  lineNo:          number;
  /** The seats this member's part was priced for (link row), else the subscription's own. */
  seats:           number | null;
  plan:            string;
  startDate:       string | null;
  termMonths:      number | null;
}

export interface TogetherQuote {
  quoteId: string;
  members: TogetherMember[];
}

export type TogetherRole =
  | { kind: "single" }
  | { kind: "lead"; quote: TogetherQuote }
  | { kind: "member"; quote: TogetherQuote; leadId: string; reason: string };

const byTermThenId = (a: TogetherMember, b: TogetherMember) =>
  a.renewalTermDate < b.renewalTermDate ? -1
    : a.renewalTermDate > b.renewalTermDate ? 1
      : a.subscriptionId < b.subscriptionId ? -1 : a.subscriptionId > b.subscriptionId ? 1 : 0;

/**
 * The member that sends the quote's reminders: earliest renewal term, then lowest subscription id,
 * among the members `eligible` says this run may remind about (active, renewing, grace not over —
 * the cron passes that). A lead that is Won't renew / not active / past its grace (it only raises the
 * owner's Stop-service task, no email) hands over to the next — never "nobody". None → null.
 */
export function togetherLead(quote: TogetherQuote, eligible: (subscriptionId: string) => boolean = () => true): TogetherMember | null {
  return [...quote.members].filter((m) => eligible(m.subscriptionId)).sort(byTermThenId)[0] ?? null;
}

/**
 * This subscription's part in its linked quote's reminder. `togetherByQuote` holds only quotes with
 * live link rows; a subscription that is not one of its quote's members (stale link) is "single".
 */
export function togetherRole(
  subscriptionId: string,
  renewalQuoteId: string | null | undefined,
  togetherByQuote: ReadonlyMap<string, TogetherQuote>,
  eligible: (subscriptionId: string) => boolean = () => true,
): TogetherRole {
  const quote = renewalQuoteId ? togetherByQuote.get(renewalQuoteId) : undefined;
  if (!quote || !quote.members.some((m) => m.subscriptionId === subscriptionId)) return { kind: "single" };
  const lead = togetherLead(quote, eligible);
  if (!lead || lead.subscriptionId === subscriptionId) return { kind: "lead", quote };
  return {
    kind:   "member",
    quote,
    leadId: lead.subscriptionId,
    reason: `Billed together on renewal quote ${quote.quoteId} — its reminder goes once, with ${lead.plan} (subscription ${lead.subscriptionId}).`,
  };
}

/** The period a member's part buys — its own subscription's next term (R-2848's invoice rule). */
export function togetherMemberPeriod(m: TogetherMember): { from: string; to: string } | null {
  if (!/^\d{4}-\d{2}-\d{2}/.test(m.renewalTermDate ?? "")) return null;
  const from = followingTermStart({ term_months: m.termMonths ?? 12, start_date: m.startDate, renewal_date: m.renewalTermDate });
  return { from, to: termEndInclusive(from, Math.max(1, m.extensionMonths || 12)) };
}

/** "Business Standard · 20 seats · 1 Jan 2027 to 31 Dec 2027", one per member in the quote's line order. */
export function togetherPlanLines(quote: TogetherQuote): string[] {
  return [...quote.members]
    .sort((a, b) => a.lineNo - b.lineNo || byTermThenId(a, b))
    .map((m) => {
      const period = togetherMemberPeriod(m);
      const seats = m.seats != null ? ` · ${m.seats} ${m.seats === 1 ? "seat" : "seats"}` : "";
      return `${m.plan}${seats}${period ? ` · ${formatIstDate(period.from)} to ${formatIstDate(period.to)}` : ""}`;
    });
}

/** What the reminder says for a together quote: every plan, the seats added up, and the plan list. */
export function togetherTemplateFields(quote: TogetherQuote): { planName: string; seats: number; planLines: string[] } {
  const ordered = [...quote.members].sort((a, b) => a.lineNo - b.lineNo || byTermThenId(a, b));
  return {
    planName:  ordered.map((m) => m.plan).join(" + "),
    seats:     ordered.reduce((n, m) => n + (m.seats ?? 0), 0),
    planLines: togetherPlanLines(quote),
  };
}

/**
 * Past its grace today: the cron only raises the owner's Stop-service task for it and emails nothing,
 * so it cannot lead a together quote's reminders (togetherLead's `eligible`).
 */
export function pastGraceToday(s: { renewalDate: string; graceDays: number; renewalState: string | null; termMonths: number | null }): boolean {
  return decideCadence({
    renewalDate:  s.renewalDate,
    graceDays:    s.graceDays,
    currentState: (s.renewalState ?? "pending") as RenewalState,
    termMonths:   s.termMonths,
  }).targetState === "suspended";
}
