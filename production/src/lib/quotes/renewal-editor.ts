/**
 * R-2727 — two rules of the quote editor for a RENEWAL quote (opened from Renewals → "Review
 * renewal quote", R-2710). Pure, so the screen and its tests read the same answer.
 *
 * 1. The line's "Starts" date. A renewal quote's lines carry no start_date (createRenewalQuote /
 *    createDomainRenewalQuote never set one) and record_payment does not read it for a renewal —
 *    it rolls the subscription's renewal_date by extension_months. The editor showed the raw empty
 *    box (dd-mm-yyyy). It now shows the date the renewal period starts — the SAME date the preview,
 *    PDF, email and accept page print (lineServicePeriod, R-1764; since the R-2727 review it follows
 *    billing's followingTermStart) — as fixed text: a box that changes nothing would be a lie.
 *
 * 2. The footer's approval step. A renewal line at cost 0 (a domain renewal — its cost is not
 *    known, R-388) needs the owner. The button said "Save & ask for approval" to the OWNER too, and
 *    the click only saved a draft. Now: whoever may clear it (canApprove — the quote page's
 *    "Review & decide" rule: the company's only owner with a written reason, or an approver who did
 *    not make the quote) gets "Save & open approval"; anyone else gets "Save & ask for approval",
 *    which really asks (requestApproval).
 */
import { lineServicePeriod, type LinePeriodContext, type LinePeriodLine } from "./service-period";
import { canApprove, type ApprovalRecord, type ApprovalRequirement } from "./approval";
import { domainLineYears } from "@/lib/provisioning/products";
import type { SaveAndSendPlan } from "./send-quote-email";

/** `date` null = no term start on this line ("—"): a one-time line, or an old renewal quote whose
 *  term date is unknown — never a guessed date. */
export type RenewalLineStart = { kind: "fixed"; date: string | null } | { kind: "editable" };

/**
 * The Starts cell of one line: on a renewal / extension quote EVERY line is fixed text — the
 * renewal period's first day (lineServicePeriod: billing's followingTermStart when the subscription
 * was read, R-2727 review) — because neither record_payment nor the PDF reads a renewal line's own
 * start_date (a line added to the quote gets today's date, which nothing uses). Elsewhere the usual
 * date box.
 */
export function renewalLineStart(line: LinePeriodLine, ctx: LinePeriodContext | null | undefined): RenewalLineStart {
  if (!ctx || (ctx.isRenewal !== true && ctx.isExtension !== true)) return { kind: "editable" };
  const p = lineServicePeriod(line, ctx);
  return { kind: "fixed", date: p ? p.from : null };
}

/** R-2713 part 1: the phone card shows Starts on the card (not inside "More") when the date
 *  matters — a renewal, a multi-year line, or a customer who already has a live subscription. */
export function startsOnCard(line: LinePeriodLine, ctx: LinePeriodContext | null | undefined, customerHasLiveSubscription: boolean): boolean {
  return renewalLineStart(line, ctx).kind === "fixed" || domainLineYears(line) > 1 || customerHasLiveSubscription;
}

/** A live subscription — the statuses same-product.ts (R-468) counts as live. */
export function customerHasLiveSubscription(
  customerId: string | null | undefined,
  subs: readonly { customer_id?: string | null; status?: string | null }[] | null | undefined,
): boolean {
  if (!customerId) return false;
  return (subs ?? []).some((s) => s.customer_id === customerId && (s.status === "active" || s.status === "paused"));
}

/** The renewal footer button's label when the viewer clears the approval themselves. */
export const RENEWAL_OPEN_APPROVAL_LABEL = "Save & open approval";
/** R-2727 review: who may approve could not be read — the button says so and stays off. */
export const RENEWAL_APPROVAL_CHECK_FAILED_LABEL = "Can't check approval — reload";

export type RenewalSendStep = Exclude<SaveAndSendPlan, "needs-approval"> | "open-approval" | "ask-approval";

export function renewalSendStep(plan: SaveAndSendPlan, viewerMayApprove: boolean): RenewalSendStep {
  if (plan !== "needs-approval") return plan;
  return viewerMayApprove ? "open-approval" : "ask-approval";
}

/**
 * May the person in the editor clear this quote's approval? The quote page's rule (canApprove) on
 * the same inputs: the company's active logins and quote_chain_makers. Either not loaded yet → no
 * (never offer an approval the server would refuse; trg_quote_approval_not_by_maker decides).
 */
export function viewerMayApproveInEditor(args: {
  viewer: { id: string; role: string | null | undefined } | null | undefined;
  record: ApprovalRecord;
  need: ApprovalRequirement;
  team: readonly { id: string; role: string | null | undefined; access_ends_on?: string | null }[] | undefined;
  makers: readonly string[] | undefined;
}): boolean {
  if (!args.viewer || !args.team || !args.makers) return false;
  return canApprove(args.viewer, { ...args.record, makers: args.makers }, args.need, args.team).allowed;
}
