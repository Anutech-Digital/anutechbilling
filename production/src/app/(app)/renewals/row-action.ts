/**
 * R-2232 (Zoho audit A8) — the ONE action a Renewals row offers, and the line that says why.
 *
 * Audit 31 Oct: a row whose renewal quote was already generated still offered Send now next to
 * "Open quote" (and could be read as "generate again"), and a row marked Renewed still showed
 * (disabled) Generate / Send now. Now:
 *
 *   renewal quote sent / viewed / accepted → "Renewal sent Q-x · due <date>" + Resend
 *   renewal quote generated, still a draft → "Renewal quote Q-x not sent yet · due <date>" + Send
 *   no renewal quote yet                   → Generate (and Send now, as before)
 *   Renewed / Won't renew / Service stopped → no Generate, no Send now
 *
 * Resend / Send are the existing Send now action (the send-now route mails the reminder WITH
 * the renewal quote — createOrGetRenewalQuote returns the linked one, never a second quote);
 * "Resend" / "Send" are the Send quote dialog's own labels. Due = the renewal date.
 */
import { formatDate } from "@/lib/utils";
import { isTerminalRenewal } from "./reminders";

export interface RowActionSub {
  renewal_state?: string | null;
  renewal_date: string | null;
  term_months?: number | null;
  status?: string | null;
  auto_renew?: boolean | null;
  renewal_quote_id: string | null;
}

export type RowAction =
  | { kind: "generate"; label: "Generate"; text: null; quoteId: null }
  | { kind: "resend"; label: "Resend"; text: string; quoteId: string }
  | { kind: "send"; label: "Send"; text: string; quoteId: string }
  | { kind: "none"; label: null; text: string | null; quoteId: string | null };

/**
 * R-2403: 'renewed' that is still true — the paid term has not reached its first reminder
 * (isTerminalRenewal, R-1562). A 'renewed' state left on a row whose date has PASSED is stale:
 * record_payment rolls renewal_date on when it is paid, so the new term is unpaid (Ravi Shankar,
 * billed monthly: "Expired 2d" + "Renewed — nothing to send" + "1 month due" on one row).
 */
export function isSettledRenewed(
  sub: { renewal_state?: string | null; renewal_date: string | null; term_months?: number | null },
  today: Date = new Date(),
): boolean {
  return sub.renewal_state === "renewed" && isTerminalRenewal(sub.renewal_state, sub.renewal_date, sub.term_months, today);
}

/**
 * @param quoteStatus the linked renewal quote's status when known (open renewal quotes are
 *        loaded with the page); null = not loaded — a linked quote is then treated as sent,
 *        so Generate is never offered a second time.
 */
export function renewalRowAction(
  sub: RowActionSub,
  quoteStatus: string | null,
  today: Date = new Date(),
): RowAction {
  if (sub.auto_renew === false) return { kind: "none", label: null, text: null, quoteId: null };   // R-2225: badge says Won't renew
  if (sub.renewal_state === "suspended" || sub.status === "suspended") {
    return { kind: "none", label: null, text: "Service stopped — reactivate it first", quoteId: null };
  }
  if (isSettledRenewed(sub, today)) {   // R-2403: a stale 'renewed' (date passed) is not renewed
    return { kind: "none", label: null, text: "Renewed — nothing to send", quoteId: null };
  }
  const q = sub.renewal_quote_id;
  if (!q) return { kind: "generate", label: "Generate", text: null, quoteId: null };
  const due = sub.renewal_date ? ` · due ${formatDate(sub.renewal_date)}` : "";
  if (quoteStatus === "draft") {
    return { kind: "send", label: "Send", text: `Renewal quote ${q} not sent yet${due}`, quoteId: q };
  }
  /* sent / viewed / accepted — or not loaded / a closed quote still linked: the customer has it. */
  return { kind: "resend", label: "Resend", text: `Renewal sent ${q}${due}`, quoteId: q };
}
