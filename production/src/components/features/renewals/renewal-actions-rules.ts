/**
 * R-2401 — the ONE set of renewal actions, used on the Renewals cards/table AND on Payment
 * Follow-up's renewal rows (Pardeep, 3 Nov: "Generate click karne par kya hota hai — yahan send
 * renewal quote ka option hona chahiye", "koi renew na karana chahe to yahan se kaise cancel").
 *
 *   Send renewal quote          = the old "Send now": /api/renewals/send-now creates the renewal
 *                                 quote if missing and emails it (same confirm as before).
 *   Create quote (don't send)   = the old "Generate": /api/subscriptions/[id]/generate-renewal-quote.
 *   Bill next part              = Generate on a subscription billed in parts (R-2095) — a whole-term
 *                                 renewal quote would bill twice (R-808), so send-now refuses it and
 *                                 the row offers only this. R-2548: when that part is part 1 of the
 *                                 NEXT term it reads "Bill renewal · part 1 of next year / term" with
 *                                 the line "Renewal for <term> · <seats> × ₹<rate>" (nextPartToBill).
 *   Customer not renewing       = before the renewal date: Won't renew (NonRenewingDialog);
 *                                 after it (expired / in grace / stopped): Cancel subscription
 *                                 (CancelSubscriptionDialog, with a reason).
 *   Grace over — owner decides  → "Renew anyway" (VendorHoldBadge, R-1796) and "Cancel" side by side.
 *
 * R-2232 is kept: the row's ONE action comes from renewalRowAction — once a renewal quote exists
 * nothing offers to create another one. Pure rules here (tested in renewal-actions-rules.test.ts).
 */
import { renewalRowAction, isSettledRenewed, type RowAction, type RowActionSub } from "@/app/(app)/renewals/row-action";
import { isSplitBilled } from "@/lib/billing/instalments";
import { followingTermStart, termAmountOf } from "@/lib/billing/subscription-schedule";
import { addDaysISO, addMonthsClamped, CYCLE_MONTHS } from "@/lib/billing/schedule";
import { defaultSeatRate, periodText } from "@/lib/billing/proforma";
import { effectiveGraceDays } from "@/lib/renewals/cadence";
import { isFlexNextPart } from "@/lib/renewals/buckets";
import { rupee } from "@/lib/utils";
import type { BillingCycle } from "@/lib/supabase/database.types";

export const SEND_RENEWAL_QUOTE = "Send renewal quote";
export const RESEND_RENEWAL_QUOTE = "Resend renewal quote";
export const CREATE_QUOTE_NO_SEND = "Create quote (don't send)";
export const BILL_NEXT_PART = "Bill next part";
/** R-2548: the next part to bill is part 1 of the NEXT term — the renewal (a 12-month term / any other). */
export const BILL_RENEWAL_YEAR = "Bill renewal · part 1 of next year";
export const BILL_RENEWAL_TERM = "Bill renewal · part 1 of next term";
export const CUSTOMER_NOT_RENEWING = "Customer not renewing";
export const CANCEL_LABEL = "Cancel";

export interface RenewalActionSub extends RowActionSub {
  id: string;
  billing_cycle?: string | null;
  grace_until?: string | null;
  /** R-2548: for the renewal line "Renewal for <term> · <seats> × ₹<rate>" (all optional — the line shrinks without them). */
  start_date?: string | null;
  seats?: number | null;
  mrr?: number | null;
  term_amount?: number | null;
}

export interface NextPartToBill {
  /** The button: BILL_NEXT_PART, or BILL_RENEWAL_YEAR / BILL_RENEWAL_TERM when the part starts a new term. */
  label: string;
  renewal: boolean;
  /** The small line under a renewal button; null for a mid-term part. */
  note: string | null;
}

/**
 * R-2548 (Pardeep, 7 Nov 2026): an annual commitment paid half-yearly / quarterly / monthly read
 * "Bill next part" mid-year AND at the end of the year — but the end-of-year click bills part 1 of
 * the NEXT term at today's seats × rate: it IS the renewal, so the button says so.
 *
 * The next part to bill = the first part of the current term whose start has not passed, else
 * (every part has started — the billing job billed each on its day, R-2044) part 1 of the
 * following term; past the renewal date the oldest unbilled part is that same part 1
 * (billDueTermsOldestFirst rolls one term and bills it). A flex term (1 month billed monthly, one
 * part a term) keeps "Bill next part" — "part 1 of next term" would say nothing there.
 *
 * `daysUntil` = IST days to renewal_date (negative = past), so today = renewal_date − daysUntil.
 * Pure — the real periods (laid rows, requests, freed parts) are the server's (bill-next.server.ts)
 * and the Bill next part dialog shows them before anything is made.
 */
