/**
 * R-228 — the reference number the website shows after a quote or trial request.
 *
 * It is the APP's number, handed back by /api/enquiry as `reference` (the draft quote's
 * number on the Workspace path, else the lead id). The forms used to build AQ-/AT-YYYYMM-NNN
 * from a localStorage counter — every new browser started at 001, so two customers held the
 * same "number" and sales could not find either in the app. When the app gave no number, the
 * page says so in words; it never makes one up.
 */

/** The server's reference from a /api/enquiry answer, or "" when it sent none. */
export function enquiryReference(json: unknown): string {
  if (!json || typeof json !== "object") return "";
  const ref = (json as { reference?: unknown }).reference;
  return typeof ref === "string" ? ref.trim() : "";
}

/** The line shown where the reference number goes. */
export function referenceNote(ref: string, state: { received: boolean; ackSent: boolean }): string {
  if (ref) return `Ref ${ref}`;
  if (!state.received) return "Not registered yet — no reference number";
  return state.ackSent ? "Reference number will come by email" : "We will share your reference number when we call";
}
