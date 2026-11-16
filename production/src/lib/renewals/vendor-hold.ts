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
import { daysBetween, formatDate } from "@/lib/utils";

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

// ─── R-2823: the vendor by name, the hold in words, the vendor's own renewal date ───────────────

const VENDOR_NAMES: Record<string, string> = { google: "Google", microsoft: "Microsoft", zoho: "Zoho" };

/** Google / Microsoft / Zoho by name; any other vendor (domain, hosting, other, support) → null. */
export function vendorName(vendor: string | null | undefined): string | null {
  return (vendor && VENDOR_NAMES[vendor]) || null;
}

/** Vendors that renew on their OWN date — only these get the "<vendor> renewal date" field. */
export function hasVendorTerm(vendor: string | null | undefined): boolean {
  return vendorName(vendor) !== null;
}

/** The Renewals row's hold, in words next to the lock icon: "Hold at Google — unpaid". */
export function vendorHoldWords(vendor: string | null | undefined): string {
  return `Hold at ${vendorName(vendor) ?? "vendor"} — unpaid`;
}

/**
 * The drawer's Terms line for the vendor's own renewal date (subscriptions.vendor_term_end).
 * null when not known or the same as our renewal date (one fact, one place). A date already
 * passed is stale (the vendor has renewed since) → say so and where to correct it.
 */
export function vendorTermWords(
  sub: { vendor?: string | null; renewal_date: string | null; vendor_term_end?: string | null },
  todayIst: string,
): string | null {
  const end = sub.vendor_term_end?.slice(0, 10);
  if (!end || end === sub.renewal_date?.slice(0, 10)) return null;
  const who = vendorName(sub.vendor) ?? "Vendor";
  if (end < todayIst) return `${who} renewal date ${formatDate(end)} has passed — update it in Subscriptions → Correct details`;
  return `${who} renews ${formatDate(end)}`;
}

/** subscriptions.vendor_term_end ("" when not known) — the column is newer than the generated types. */
export function vendorTermEndOf(sub: object): string {
  return ((sub as { vendor_term_end?: string | null }).vendor_term_end ?? "").slice(0, 10);
}
