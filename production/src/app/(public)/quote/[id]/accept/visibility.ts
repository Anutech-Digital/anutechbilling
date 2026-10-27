/**
 * May the public accept page show this quote to whoever holds the link?
 *
 * SEC-1: the unguessable `?t=` token must match — no token is "not found", the same as a
 * missing quote, so ids cannot be enumerated. A DRAFT is never shown: it is not meant for the
 * customer yet. R-1956: that is why "Copy link instead" / "Copy customer link" mark a draft as
 * sent first (POST /api/quotes/[id]/mark-sent) — a link copied from a draft was a dead link.
 */
import { quoteTokenMatches } from "@/lib/quotes/accept-token";

export function publicQuoteVisible(
  quote: { status: string | null; public_token: string | null } | null | undefined,
  token: string | null | undefined,
): boolean {
  if (!quote) return false;
  if (!quoteTokenMatches(token ?? undefined, quote.public_token)) return false;
  return quote.status !== "draft";
}
