/**
 * R-2754 — a quote opened from Renewals finds its way back to the same Renewals tab.
 *
 * User audit, 14 Nov 2026: "Review renewal quote" opened /quotes/<id>/edit, the sidebar moved
 * to Sales › Quotes and there was no way back — after Save the owner landed on the quote, not
 * the queue (and lost the 8–30 tab). The Renewals buttons now add `?returnTo=<the Renewals URL
 * they were clicked on>`; the editor shows "Back to Renewals" and returns there after a save.
 *
 * Only a /renewals path is accepted (never an open redirect: no other path, host or scheme).
 */
import { isAppPath } from "@/lib/safe-path";

export const RETURN_TO_PARAM = "returnTo";
export const BACK_TO_RENEWALS_LABEL = "Back to Renewals";

/** The Renewals URL to go back to, or null when `raw` is not one. */
export function renewalsReturnTo(raw: string | null | undefined): string | null {
  if (!raw || !isAppPath(raw) || raw.length > 500) return null;
  return /^\/renewals(?:[?#]|$)/.test(raw) ? raw : null;
}

/** The editor link for a quote opened from the Renewals page at `currentUrl`. */
export function quoteEditHrefFromRenewals(quoteId: string, currentUrl: string | null | undefined): string {
  const base = `/quotes/${encodeURIComponent(quoteId)}/edit`;
  const back = renewalsReturnTo(currentUrl);
  return back ? `${base}?${RETURN_TO_PARAM}=${encodeURIComponent(back)}` : base;
}
