import { describe, it, expect } from "vitest";
import {
  orphanState, orphanNote, isOrphan, isSubscriptionLine, subscriptionExpectation,
  missingLines, rebuildOutstanding, type OrphanInput,
} from "./orphan-quote";

/**
 * The live shape: a licence line plus a support-plan line. Q-ADPL-2026-27-0008.
 *
 * `commitment` was missing from this fixture until 22 Aug 2026 — not because the real
 * lines lack it, but because the module did not read it. Checked against the row: both
 * lines carry annual_yearly. The omission mattered, because it let every test pass while
 * isSubscriptionLine treated ANY priced line as recurring, and a paid Domain Registration
 * was reported as a missing subscription.
 */
const TWO_LINES = [
  { name: "Google Workspace Business Starter", qty: 12, rate: 1632, commitment: "annual_yearly" },
  { name: "ANUTECH DIGITAL PVT LTD Standard Support (Yearly)", qty: 1, rate: 9996, commitment: "annual_yearly" },
];

const q = (over: Partial<OrphanInput> = {}): OrphanInput => ({
  /* R-1686: money IS in (₹1,000 recorded). Until 19 Oct this fixture said invoiced + ₹0 and
     called it "money in" — the very shape "Invoice now (before payment)" leaves behind. */
  status: "accepted", paymentStatus: "invoiced", received: 1000,
  isRenewal: false, isAddSeats: false,
  lines: TWO_LINES, existingSubs: 2,
  ...over,
});

/**
 * ─── THE GUARD THAT KEEPS THIS WARNING WORTH READING ────────────────────────
 * An accepted quote with no money against it SHOULD have no subscription — record_payment
 * creates it when the money arrives. Two of ANUTECH's live accepted quotes are exactly
 * that shape, and flagging them would train the operator to ignore this warning before it
 * ever caught a real one.
 */
describe("an absent subscription is usually correct", () => {
  it("says nothing on an unpaid accepted quote", () => {
    for (const ps of ["none", "awaiting", null, undefined]) {
      const s = orphanState(q({ paymentStatus: ps, received: 0, existingSubs: 0 }));
      expect(s.kind, `payment_status ${ps}`).toBe("not-due");
      expect(isOrphan(s)).toBe(false);
      expect(orphanNote(s)).toBeNull();
    }
  });

  it("says nothing before acceptance", () => {
    for (const status of ["draft", "sent", "viewed", "rejected"]) {
      expect(orphanState(q({ status, existingSubs: 0 })).kind, status).toBe("not-due");
    }
  });

  it("says nothing on a RENEWAL — it extends, it does not create", () => {
    /* A second row here would double the MRR. */
    const s = orphanState(q({ isRenewal: true, existingSubs: 0 }));
    expect(s).toMatchObject({ kind: "not-due" });
    expect(s.kind === "not-due" && s.because).toMatch(/renewal/i);
  });

  it("says nothing on an ADD-SEATS top-up", () => {
    expect(orphanState(q({ isAddSeats: true, existingSubs: 0 })).kind).toBe("not-due");
  });

  it("says nothing when no line could become a subscription", () => {
    /* Reporting "missing" here would be inventing an expectation. */
    const s = orphanState(q({ lines: [{ name: "One-off setup fee", qty: 1, rate: 0 }], existingSubs: 0 }));
    expect(s.kind).toBe("not-due");
  });
});

describe("money in, nothing created", () => {
  it("is a fault, and counts what should exist", () => {
    const s = orphanState(q({ existingSubs: 0 }));
    expect(s).toEqual({ kind: "missing-all", expected: 2, paid: true });
    expect(isOrphan(s)).toBe(true);
  });

  it("believes a recorded payment over a stale status label", () => {
    /* The label is something somebody has to remember to move; the payments happened. */
    const s = orphanState(q({ paymentStatus: "awaiting", received: 45360, existingSubs: 0 }));
    expect(s.kind).toBe("missing-all");
  });

  it("states the CONSEQUENCE, not the condition", () => {
    /* "No subscription found" invites a shrug. "Will never be renewed" makes somebody
       press the button. */
    const note = orphanNote(orphanState(q({ existingSubs: 0 })))!;
    expect(note).toMatch(/ever chase its renewal/i);
    expect(note).toMatch(/missing from your MRR/i);
  });
});