export function nextPartToBill(sub: RenewalActionSub, daysUntil: number): NextPartToBill {
  const next: NextPartToBill = { label: BILL_NEXT_PART, renewal: false, note: null };
  const cycle = (sub.billing_cycle ?? null) as BillingCycle | null;
  if (!isSplitBilled(cycle) || !cycle || !sub.renewal_date) return next;
  const termMonths = Math.max(1, sub.term_months ?? 12);
  const parts = Math.floor(termMonths / CYCLE_MONTHS[cycle]);
  if (parts <= 1) return next;

  const termStart = followingTermStart({ term_months: termMonths, start_date: sub.start_date ?? null, renewal_date: sub.renewal_date });
  const today = addDaysISO(sub.renewal_date.slice(0, 10), -daysUntil);
  /* The current term's LAST part (it starts latest) still ahead or starting today → that part, not
     the renewal (every earlier part starts before it). */
  if (addMonthsClamped(termStart, -CYCLE_MONTHS[cycle]) >= today) return next;

  const termEnd = addDaysISO(addMonthsClamped(termStart, termMonths), -1);
  const partEnd = addDaysISO(addMonthsClamped(termStart, CYCLE_MONTHS[cycle]), -1);
  const partTaxable = Math.round(termAmountOf({ mrr: sub.mrr ?? 0, term_months: termMonths, term_amount: sub.term_amount ?? null }) / parts);
  const seats = sub.seats ?? 0;
  const rate = seats > 0 ? defaultSeatRate({ seats, partTaxable }) : null;
  /* R-2548 review: the price sits next to PART 1's own dates — next to the whole term it read as the yearly price. */
  const money = rate != null ? `: ${seats} × ${rupee(rate)}` : partTaxable > 0 ? `: ${rupee(partTaxable)} + GST` : "";
  return {
    label: renewalLabel(termMonths),
    renewal: true,
    note: `Renewal for ${periodText(termStart, termEnd)} · part 1 (${periodText(termStart, partEnd)})${money}`,
  };
}

function renewalLabel(termMonths: number): string {
  return termMonths === 12 ? BILL_RENEWAL_YEAR : BILL_RENEWAL_TERM;
}

/**
 * R-2548 review: the Bill next part dialog's title follows what the SERVER will bill (its preview's
 * first period), not the row's calendar guess — a missed or freed part of the current term is
 * billed first (firstUnbilledPeriod), and that is not the renewal; a part the billing job already
 * raised this morning makes the click bill the renewal. Before the preview loads: the row's label.
 */
export function billPartDialogTitle(sub: RenewalActionSub, rowLabel: string, previewFirstStart: string | null | undefined): string {
  const cycle = (sub.billing_cycle ?? null) as BillingCycle | null;
  if (!previewFirstStart || !isSplitBilled(cycle) || !cycle || !sub.renewal_date) return rowLabel;
  const termMonths = Math.max(1, sub.term_months ?? 12);
  if (Math.floor(termMonths / CYCLE_MONTHS[cycle]) <= 1) return BILL_NEXT_PART;
  const termStart = followingTermStart({ term_months: termMonths, start_date: sub.start_date ?? null, renewal_date: sub.renewal_date });
  return previewFirstStart.slice(0, 10) === termStart ? renewalLabel(termMonths) : BILL_NEXT_PART;
}

export type RenewalButtonKind = "send-now" | "generate";

export interface RenewalActionSet {
  /** R-2232: the row's one action (and its "Renewal sent Q-x · due …" line). */
  row: RowAction;
  primary: { kind: RenewalButtonKind; label: string } | null;
  secondary: { kind: "generate"; label: string } | null;
  /** Which existing dialog "Customer not renewing" opens; null = not offered. */
  notRenewing: { label: string; dialog: "non-renewing" | "cancel" } | null;
  /** Grace ended unpaid — "Renew anyway" and "Cancel" side by side. */
  graceOver: boolean;
  /** R-2548: the small line under a "Bill renewal · part 1 of …" button ("Renewal for <term> · <seats> × ₹<rate>"); else null. */
  note: string | null;
  /** R-2548: the primary button bills part 1 of the next term (the renewal). */
  renewal: boolean;
}

/** Past the renewal date AND past the (company / owner-extended) grace — the owner decides. */
export function isGraceOver(
  sub: Pick<RenewalActionSub, "renewal_date" | "grace_until">,
  daysUntil: number,
  tenantGraceDays: number,
): boolean {
  if (daysUntil >= 0 || !sub.renewal_date) return false;
  const grace = effectiveGraceDays({ tenantGraceDays, renewalDate: sub.renewal_date, graceUntil: sub.grace_until ?? null });
  return Math.abs(daysUntil) > grace;
}

