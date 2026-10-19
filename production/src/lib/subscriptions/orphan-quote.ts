/**
 * Does this quote's subscription actually exist?
 *
 * ─── WHAT GOES WRONG WITHOUT THIS ───────────────────────────────────────────
 * A subscription is what makes a paid deal keep earning: it carries the renewal date,
 * the seat count and the MRR, and it is the row the renewal cron chases. Delete it — by
 * accident, or while tidying up test data — and the money does not stop, it just stops
 * being *known*. The customer keeps their mailboxes, the reseller keeps paying the
 * vendor, and nothing ever asks for the renewal. It is the quietest way this product can
 * lose a customer's annual revenue.
 *
 * ─── AN ABSENT SUBSCRIPTION IS USUALLY CORRECT, WHICH IS THE HARD PART ──────
 * An accepted quote with no money against it SHOULD have no subscription: `record_payment`
 * creates it when the money arrives. Two of ANUTECH's live accepted quotes are exactly
 * that shape (Q-2026-9776 and Q-2026-9778, both unpaid), and flagging them would train
 * the operator to ignore this warning before it ever caught a real one.
 *
 * So "missing" is only claimed when the subscription is DUE: money received, and the
 * quote is a new sale rather than a renewal or an add-seats top-up, both of which
 * deliberately attach to a subscription that already exists.
 *
 * ─── AND IT COUNTS, RATHER THAN ASKING "IS THERE ONE?" ──────────────────────
 * One quote can create SEVERAL subscriptions — a licence line plus a support-plan line is
 * the normal shape here, and three of ANUTECH's quotes carry exactly two. I nearly read
 * those as duplicates; they are one atomic write, to the microsecond.
 *
 * The consequence is that a check for "zero subscriptions" would miss the more likely
 * accident: two were created, one got deleted. That half-loss is worse than a total one,
 * because the quote still looks connected. So this compares the count of
 * subscription-worthy LINES against the subscriptions that exist.
 */

export interface QuoteLine {
  name?: string | null;
  qty?: number | null;
  rate?: number | null;
  /**
   * 'annual_yearly' | 'monthly' | null, as stored on the quote line.
   *
   * Added 22 Aug 2026 because its absence made this module confidently wrong. Without it
   * every priced line looked like a subscription line, so a paid Domain Registration was
   * reported as "paid but has no subscription, so nothing will ever chase its renewal" —
   * a false alarm on a one-off purchase, and the fastest way to teach an operator to skip
   * this warning before it ever catches a real one.
   */
  commitment?: string | null;
  /** R-1688: the builder's explicit One-time marker — never a subscription, whatever else the line says. */
  one_time?: boolean | null;
}

export interface OrphanInput {
  status: string;
  /** `quotes.payment_status`. 'none' and 'awaiting' both mean no money yet. */
  paymentStatus: string | null | undefined;
  /** ₹ actually received against this quote, across every recorded payment. */
  received: number;
  isRenewal: boolean | null | undefined;
  isAddSeats: boolean | null | undefined;
  lines: readonly QuoteLine[];
  /** Subscriptions whose `quote_id` is this quote. */
  existingSubs: number;
}

export type OrphanState =
  /** No subscription is due yet, and that is correct — not a fault. */
  | { kind: "not-due"; because: string }
  /** Everything the quote should have created exists. */
  | { kind: "healthy"; subs: number }
  /** Money is in (or the GST invoice is out, R-1686) and NOTHING was created. */
  | { kind: "missing-all"; expected: number; paid: boolean }
  /** Some were created and some are gone — the half-loss a zero-check misses. */
  | { kind: "missing-some"; expected: number; found: number; paid: boolean };

/* There was briefly a "monthly-untracked" state here, for the window in which monthly
   sales produced no subscription at all. 20260822120000 and 20260822140000 closed that,
   so a paid monthly quote with no subscription is now an ordinary missing one — same
   fault, same fix, same words. Removed rather than left as a branch that can no longer
   be reached: dead states get copied. */

/**
 * A line that should become a subscription.
 *
 * Quantity and rate must both be positive. A zero-rate line is a freebie or a note —
 * generate_invoice already refuses a zero-value tax invoice for the same reason — and a
 * zero-quantity line is a leftover row somebody cleared instead of deleting.
 */