/**
 * ─── THE HALF-LOSS A ZERO-CHECK MISSES ──────────────────────────────────────
 * One quote can create several subscriptions — a licence line plus a support-plan line is
 * the normal shape, and three of ANUTECH's quotes carry exactly two. So a check for
 * "is there one?" would pass a quote that had two and lost one, which is the WORSE case:
 * the quote still looks connected, so nobody looks again for a year.
 */
describe("some created, some gone", () => {
  it("is caught, and named apart from a total loss", () => {
    const s = orphanState(q({ existingSubs: 1 }));
    expect(s).toEqual({ kind: "missing-some", expected: 2, found: 1, paid: true });
    expect(isOrphan(s)).toBe(true);
    expect(orphanNote(s)).toContain("Only 1 of 2");
  });

  it("a zero-check would have passed this — the count is the point", () => {
    expect(orphanState(q({ existingSubs: 1 })).kind).not.toBe("healthy");
  });

  it("both present is healthy and silent", () => {
    const s = orphanState(q({ existingSubs: 2 }));
    expect(s).toEqual({ kind: "healthy", subs: 2 });
    expect(orphanNote(s)).toBeNull();
  });

  it("more subs than lines is healthy, not an error", () => {
    /* Seats added later can attach their own row. Crying "too many" would flag a normal
       history. */
    expect(orphanState(q({ existingSubs: 3 })).kind).toBe("healthy");
  });
});

describe("which lines are subscription-worthy", () => {
  it("needs a name, a quantity and a rate", () => {
    /* Every case carries an annual commitment so this test keeps testing what it says it
       tests. Without one they would all fail for the commitment reason instead, and the
       billable guard would be silently uncovered while the test still looked green. */
    const A = "annual_yearly";
    expect(isSubscriptionLine({ name: "GW Standard", qty: 10, rate: 864, commitment: A })).toBe(true);
    /* A zero-rate line is a freebie or a note — generate_invoice refuses a zero-value tax
       invoice for the same reason. */
    expect(isSubscriptionLine({ name: "Free onboarding", qty: 1, rate: 0, commitment: A })).toBe(false);
    expect(isSubscriptionLine({ name: "GW Standard", qty: 0, rate: 864, commitment: A })).toBe(false);
    expect(isSubscriptionLine({ name: "   ", qty: 1, rate: 100, commitment: A })).toBe(false);
    expect(isSubscriptionLine({})).toBe(false);
  });

  it("needs a commitment, and reads it the way record_payment does", () => {
    /* The rule that was missing. v_is_annual (record_payment line 242) is
       "not 'monthly' and not null" — mirrored exactly rather than paraphrased. */
    expect(isSubscriptionLine({ name: "Domain Registration", qty: 1, rate: 1500 })).toBe(false);
    expect(isSubscriptionLine({ name: "GW", qty: 1, rate: 864, commitment: null })).toBe(false);
    expect(isSubscriptionLine({ name: "GW", qty: 1, rate: 864, commitment: "  " })).toBe(false);
    /* Monthly counts as a subscription line since 20260822120000. It did not for the few
       hours between that migration and the one before it, and this assertion is flipped
       rather than deleted so the change of behaviour is on the record. */
    expect(isSubscriptionLine({ name: "GW", qty: 1, rate: 864, commitment: "monthly" })).toBe(true);
    expect(isSubscriptionLine({ name: "GW", qty: 1, rate: 864, commitment: " MONTHLY " })).toBe(true);
    expect(isSubscriptionLine({ name: "GW", qty: 1, rate: 864, commitment: "annual_yearly" })).toBe(true);
  });

  it("tells the three expectations apart", () => {
    expect(subscriptionExpectation({ name: "GW", qty: 1, rate: 864, commitment: "annual_yearly" })).toBe("annual");
    expect(subscriptionExpectation({ name: "GW", qty: 1, rate: 864, commitment: "monthly" })).toBe("monthly");
    expect(subscriptionExpectation({ name: "Domain Registration", qty: 1, rate: 1500 })).toBe("one-off");
  });

  it("counts the live two-line quote as two", () => {
    expect(TWO_LINES.filter(isSubscriptionLine)).toHaveLength(2);
  });
});

