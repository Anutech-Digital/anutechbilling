/**
 * R-2225 (Zoho Billing audit A1, 31 Oct 2026): "Won't renew" → Non-renewing.
 *
 * A customer says they will not renew. The subscription keeps running to its renewal date and
 * then ends: the renewals cron makes no renewal quote and sends no reminder for it (it reads
 * auto_renew = true only) and lapses it to 'expired' once the date has passed (RN-24). It leaves
 * the Renewals Urgent / Upcoming / Future lists and the sidebar badge, and is counted At risk.
 *
 * The flag is the existing `auto_renew = false` — set by set_subscription_non_renewing() with a
 * reason and the date the customer said it (migration 20261101135056), or by the customer from
 * the portal (set_subscription_auto_renew, no reason). Cancel → "At end of term" is the same call.
 */
import { formatDate } from "@/lib/utils";

export interface NonRenewingFields {
  status?: string | null;
  auto_renew?: boolean | null;
  renewal_date?: string | null;
  non_renew_reason?: string | null;
  non_renew_said_on?: string | null;
}

/** Live (active / paused) with auto-renew off. A cancelled or expired one has simply ended. */
export function isNonRenewing(s: NonRenewingFields): boolean {
  return s.auto_renew === false && (s.status === "active" || s.status === "paused");
}

/** "Non-renewing · ends 15 Dec 2026" — the renewal date is the last day of the paid term. */
export function nonRenewingLabel(s: Pick<NonRenewingFields, "renewal_date">): string {
  return s.renewal_date ? `Non-renewing · ends ${formatDate(s.renewal_date)}` : "Non-renewing";
}

/** The drawer's line under the pill: what the customer said and when. */
export function nonRenewingNote(s: NonRenewingFields): string {
  const reason = s.non_renew_reason?.trim();
  if (!reason) return "Auto-renew was turned off";
  return s.non_renew_said_on ? `Customer said on ${formatDate(s.non_renew_said_on)}: ${reason}` : `Customer said: ${reason}`;
}

export type PillKind = "success" | "warning" | "danger" | "muted";

/** The one status pill for a subscription row, card and drawer. */
export function subStatusPill(s: NonRenewingFields): { label: string; kind: PillKind; nonRenewing: boolean } {
  if (isNonRenewing(s)) return { label: nonRenewingLabel(s), kind: "warning", nonRenewing: true };
  const st = s.status ?? "";
  const label = st ? st.charAt(0).toUpperCase() + st.slice(1) : "—";
  const kind: PillKind =
    st === "active" ? "success" : st === "paused" ? "warning" : st === "cancelled" ? "danger" : "muted";
  return { label, kind, nonRenewing: false };
}

/** Why Generate renewal quote / Send now refuse — null when they may go ahead. */
export function renewalRefusal(s: Pick<NonRenewingFields, "auto_renew">): string | null {
  if (s.auto_renew !== false) return null;
  return "This subscription is marked Won't renew — the customer is not renewing, so no renewal quote or reminder goes out. If they changed their mind, press Undo Won't renew on the subscription first.";
}

/** The Won't renew dialog's check (the server applies the same rules). */
export function nonRenewingInputError(i: { reason: string; saidOn: string; today: string }): string | null {
  if (i.reason.trim().length < 5) return "Write why the customer will not renew (at least 5 characters).";
  if (!i.saidOn) return "Pick the date the customer told you.";
  if (i.saidOn > i.today) return "That date is in the future — pick today or an earlier date.";
  return null;
}

/** Cancel → "At end of term" needs a live, still-renewing subscription with a renewal date. */
export function canEndAtTermEnd(s: NonRenewingFields): boolean {
  return (s.status === "active" || s.status === "paused") && s.auto_renew !== false && !!s.renewal_date;
}
