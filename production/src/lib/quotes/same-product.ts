/**
 * R-468 (2) — a new quote for a product the customer already subscribes to.
 *
 * Abhishek's audit (9 Oct 2026): Sharma Traders had 10 Business Starter seats; a new quote
 * for 5 more went through with no word, and payment made a SECOND subscription — two renewal
 * dates, two renewal bills, for one Google Workspace domain. The builder now says so and
 * points to Add seats, which keeps one subscription and one date. It warns; it does not
 * block — a second domain can genuinely need its own subscription.
 */
export interface SubLike {
  id: string;
  customer_id: string | null;
  item_id: string | null;
  plan: string;
  seats: number;
  status: string;
  renewal_date: string | null;
  domain: string | null;
  customer_name: string;
}

export interface LineLike {
  item_id?: string | null;
  name: string;
  commitment?: string | null;
}

const LIVE = new Set(["active", "paused"]);

/** The customer's live subscriptions to a product that is on this quote. */
export function sameProductSubscriptions(
  customerId: string | null | undefined,
  lines: readonly LineLike[],
  subs: readonly SubLike[],
): SubLike[] {
  if (!customerId) return [];
  /* Only recurring lines can make a subscription — a one-time service cannot clash. */
  const recurring = lines.filter((l) => typeof l.commitment === "string" && l.commitment.trim() !== "");
  if (recurring.length === 0) return [];
  const ids = new Set(recurring.map((l) => l.item_id).filter((x): x is string => Boolean(x)));
  const names = new Set(recurring.map((l) => l.name.trim().toLowerCase()).filter(Boolean));
  return subs.filter((s) =>
    s.customer_id === customerId
    && LIVE.has(s.status)
    && ((s.item_id && ids.has(s.item_id)) || names.has(s.plan.trim().toLowerCase())),
  );
}

/** One sentence for the banner. */
export function sameProductNote(s: SubLike, renewsOn: string | null): string {
  const when = renewsOn ? `, renews ${renewsOn}` : "";
  return `This customer already has ${s.plan} (${s.seats} seat${s.seats === 1 ? "" : "s"}${when}). `
    + "Paying this quote makes a second subscription with its own renewal date. To keep one, use Add seats on that subscription.";
}