/**
 * ─── WHY RECOVERY CANNOT BLINDLY REPLAY THE INSERT ──────────────────────────
 * record_payment guards itself with `on conflict (tenant_id, quote_id, lower(domain)) do
 * nothing`, and that index is real — but PARTIAL: `WHERE domain IS NOT NULL`. A support
 * line has no domain, so it sits outside the index and a blind replay would invent a
 * second support subscription. Recovery works out what is missing itself.
 */
describe("which lines still need a subscription", () => {
  const LINES = [
    { name: "Google Workspace Business Starter", qty: 12, rate: 1632, domain: "BGYH.COM", commitment: "annual_yearly" },
    { name: "ANUTECH DIGITAL PVT LTD Standard Support (Yearly)", qty: 1, rate: 9996, commitment: "annual_yearly" },
  ];

  it("returns nothing when both already exist", () => {
    expect(missingLines(LINES, [
      { plan: "Google Workspace Business Starter", domain: "bgyh.com" },
      { plan: "ANUTECH DIGITAL PVT LTD Standard Support (Yearly)", domain: null },
    ])).toEqual([]);
  });

  it("matches the domain case-insensitively, like lower(domain) in the index", () => {
    const m = missingLines(LINES, [{ plan: "Google Workspace Business Starter", domain: "BgYh.CoM" }]);
    expect(m.map((l) => l.name)).toEqual(["ANUTECH DIGITAL PVT LTD Standard Support (Yearly)"]);
  });

  it("finds the DOMAIN-LESS support line when only the licence survived", () => {
    /* The exact row the partial index cannot protect. */
    const m = missingLines(LINES, [{ plan: "Google Workspace Business Starter", domain: "bgyh.com" }]);
    expect(m).toHaveLength(1);
    expect(m[0].name).toMatch(/Standard Support/);
  });

  it("returns both when everything is gone", () => {
    expect(missingLines(LINES, [])).toHaveLength(2);
  });

  it("keeps two lines of the SAME plan on DIFFERENT domains apart", () => {
    /* Two Workspace lines for two domains are two real subscriptions. */
    const twoDomains = [
      { name: "Google Workspace Standard", qty: 5, rate: 864, domain: "one.com", commitment: "annual_yearly" },
      { name: "Google Workspace Standard", qty: 5, rate: 864, domain: "two.com", commitment: "annual_yearly" },
    ];
    const m = missingLines(twoDomains, [{ plan: "Google Workspace Standard", domain: "one.com" }]);
    expect(m).toHaveLength(1);
    expect(m[0].domain).toBe("two.com");
  });

  it("counts duplicates rather than de-duplicating them", () => {
    /* Two identical lines with one subscription means one is still missing — a Set would
       report zero and leave the gap open. */
    const twice = [
      { name: "Support", qty: 1, rate: 100, commitment: "annual_yearly" },
      { name: "Support", qty: 1, rate: 100, commitment: "annual_yearly" },
    ];
    expect(missingLines(twice, [{ plan: "Support", domain: null }])).toHaveLength(1);
  });

  it("ignores lines that were never subscription-worthy", () => {
    expect(missingLines([{ name: "Free setup", qty: 1, rate: 0 }], [])).toEqual([]);
  });
});


/* ── The two bug reports of 22 Aug 2026 ─────────────────────────────────────
   Both were filed by a tester because a paid quote produced no subscription and the app
   said nothing. One was correct behaviour, one is a real gap, and before this change the
   module could not tell them apart — it called BOTH a missing subscription. */
