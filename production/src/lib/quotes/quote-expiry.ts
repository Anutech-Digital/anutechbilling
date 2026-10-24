/**
 * R-1679: when a quote's validity has ended — ONE rule for every screen.
 *
 * Nothing moves a quote's stored status to "expired" when its date passes (the renewals cron
 * only lapses subscriptions), so Q-5F40-27-0096 — "Valid until 18 Oct" — still showed the
 * customer a big "Accept this quote · ₹38,232" on 19 Oct, and staff still saw "Sent" with
 * "Mark accepted". The server already refused the accept (isQuoteExpired, lib/utils.ts).
 *
 * The rule, judged on the IST calendar day (the same instant isQuoteExpired uses — valid through
 * the whole of the last day in India):
 *   - a quote still WAITING for the customer (sent / viewed) whose expires_date is before today
 *     (IST) shows as "expired";
 *   - money outranks the date: a quote with a payment recorded or an invoice keeps its status
 *     (status-badge.ts reads the payment first anyway);
 *   - draft / accepted / rejected / expired are left as they are — an accepted quote is a deal,
 *     not an offer, and a draft was never sent.
 * Display only — the stored status is not changed here.
 */
import { istToday } from "@/lib/dates/ist";

export interface ExpiryFields {
  status: string;
  expires_date?: string | null;
  payment_status?: string | null;
  invoice_id?: string | null;
}

/** The quote's validity ended before `today` (IST). No expiry date = never ends. */
export function validityEnded(expiresDate: string | null | undefined, today: string = istToday()): boolean {
  if (!expiresDate) return false;
  return expiresDate.slice(0, 10) < today;
}

/** Days left INCLUDING today: the last valid day is 1, yesterday's expiry is 0 or less. Null = no date. */
export function validityDaysLeft(expiresDate: string | null | undefined, today: string = istToday()): number | null {
  if (!expiresDate) return null;
  const a = Date.parse(`${today}T00:00:00Z`);
  const b = Date.parse(`${expiresDate.slice(0, 10)}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000) + 1;
}

const WAITING = new Set(["sent", "viewed"]);
const MONEY = new Set(["partial", "received", "invoiced"]);

/** The status to SHOW (and act on for sending): "expired" once a waiting quote's date passed. */
export function shownQuoteStatus<S extends string>(q: ExpiryFields & { status: S }, today: string = istToday()): S | "expired" {
  if (!WAITING.has(q.status)) return q.status;
  if (q.invoice_id || (q.payment_status && MONEY.has(q.payment_status))) return q.status;
  return validityEnded(q.expires_date, today) ? "expired" : q.status;
}

/** True when the quote is shown as expired only because its date passed (stored status is still sent / viewed). */
export function expiredByDate(q: ExpiryFields, today: string = istToday()): boolean {
  return q.status !== "expired" && shownQuoteStatus(q, today) === "expired";
}
