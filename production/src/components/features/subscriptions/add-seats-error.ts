/**
 * R-450: what the Add seats dialog says when the server refuses.
 *
 * The route always answers JSON with an `error` sentence written for the operator. When it
 * does not (a proxy's HTML 502, an empty body), the dialog must still say that nothing
 * happened — Abhishek's Scenario 7 was a 503 that left the form open with no message at all.
 */

/** The add-seats route's success body. */
export interface AddSeatsOk {
  quoteId:   string;
  amount:    number;
  poId?:     string | null;
  replayed?: boolean;
}

export function addSeatsErrorMessage(status: number, body: unknown): string {
  const error = body && typeof body === "object" && "error" in body
    ? (body as { error: unknown }).error
    : null;
  if (typeof error === "string" && error.trim()) return error.trim();
  return `Seats not added (error ${status}). Nothing was changed and no quote was made. Try again in a minute; if it still fails, use Report a problem.`;
}