describe("the two reports a tester filed", () => {
  it("stops calling a paid one-off a missing subscription", () => {
    /* Q-TEST-2026-27-0002: Domain Registration, paid, no subscription — correct. The old
       code said "paid but has no subscription, so nothing will ever chase its renewal",
       which sent someone hunting for a fault that was not there. */
    const s = orphanState(q({
      lines: [{ name: "Domain Registration", qty: 1, rate: 1500 }],
      existingSubs: 0, received: 1770,
    }));
    expect(s.kind).toBe("not-due");
    expect(isOrphan(s)).toBe(false);
    expect(orphanNote(s)).toBeNull();
  });

  it("treats a paid monthly plan with no subscription as a plain fault", () => {
    /* Q-TEST-2026-27-0009: Google Workspace, monthly, Rs 38,232 paid in full, no
       subscription. When first written this returned its own "monthly-untracked" state,
       because record_payment genuinely never created one and "a subscription should
       exist" would have been false. Two migrations later it does create one, so this is
       now an ordinary missing subscription — a STRONGER claim than before, and one the
       operator can act on with the Recreate button. */
    const s = orphanState(q({
      lines: [{ name: "Google Workspace Business Starter", qty: 10, rate: 3823, commitment: "monthly" }],
      existingSubs: 0, received: 38232,
    }));
    expect(s.kind).toBe("missing-all");
    expect(isOrphan(s)).toBe(true);
    expect(orphanNote(s)).toMatch(/paid but has no subscription/);
  });

  it("still leaves a paid one-off alone", () => {
    /* The half of the original pair that has NOT changed: a domain purchase needs no
       subscription and must not be reported as missing one. */
    const s = orphanState(q({
      lines: [{ name: "Domain Registration", qty: 1, rate: 1500 }],
      existingSubs: 0, received: 1770,
    }));
    expect(s.kind).toBe("not-due");
    expect(orphanNote(s)).toBeNull();
  });

  it("still catches the real fault it was written for", () => {
    /* An annual commitment, paid, and nothing created. This is the case the warning has
       always been for, and the change must not have quietened it. */
    const s = orphanState(q({ existingSubs: 0, received: 50000 }));
    expect(s.kind).toBe("missing-all");
    expect(isOrphan(s)).toBe(true);
  });
});

/**
 * R-1686 (19 Oct 2026): "Invoice now (before payment)" leaves payment_status 'invoiced' with
 * ₹0 received. The quote page said "This quote is paid but has no subscription" — nothing was
 * paid. The repair is still offered (an invoiced quote should have its subscription, so its
 * unpaid invoice is in Subscription dues), but the words only say "paid" when money is in.
 */
describe("R-1686: invoiced before payment is not paid", () => {
  const unpaidInvoiced = q({ paymentStatus: "invoiced", received: 0, existingSubs: 0 });

  it("is still a missing subscription, marked unpaid", () => {
    const s = orphanState(unpaidInvoiced);
    expect(s).toEqual({ kind: "missing-all", expected: 2, paid: false });
    expect(isOrphan(s)).toBe(true);
  });

  it("never says 'paid' when no money was received", () => {
    const note = orphanNote(orphanState(unpaidInvoiced))!;
    expect(note).not.toMatch(/\bpaid but\b/i);
    expect(note).toMatch(/invoiced but not paid yet/i);
    expect(note).toMatch(/Subscription dues/);
  });

  it("says 'paid' once money is in", () => {
    const note = orphanNote(orphanState(q({ paymentStatus: "invoiced", received: 38232, existingSubs: 0 })))!;
    expect(note).toMatch(/^This quote is paid but has no subscription/);
  });

  it("partial / received labels still count as paid", () => {
    for (const ps of ["partial", "received"]) {
      const s = orphanState(q({ paymentStatus: ps, received: 0, existingSubs: 0 }));
      expect(s, ps).toMatchObject({ kind: "missing-all", paid: true });
    }
  });
});

describe("R-1668: a one-time line is never a subscription line", () => {
  it("one_time is one-off", () => {
    expect(subscriptionExpectation({ name: "Setup and migration", qty: 1, rate: 2000, commitment: "one_time" })).toBe("one-off");
  });

  it("an annual quote with a one-time setup line expects ONE subscription", () => {
    const s = orphanState(q({
      existingSubs: 0,
      lines: [
        { name: "Google Workspace Business Starter", qty: 10, rate: 3000, commitment: "annual_yearly" },
        { name: "Setup and migration", qty: 1, rate: 2000, commitment: "one_time" },
      ],
    }));
    expect(s).toMatchObject({ kind: "missing-all", expected: 1 });
  });
});

describe("R-1686: a rebuilt subscription carries what is still owed", () => {
  it("is the unpaid invoice when nothing else carries it", () => {
    expect(rebuildOutstanding(38232, [])).toBe(38232);
  });
  it("is never counted twice with a surviving subscription", () => {
    expect(rebuildOutstanding(38232, [30000])).toBe(8232);
    expect(rebuildOutstanding(38232, [38232, 0])).toBe(0);
  });
  it("is 0 on a paid quote and never negative", () => {
    expect(rebuildOutstanding(0, [])).toBe(0);
    expect(rebuildOutstanding(100, [500])).toBe(0);
    expect(rebuildOutstanding(Number.NaN, [])).toBe(0);
  });
});
