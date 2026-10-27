/**
 * R-1956 — the client side of POST /api/quotes/[id]/mark-sent, the ONE path that records a
 * quote as sent without emailing it ("Mark as sent", and the copy-link buttons on a draft).
 * Throws with the server's own words — for an approval block that is the gate's reason,
 * which the caller shows instead of copying a link the customer could not open.
 */
export interface MarkQuoteSentResult {
  quoteStatus: string;
  changed: boolean;
  leadMoved: boolean;
  leadReason: string | null;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export async function markQuoteSent(quoteId: string, fetchImpl: FetchLike = fetch): Promise<MarkQuoteSentResult> {
  const res = await fetchImpl(`/api/quotes/${encodeURIComponent(quoteId)}/mark-sent`, { method: "POST" });
  let json: Partial<MarkQuoteSentResult> & { error?: string } = {};
  try { json = await res.json(); } catch { /* non-JSON body — handled below */ }
  if (!res.ok) throw new Error(json.error ?? `Could not mark the quote as sent (${res.status})`);
  return json as MarkQuoteSentResult;
}

/** A link copied from a draft opens nothing (the accept page hides drafts) — so copy marks it sent first. */
export function copyNeedsMarkSent(quoteStatus: string | null | undefined): boolean {
  return quoteStatus === "draft";
}