export type LineExpectation =
  /** An annual commitment — record_payment creates a subscription for this. */
  | "annual"
  /** Recurring in intent, but record_payment creates nothing. A gap, not a fault. */
  | "monthly"
  /** A one-off charge, or a line too empty to bill. No subscription is due. */
  | "one-off";

/**
 * What this line should produce, judged the way `record_payment` actually judges it.
 *
 * The commitment test mirrors the RPC exactly (v_is_annual, line 242) rather than
 * describing what one might expect: anything other than 'monthly', and not null, is
 * treated as annual. Restating a database rule in slightly different words is how the two
 * come to disagree, and the disagreement is always discovered on a paid quote.
 */
export function subscriptionExpectation(l: QuoteLine): LineExpectation {
  const billable = (l.qty ?? 0) > 0 && (l.rate ?? 0) > 0 && Boolean((l.name ?? "").trim());
  if (!billable) return "one-off";
  /* R-1688: the explicit marker wins, as in quote_line_is_subscription (migration 20261019164713). */
  if (l.one_time === true) return "one-off";
  const c = l.commitment?.trim().toLowerCase();
  /* R-1668: a One-time line (setup, migration) is a one-off charge — never a subscription.
     file_invoiced_quote_subscriptions (R-1686) skips it the same way. */
  if (!c || c === "one_time") return "one-off";
  return c === "monthly" ? "monthly" : "annual";
}

/**
 * Monthly counts too, since 20260822120000. It did not when this function first learned
 * about commitments — record_payment created subscriptions for annual lines only — and for
 * a few hours this module correctly reported monthly as "not tracked". Two migrations
 * later that sentence became false, and a stale reassurance is worse than the original
 * silence: it tells somebody not to look.
 *
 * A one-off is still not a subscription line, and that is the distinction worth keeping.
 */
export function isSubscriptionLine(l: QuoteLine): boolean {
  return subscriptionExpectation(l) !== "one-off";
}

export function orphanState(input: OrphanInput): OrphanState {
  if (input.status !== "accepted") {
    return { kind: "not-due", because: "This quote has not been accepted yet." };
  }
  if (input.isRenewal) {
    /* A renewal rolls the EXISTING subscription's dates forward; it never creates a
       second one, and a new row here would double the MRR. */
    return { kind: "not-due", because: "A renewal extends the existing subscription rather than creating one." };
  }
  if (input.isAddSeats) {
    return { kind: "not-due", because: "An add-seats quote tops up the existing subscription rather than creating one." };
  }

  /* THE GUARD THAT KEEPS THIS WARNING WORTH READING.
     Read the received AMOUNT first and the status label second: the label is something
     somebody has to remember to move, the payments are what happened. */
  const paid = input.received > 0
    || input.paymentStatus === "received"
    || input.paymentStatus === "partial";
  /* R-1686: "Invoice now (before payment)" leaves 'invoiced' with ₹0 received. Since
     20261019162652 that path files the subscription (its unpaid invoice is the dues), so a
     missing one is still a fault worth the repair button — but it is NOT paid, and the
     sentence must not say so. */
  const invoiced = input.paymentStatus === "invoiced";
  if (!paid && !invoiced) {
    return {
      kind: "not-due",
      because: "No payment recorded yet — the subscription is created when the money arrives.",
    };
  }

  const expected = input.lines.filter(isSubscriptionLine).length;
  if (expected === 0) {
    /* A one-off charge. Reporting "missing" here would be inventing an expectation. */
    return { kind: "not-due", because: "Nothing on this quote is a recurring line." };
  }

  if (input.existingSubs === 0)        return { kind: "missing-all", expected, paid };
  if (input.existingSubs < expected)   return { kind: "missing-some", expected, found: input.existingSubs, paid };
  return { kind: "healthy", subs: input.existingSubs };
}

/** Is this a fault the operator has to act on? */
/**
 * Is this a fault — a subscription that should exist and does not?
 *
 * Deliberately FALSE for monthly-untracked: nothing is missing, the product does not make
 * one. Callers that want to tell the operator something should ask `orphanNote`, which
 * now speaks for that state too — see the note on `needsAttention`.
 */
export function isOrphan(s: OrphanState): boolean {
  return s.kind === "missing-all" || s.kind === "missing-some";
}


