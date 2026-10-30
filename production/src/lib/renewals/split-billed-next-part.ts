/**
 * R-2095 (staging reconcile, 30 Oct 2026) — Renewals → Generate on a subscription billed in parts.
 *
 * Ravi Shankar (473 seats, billed monthly) and Greentin read "expired 29 days" since 1 Oct, and
 * Generate answered "billed monthly, each part gets its own invoice on its date" — but no part bill
 * existed, so month 2 could not be billed at all. R-808 is right that a whole-term renewal QUOTE
 * would bill twice; the answer to Generate is the NEXT PART's bill: roll the term on (what the
 * renewals cron does on the new term's first day — splitBilledRenewalStep) and bill the part that
 * is due (the billing job's own path: a payment request, or the tax invoice when it is paid).
 */
import type { SplitRenewalFields } from "./split-billed-renewal";
import { splitBilledRenewalStep } from "./split-billed-renewal";

/** The renewal_date after rolling every term that has begun by today (at most 24 terms). */
export function rolledRenewalDate(
  sub: SplitRenewalFields & { renewal_quote_id: string | null },
  todayISO: string,
): { renewalDate: string | null; rolls: number; heldBy: string | null } {
  let cur = { ...sub };
  let rolls = 0;
  for (let i = 0; i < 24; i++) {
    const step = splitBilledRenewalStep(cur, todayISO);
    if (step.kind === "held_open_quote") return { renewalDate: cur.renewal_date, rolls, heldBy: step.quoteId };
    if (step.kind !== "roll") break;
    cur = { ...cur, renewal_date: step.newRenewalDate };
    rolls++;
  }
  return { renewalDate: cur.renewal_date, rolls, heldBy: null };
}

export interface NextPartOutcome {
  raised: { period_index: number; invoice_id: string }[];
  requests: { period_index: number; quote_id: string }[];
  requestsOpen: { period_index: number; quote_id: string; status: string }[];
}

/** What Generate tells the owner, and where to go next (a request / invoice), or why nothing. */
export function nextPartMessage(customer: string | null, o: NextPartOutcome, skipReason: string | null):
  { ok: boolean; text: string; href: string | null } {
  const who = customer ?? "this customer";
  const inv = o.raised[0];
  if (inv) return { ok: true, text: `Tax invoice ${inv.invoice_id} raised for ${who}'s next part (it was paid).`, href: `/invoices/${inv.invoice_id}` };
  const req = o.requests[0];
  if (req) return { ok: true, text: `Payment request ${req.quote_id} made for ${who}'s next part. Its tax invoice is raised when it is paid.`, href: `/quotes/${req.quote_id}` };
  const open = o.requestsOpen[0];
  if (open) return { ok: true, text: `${who}'s next part already has payment request ${open.quote_id} (${open.status}).`, href: `/quotes/${open.quote_id}` };
  return { ok: false, text: skipReason ?? `Nothing is due yet for ${who} — the next part is billed on its date.`, href: null };
}
