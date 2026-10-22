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
 */
import { formatDate } from "@/lib/utils";

export interface ExternalSourceFields {
  external_source?: string | null;
  external_ref?: string | null;
  external_ref_date?: string | null;
  billed_externally_until?: string | null;
}

const SYSTEM_NAME: Record<string, { long: string; short: string }> = {
  zoho_books: { long: "Zoho Books", short: "Zoho" },
};

function systemOf(sub: ExternalSourceFields) {
  return sub.external_source ? (SYSTEM_NAME[sub.external_source] ?? { long: sub.external_source, short: sub.external_source }) : null;
}

/** "From Zoho Books · INV-000871 (22 Jun 2026)", or null for a subscription made here. */
export function externalSourceText(sub: ExternalSourceFields): string | null {
  const sys = systemOf(sub);
  if (!sys) return null;
  const ref = (sub.external_ref ?? "").trim();
  const date = sub.external_ref_date ? ` (${formatDate(sub.external_ref_date.slice(0, 10))})` : "";
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
  return `Billed in ${sys?.short ?? "another system"}${ref ? ` · ${ref}` : ""}`;
}
