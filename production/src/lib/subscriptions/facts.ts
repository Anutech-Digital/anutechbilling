/**
 * The handful of facts a subscription drawer has to state before anything else.
 *
 * ─── WHY ────────────────────────────────────────────────────────────────────
 * Abhishek, 19 Sep 2026: clicking a subscription row opened the CUSTOMER page, which is
 * a different object — it lists all of that customer's subscriptions, invoices and
 * payments, and nothing on it says which row you clicked. The row now opens the billing
 * drawer instead, which is about the subscription.
 *
 * But that drawer was built as a schedule forecast, not as a detail view: it showed the
 * plan, the domain, the projected billing dates and the amendment history, and none of
 * seats, revenue, status or what is owed. Reached from a MENU that was fine — you had
 * just read the row, so you knew those. Reached by clicking the row it now replaces, the
 * omission reads as "this subscription has no seats".
 *
 * ─── WHY A PURE FUNCTION ────────────────────────────────────────────────────
 * Every line here is a small formatting decision with a wrong answer that looks right:
 * 0 of 5 seats used is not "no data", an unknown seat count is not zero, and a paused
 * subscription still owing money must not read as settled. Those are worth testing, and
 * they cannot be tested inside a drawer that needs a Sheet, a router and a query client
 * to render.
 */
import { rupee } from "@/lib/utils";
import { subscriptionEnded } from "./renewal-display";

export interface SubscriptionFactsInput {
  seats: number | null | undefined;
  used: number | null | undefined;
  mrr: number | null | undefined;
  status: string | null | undefined;
  outstanding_amount: number | null | undefined;
}

export interface Fact {
  label: string;
  value: string;
  /** How to colour it. `plain` for neutral, `owed` for money outstanding. */
  tone: "plain" | "owed";
}

export function subscriptionFacts(sub: SubscriptionFactsInput): Fact[] {
  return [
    { label: "Status",  value: statusLabel(sub.status),           tone: "plain" },
    { label: "Seats",   value: seatsLabel(sub.seats, sub.used),   tone: "plain" },
    /* R-1685: an ended subscription earns nothing a month — "₹540/mo" on it read as live. */
    { label: "MRR",     value: subscriptionEnded(sub.status) ? "— (ended)" : `${rupee(sub.mrr ?? 0)}/mo`, tone: "plain" },
    { label: "Owed",    value: owedLabel(sub.outstanding_amount), tone: (sub.outstanding_amount ?? 0) > 0 ? "owed" : "plain" },
  ];
}

/** "Active", not "active" — this sits beside prose, not in a code block. */
function statusLabel(status: string | null | undefined): string {
  const s = (status ?? "").trim();
  if (!s) return "Unknown";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * "3 of 10 used" — or just the licensed count when usage was never synced.
 *
 * `used` is 0 for two different situations: nobody has logged in, and we have never
 * asked the vendor. The list column says NOT TRACKED for the second, and this must not
 * contradict it by reporting a confident "0 of 10 used". Only a non-null `used` above
 * zero is treated as a real measurement; 0 is shown as the licensed count alone, which
 * is true either way.
 */
function seatsLabel(seats: number | null | undefined, used: number | null | undefined): string {
  const licensed = seats ?? 0;
  if (licensed <= 0) return "—";
  const inUse = used ?? 0;
  if (inUse <= 0) return `${licensed} licensed`;
  return `${inUse} of ${licensed} used`;
}

/** Nothing owed reads as "Nothing", never as "₹0" — a zero invites a second look. */
function owedLabel(amount: number | null | undefined): string {
  const owed = amount ?? 0;
  return owed > 0 ? rupee(owed) : "Nothing";
}
