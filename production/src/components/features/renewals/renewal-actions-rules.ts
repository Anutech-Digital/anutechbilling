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
 *                                 the row offers only this.
 *   Customer not renewing       = before the renewal date: Won't renew (NonRenewingDialog);
 *                                 after it (expired / in grace / stopped): Cancel subscription
 *                                 (CancelSubscriptionDialog, with a reason).
 *   Grace over — owner decides  → "Renew anyway" (VendorHoldBadge, R-1796) and "Cancel" side by side.
 *
 * R-2232 is kept: the row's ONE action comes from renewalRowAction — once a renewal quote exists
 * nothing offers to create another one. Pure rules here (tested in renewal-actions-rules.test.ts).
 */
import { renewalRowAction, type RowAction, type RowActionSub } from "@/app/(app)/renewals/row-action";
import { isSplitBilled } from "@/lib/billing/instalments";
import { effectiveGraceDays } from "@/lib/renewals/cadence";
import type { BillingCycle } from "@/lib/supabase/database.types";

export const SEND_RENEWAL_QUOTE = "Send renewal quote";
export const RESEND_RENEWAL_QUOTE = "Resend renewal quote";
export const CREATE_QUOTE_NO_SEND = "Create quote (don't send)";
export const BILL_NEXT_PART = "Bill next part";
export const CUSTOMER_NOT_RENEWING = "Customer not renewing";
export const CANCEL_LABEL = "Cancel";

export interface RenewalActionSub extends RowActionSub {
  id: string;
  billing_cycle?: string | null;
  grace_until?: string | null;
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
  if (row.kind === "generate") {
    if (split) primary = { kind: "generate", label: BILL_NEXT_PART };
    else {
      primary = { kind: "send-now", label: SEND_RENEWAL_QUOTE };
      secondary = { kind: "generate", label: CREATE_QUOTE_NO_SEND };
    }
  } else if (row.kind === "send") {
    primary = { kind: "send-now", label: SEND_RENEWAL_QUOTE };
  } else if (row.kind === "resend") {
    primary = { kind: "send-now", label: RESEND_RENEWAL_QUOTE };
  }

  const graceOver = isGraceOver(sub, opts.daysUntil, opts.tenantGraceDays);
  const ended = sub.status === "cancelled" || sub.renewal_state === "renewed" || sub.auto_renew === false;
  let notRenewing: RenewalActionSet["notRenewing"] = null;
  if (opts.canEndSubscription && !ended) {
    notRenewing = opts.daysUntil < 0
      ? { label: graceOver ? CANCEL_LABEL : CUSTOMER_NOT_RENEWING, dialog: "cancel" }
      : { label: CUSTOMER_NOT_RENEWING, dialog: "non-renewing" };
  }

  return { row, primary, secondary, notRenewing, graceOver };
}
