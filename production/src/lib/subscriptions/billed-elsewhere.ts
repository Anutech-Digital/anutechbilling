/**
 * R-1763 — a subscription imported from Zoho Books: where it came from, and which of its
 * billing periods Zoho already billed.
 *
 * The import stores the Zoho invoice its current term came from (external_ref + its date) and
 * billed_externally_until = the imported renewal date (inclusive). Every billing period that
 * starts on or before that day was billed in Zoho: the schedule shows "Billed in Zoho · INV-…"
 * instead of "date passed", the billing cron never lays or raises it, and the database refuses
 * it too (trigger subscription_billings_not_billed_elsewhere). The next term is billed here as
 * usual. null billed_externally_until = made here, nothing billed elsewhere.
 *
 * R-2097 — the same columns carry an OPENING subscription (Add Subscription → "Opening —
 * already billed & paid before using this app"): external_source 'opening', billed outside this
 * app until its renewal date, nothing owed here.
 */
import { formatDate } from "@/lib/utils";

export interface ExternalSourceFields {
  external_source?: string | null;
  external_ref?: string | null;
  external_ref_date?: string | null;
  billed_externally_until?: string | null;
}

/** R-2097: subscriptions.external_source for a subscription billed & paid before this app. */
export const OPENING_SOURCE = "opening";
/** R-2097: how such a subscription is named on screen (contract / schedule / toast). */
export const OPENING_LABEL = "Opening — billed outside this app";

const SYSTEM_NAME: Record<string, { long: string; short: string }> = {
  zoho_books: { long: "Zoho Books", short: "Zoho" },
  [OPENING_SOURCE]: { long: "outside this app (opening)", short: "outside this app" },
};

function systemOf(sub: ExternalSourceFields) {
  return sub.external_source ? (SYSTEM_NAME[sub.external_source] ?? { long: sub.external_source, short: sub.external_source }) : null;
}

/** "From Zoho Books · INV-000871 (22 Jun 2026)", "Opening — billed outside this app", or null for a subscription made here. */
export function externalSourceText(sub: ExternalSourceFields): string | null {
  const sys = systemOf(sub);
  if (!sys) return null;
  const ref = (sub.external_ref ?? "").trim();
  const date = sub.external_ref_date ? ` (${formatDate(sub.external_ref_date.slice(0, 10))})` : "";
  if (sub.external_source === OPENING_SOURCE) return ref ? `${OPENING_LABEL} · ${ref}${date}` : OPENING_LABEL;
  return ref ? `From ${sys.long} · ${ref}${date}` : `From ${sys.long}`;
}

/** True when the billing period starting on `periodStart` was billed outside this app. */
export function billedElsewhere(sub: ExternalSourceFields, periodStart: string): boolean {
  const until = (sub.billed_externally_until ?? "").slice(0, 10);
  return until !== "" && periodStart.slice(0, 10) <= until;
}

/** "Billed in Zoho · INV-000871" — the schedule row's tag for such a period. */
export function billedElsewhereLabel(sub: ExternalSourceFields): string {
  const sys = systemOf(sub);
  const ref = (sub.external_ref ?? "").trim();
  return `Billed ${sys?.short === "outside this app" ? "" : "in "}${sys?.short ?? "another system"}${ref ? ` · ${ref}` : ""}`;
}