/**
 * The sentence the quote page shows.
 *
 * States the CONSEQUENCE, not the condition. "No subscription found" invites a shrug;
 * "this deal will never be renewed" is the fact that makes somebody press the button.
 */
export function orphanNote(s: OrphanState): string | null {
  switch (s.kind) {
    case "missing-all":
      if (!s.paid) {
        /* R-1686: invoiced before payment — say exactly that, never "paid". */
        return `This quote is invoiced but not paid yet, and has no subscription — so its unpaid invoice is missing from Subscription dues and nothing will chase its renewal. ${s.expected === 1 ? "One subscription" : `${s.expected} subscriptions`} should exist.`;
      }
      return `This quote is paid but has no subscription, so nothing will ever chase its renewal and it is missing from your MRR. ${s.expected === 1 ? "One subscription" : `${s.expected} subscriptions`} should exist.`;
    case "missing-some":
      /* Named separately because the quote still LOOKS connected — which is exactly why
         this one goes unnoticed for a year. */
      return `Only ${s.found} of ${s.expected} subscriptions from this quote still exist. The missing ${s.expected - s.found === 1 ? "one" : "ones"} will never be renewed and are absent from your MRR.`;
    case "not-due":
    case "healthy":
      return null;
  }
}

/* ── Which lines have no subscription yet ──────────────────────────────────── */

export interface ExistingSub {
  plan: string | null;
  domain: string | null;
}

/** Same normalisation the DB's unique index uses: `lower(domain)`. */
function key(plan: string | null | undefined, domain: string | null | undefined): string {
  return `${(plan ?? "").trim().toLowerCase()}|${(domain ?? "").trim().toLowerCase()}`;
}

/**
 * The subscription-worthy lines that do NOT already have a subscription.
 *
 * ─── WHY THE RECOVERY CANNOT JUST RE-RUN THE INSERT ─────────────────────────
 * `record_payment` protects itself with `on conflict (tenant_id, quote_id, lower(domain))
 * do nothing`. That index is real — but it is PARTIAL:
 *
 *     WHERE quote_id IS NOT NULL AND domain IS NOT NULL
 *
 * A support-plan line carries no domain (the live ANUTECH ones do not), so those rows sit
 * outside the index entirely and a blind replay would create a second support
 * subscription — inventing MRR out of a repair. Recovery therefore works out what is
 * missing itself and inserts only that.
 *
 * ─── MATCHED ON PLAN + DOMAIN, THE SAME PAIR THE INDEX USES ─────────────────
 * Two Workspace lines on one quote for two different domains are two real subscriptions,
 * so the domain has to be part of the key. Two lines with the same plan AND the same
 * domain are the same subscription and must not double.
 */
export function missingLines<T extends QuoteLine & { domain?: string | null }>(
  lines: readonly T[],
  existing: readonly ExistingSub[],
): T[] {
  /* A multiset, not a Set: if the quote genuinely has two identical lines and only one
     subscription exists, one is still missing. Counting is the only way to see that. */
  const have = new Map<string, number>();
  for (const s of existing) {
    const k = key(s.plan, s.domain);
    have.set(k, (have.get(k) ?? 0) + 1);
  }

  const out: T[] = [];
  for (const l of lines) {
    if (!isSubscriptionLine(l)) continue;
    const k = key(l.name, l.domain);
    const n = have.get(k) ?? 0;
    if (n > 0) have.set(k, n - 1);
    else out.push(l);
  }
  return out;
}

/* ── What a rebuilt subscription still owes (R-1686) ───────────────────────── */

/**
 * The outstanding to put on the FIRST rebuilt subscription.
 *
 * `openBalance` is what is still owed on the quote (quote_open_balance: its unpaid invoices,
 * or amount − money received when none is out). The surviving subscriptions of the same quote
 * may already carry some of it, so only the rest goes on the rebuilt row — the dues are never
 * counted twice. Whole rupees, never negative. It wrote 0 before R-1686, so an unpaid annual
 * invoice rebuilt from the quote never appeared in Payments → Subscription dues.
 */
export function rebuildOutstanding(openBalance: number, existingOutstanding: readonly number[]): number {
  const owed = Number.isFinite(openBalance) ? Math.round(openBalance) : 0;
  const carried = existingOutstanding.reduce((s, n) => s + (Number.isFinite(n) ? Math.max(0, n) : 0), 0);
  return Math.max(0, owed - carried);
}
