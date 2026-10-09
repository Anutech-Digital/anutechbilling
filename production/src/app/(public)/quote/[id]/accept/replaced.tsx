/**
 * What the customer sees on an OLD quote link once the quote was replaced (R-482 / R-448).
 *
 * Before, the old link still showed "Accept this quote · ₹57,348" after a revised quote had
 * gone out — accepting it would have billed the customer for the wrong quote. Now the page
 * says it was replaced and links to the new one. The new link carries the new quote's own
 * token; it is only offered when that quote has actually been sent (never a draft).
 */
import Link from "next/link";

export interface ReplacedBy {
  id: string;
  status: string;
  public_token: string | null;
}

/** Link to the replacing quote, or null when it is not out with the customer. */
export function replacementHref(next: ReplacedBy | null | undefined): string | null {
  if (!next || !next.public_token || next.status === "draft") return null;
  return `/quote/${encodeURIComponent(next.id)}/accept?t=${encodeURIComponent(next.public_token)}`;
}

export function QuoteReplaced(props: { quoteId: string; newId: string; href: string | null; tenantName: string }) {
  return (
    <main className="min-h-screen bg-paper flex items-center justify-center p-4">
      <div className="w-full max-w-md rounded-xl border border-hairline bg-paper-2 p-6 text-center space-y-3">
        <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold">{props.tenantName}</p>
        <h1 className="font-serif text-2xl text-ink">This quote was replaced</h1>
        <p className="text-sm text-ink-2">
          Quote {props.quoteId} was updated. Please review the latest version, {props.newId}.
        </p>
        {props.href ? (
          <Link
            href={props.href as never}
            className="inline-flex items-center justify-center rounded-md bg-amber px-4 py-2 text-sm font-semibold text-ink hover:opacity-90"
          >
            Open the latest quote
          </Link>
        ) : (
          <p className="text-sm text-ink-3">Your reseller will share the new quote with you.</p>
        )}
      </div>
    </main>
  );
}
