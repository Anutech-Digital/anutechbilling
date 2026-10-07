/**
 * R-379 (h) — what "Mark accepted" says about the customer.
 *
 * accept_quote reports `converted_now: true` whenever it linked the lead to a customer on
 * this call — whether it CREATED that customer or matched one that already existed
 * (match_existing_customer: same GSTIN, or same email + name). The toast said "customer
 * record created" in both cases, so on 7 Oct an existing customer was reported as new and
 * the owner went looking for a duplicate that was never made. The route now tells the two
 * apart (`matchedExisting`) and this words them.
 */
export interface AcceptedToastInput {
  convertedNow: boolean;
  /** True when the linked customer existed before this request. */
  matchedExisting?: boolean;
  customerName?: string | null;
}

export function acceptedToast(r: AcceptedToastInput): string {
  if (!r.convertedNow) return "Quote accepted · awaiting payment";
  if (r.matchedExisting) {
    const name = r.customerName?.trim();
    return name
      ? `Quote accepted · linked to ${name} · awaiting payment`
      : "Quote accepted · linked to existing customer · awaiting payment";
  }
  return "Quote accepted · customer record created · awaiting payment";
}

/** Margin for app-vs-database clock skew: a customer created inside this request's
 *  transaction is stamped at (about) the request time, never seconds before it. */
const SKEW_MS = 2000;

/** Was this customer row there before the request began? Unknown → false (the old wording). */
export function createdBeforeRequest(createdAt: string | null | undefined, requestStartedMs: number): boolean {
  if (!createdAt) return false;
  const t = Date.parse(createdAt);
  if (Number.isNaN(t)) return false;
  return t < requestStartedMs - SKEW_MS;
}