export function renewalActionSet(
  sub: RenewalActionSub,
  quoteStatus: string | null,
  opts: { daysUntil: number; tenantGraceDays: number; canEndSubscription: boolean },
): RenewalActionSet {
  const row = renewalRowAction(sub, quoteStatus);
  const split = isSplitBilled((sub.billing_cycle ?? null) as BillingCycle | null);

  let primary: RenewalActionSet["primary"] = null;
  let secondary: RenewalActionSet["secondary"] = null;
  let note: string | null = null;
  let renewal = false;
  /* R-2422: a monthly flex part not yet due is raised by the billing job on its date (R-2044) —
     "Bill next part" before then would re-bill the current term, so nothing to bill yet. */
  const flexNotDue = isFlexNextPart(sub, opts.daysUntil);
  if (row.kind === "generate" && flexNotDue) {
    /* no button here — renewalNextStep makes it Follow-up */
  } else if (row.kind === "generate") {
    if (split) {
      /* R-2548: part 1 of the next term is the renewal — the button and its line say so. */
      const part = nextPartToBill(sub, opts.daysUntil);
      primary = { kind: "generate", label: part.label };
      note = part.note;
      renewal = part.renewal;
    } else {
      primary = { kind: "send-now", label: SEND_RENEWAL_QUOTE };
      secondary = { kind: "generate", label: CREATE_QUOTE_NO_SEND };
    }
  } else if (row.kind === "send") {
    primary = { kind: "send-now", label: SEND_RENEWAL_QUOTE };
  } else if (row.kind === "resend") {
    primary = { kind: "send-now", label: RESEND_RENEWAL_QUOTE };
  }

  const graceOver = isGraceOver(sub, opts.daysUntil, opts.tenantGraceDays);
  /* R-2403: a stale 'renewed' (its date has passed, the new term unpaid) is not ended. */
  const ended = sub.status === "cancelled" || isSettledRenewed(sub) || sub.auto_renew === false;
  let notRenewing: RenewalActionSet["notRenewing"] = null;
  if (opts.canEndSubscription && !ended) {
    notRenewing = opts.daysUntil < 0
      ? { label: graceOver ? CANCEL_LABEL : CUSTOMER_NOT_RENEWING, dialog: "cancel" }
      : { label: CUSTOMER_NOT_RENEWING, dialog: "non-renewing" };
  }

  return { row, primary, secondary, notRenewing, graceOver, note, renewal };
}

// ─── R-2422: one next-step button + a ⋯ menu ─────────────────────────────────

export const FOLLOW_UP = "Follow-up";

/** What the ⋯ menu may hold, in the order it shows (the ending action last). */
/* R-2519: "bill-ahead" — Bill next part (proforma preview) for a subscription billed in parts whose
   next part is not due yet, or whose cancelled proforma left a period to bill again. */
export type RenewalMenuItem = "bill-ahead" | "create-quote" | "followup" | "nudge" | "voice" | "not-renewing";

export interface RenewalNextStep {
  /** The ONE visible button: the R-2401 rule's primary, else Follow-up; null = nothing to do here. */
  button: { kind: RenewalButtonKind | "followup"; label: string } | null;
  menu: RenewalMenuItem[];
}

/**
 * R-2422 (Pardeep, 3 Nov — staging Renewals: six stacked buttons, ~4 rows a screen): the row
 * shows ONE next-step button and a ⋯ menu for the rest — Payment Follow-up's pattern (R-2408).
 * `followup` / `messaging` = the screen offers a Follow-up dialog / Nudge + Voice (Renewals does;
 * Payment Follow-up's renewal rows have their own Follow-up, so they pass neither).
 * Grace over keeps Renew anyway + Cancel side by side (R-2401), so Cancel is not in the menu.
 */
export function renewalNextStep(set: RenewalActionSet, offers: { followup: boolean; messaging: boolean }): RenewalNextStep {
  const button: RenewalNextStep["button"] = set.primary
    ?? (offers.followup ? { kind: "followup", label: FOLLOW_UP } : null);
  const menu: RenewalMenuItem[] = [];
  if (set.secondary) menu.push("create-quote");
  if (offers.followup && button?.kind !== "followup") menu.push("followup");
  if (offers.messaging) menu.push("nudge", "voice");
  if (set.notRenewing && !set.graceOver) menu.push("not-renewing");
  return { button, menu };
}
