/**
 * R-1796 — vendor renewal HOLD (part 2 of R-1621). Pure helpers, tested in vendor-hold.test.ts.
 *
 * The hold is DERIVED, never stored: a subscription that is active or paused, whose renewal
 * date is before today (IST calendar day) and whose term is not renewed, is waiting for the
 * customer's payment — the vendor renewal (Google / Microsoft / hosting / domain) stays on
 * hold until then. Paying the renewal rolls renewal_date forward (record_payment), so the
 * hold ends by itself.
 *
 * The app never renews at a vendor before payment (domain/hosting renewals are queued only
 * by record_payment; Google/Microsoft renew themselves — no API, R-338), so this is a badge
 * for the owner, not a block. "Renew anyway" (owner / manager, renew_anyway RPC) writes
 * vendor_hold_override_for = renewal_date and an activity_log row; it hides the badge for
 * THAT term only. The same rule is in supabase/migrations/…_r1796_vendor_hold_restore_task.sql
 * (renew_anyway refuses a renewal that is not on hold).
 */
import { daysBetween } from "@/lib/utils";

export interface VendorHoldInput {
  status:         string;
  renewal_date:   string | null;
  renewal_state:  string | null;
  /** Newer than the generated types — absent before the migration. */
  vendor_hold_override_for?: string | null;
}

export type VendorHoldState = "none" | "hold" | "overridden";

/** Owner and manager may press "Renew anyway"; everyone else sees whom to ask. */
export const RENEW_ANYWAY_ROLES = ["owner", "manager"] as const;
export function canRenewAnyway(role: string | null | undefined): boolean {
  return !!role && (RENEW_ANYWAY_ROLES as readonly string[]).includes(role);
}

export function vendorHoldState(sub: VendorHoldInput, today: Date = new Date()): VendorHoldState {
  if (sub.status !== "active" && sub.status !== "paused") return "none";
  if (!sub.renewal_date || sub.renewal_state === "renewed") return "none";
  if (daysBetween(today, sub.renewal_date) >= 0) return "none";
  return sub.vendor_hold_override_for === sub.renewal_date ? "overridden" : "hold";
}

export const VENDOR_HOLD_LABEL = "Payment due — vendor renewal on hold";
export const VENDOR_HOLD_TITLE =
  "The renewal date has passed and this term is not paid. Do not renew at the vendor yet — " +
  "the hold ends by itself when the payment is recorded.";
export const VENDOR_HOLD_OVERRIDDEN = "Renewed anyway — not paid yet";

export function renewAnywayPrompt(sub: { customer_name: string; plan: string | null }): {
  title: string; body: string; label: string; placeholder: string;
} {
  return {
    title: `Renew ${sub.customer_name} before payment?`,
    body:
      `${sub.plan ?? "This subscription"}: the renewal is not paid. Renewing anyway removes the hold for this term only — ` +
      "renew at the vendor yourself if it needs it (the app has no vendor access). The customer still owes the renewal and the reminders continue. " +
      "Your name and reason go into the activity log.",
    label: "Why renew before payment?",
    placeholder: "e.g. Customer paying by cheque on Friday",
  };
}

export function renewedAnywayToast(sub: { customer_name: string }): { title: string; description: string } {
  return {
    title: `${sub.customer_name}: hold removed for this term`,
    description: "Logged in the activity log. Record the payment when it comes in — Payments → Record payment.",
  };
}
