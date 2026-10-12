import { describe, it, expect } from "vitest";
import {
  matchQuotesToEnquiry, weakestBasis, basisCaveat, type QuoteCandidate,
} from "./quote-match";

const q = (over: Partial<QuoteCandidate> & { id: string }): QuoteCandidate => ({
  createdAt: "2026-08-18T03:00:00.000Z", amount: 134138, ...over,
});

/**
 * The two rows this module was written for. Both real, both in ANUTECH's live books,
 * both ₹1,34,138, fifteen minutes apart — and BOTH invisible to a lead_id match.
 */
const LIVE_DUPLICATES: QuoteCandidate[] = [
  q({ id: "Q-ADPL-2026-27-0010", leadId: null, customerId: null, customerName: "Pardeep Sharma" }),
  q({ id: "Q-ADPL-2026-27-0011", leadId: null, customerId: null, customerName: "Pardeep Sharma",
      createdAt: "2026-08-18T03:16:00.000Z" }),
];

describe("the duplicates a lead_id match could not see", () => {
  it("finds both of them by name", () => {
    const m = matchQuotesToEnquiry(
      { leadId: "L-MST0UUN1", names: ["Pardeep Sharma"] },
      LIVE_DUPLICATES,
    );
    expect(m.map((x) => x.id)).toEqual(["Q-ADPL-2026-27-0010", "Q-ADPL-2026-27-0011"]);
    expect(m.every((x) => x.via === "name")).toBe(true);
  });

  it("finds nothing when only the lead id is known and the quotes carry none", () => {
    /* The old behaviour, kept as a test so nobody quietly restores it. */
    expect(matchQuotesToEnquiry({ leadId: "L-MST0UUN1" }, LIVE_DUPLICATES)).toEqual([]);
  });
});

describe("which basis decided a match", () => {
  it("prefers the lead id when the quote carries one", () => {
    const m = matchQuotesToEnquiry(
      { leadId: "L-1", customerId: "C-1", names: ["Pardeep Sharma"] },
      [q({ id: "A", leadId: "L-1", customerId: "C-1", customerName: "Pardeep Sharma" })],
    );
    expect(m[0].via).toBe("lead");
  });

  it("falls to customer id when there is no lead", () => {
    const m = matchQuotesToEnquiry(
      { leadId: "L-1", customerId: "C-1", names: ["Pardeep Sharma"] },
      [q({ id: "A", leadId: null, customerId: "C-1", customerName: "Pardeep Sharma" })],
    );
    expect(m[0].via).toBe("customer");
  });

  it("counts each quote once, never twice for matching two ways", () => {
    const m = matchQuotesToEnquiry(
      { leadId: "L-1", customerId: "C-1", names: ["Pardeep Sharma"] },
      [q({ id: "A", leadId: "L-1", customerId: "C-1", customerName: "Pardeep Sharma" })],
    );
    expect(m).toHaveLength(1);
  });
});

/**
 * ─── THE NAME RULE IS EXACT, AND STAYS EXACT ────────────────────────────────
 * A guard that fires on "Sharma Traders" when the enquiry is from "Sharma Enterprises" is
 * a guard people learn to ignore, and an ignored warning is worse than none.
 */
describe("the name rule does not get clever", () => {
  it("ignores case and extra spaces — those are typing, not identity", () => {
    const m = matchQuotesToEnquiry(
      { names: ["Pardeep  Sharma"] },
      [q({ id: "A", customerName: "  pardeep sharma " })],
    );
    expect(m).toHaveLength(1);
  });

  it("does NOT match a different company that merely starts the same", () => {
    const m = matchQuotesToEnquiry(
      { names: ["Sharma Enterprises"] },
      [q({ id: "A", customerName: "Sharma Traders" })],
    );
    expect(m).toEqual([]);
  });

  it("does NOT match on a first name alone", () => {
    const m = matchQuotesToEnquiry(
      { names: ["Pardeep Sharma"] },
      [q({ id: "A", customerName: "Pardeep" })],
    );
    expect(m).toEqual([]);
  });

  it("refuses placeholder names that would tie the whole tenant together", () => {
    /* "Prospect" is what the builder saves when nobody typed a name. */
    for (const junk of ["Prospect", "customer", "N/A", "test", "-", "", "   "]) {
      expect(matchQuotesToEnquiry({ names: [junk] }, [q({ id: "A", customerName: junk })]))
        .toEqual([]);
    }
  });

  it("matches on the company as well as the contact", () => {
    /* A quote is usually filed under the company, and the email under the person. */
    const m = matchQuotesToEnquiry(
      { names: ["Pardeep Sharma", "Demo Co"] },
      [q({ id: "A", customerName: "Demo Co" })],
    );
    expect(m).toHaveLength(1);
  });

  it("survives a null or absent name on either side", () => {
    expect(matchQuotesToEnquiry({}, [q({ id: "A" })])).toEqual([]);
    expect(matchQuotesToEnquiry({ names: [null, undefined] }, [q({ id: "A", customerName: null })]))
      .toEqual([]);
  });
});

describe("the banner owns up to its weakest match", () => {
  it("reports 'name' when any match rests on a name", () => {
    const m = matchQuotesToEnquiry(
      { leadId: "L-1", names: ["Pardeep Sharma"] },
      [q({ id: "A", leadId: "L-1" }), q({ id: "B", customerName: "Pardeep Sharma" })],
    );
    /* NOT "lead" — the shakier match must not ride on the stronger one's confidence. */
    expect(weakestBasis(m)).toBe("name");
    expect(basisCaveat(weakestBasis(m))).toMatch(/check it is the same person/i);
  });

  it("adds no caveat when everything matched on an id", () => {
    const m = matchQuotesToEnquiry({ leadId: "L-1" }, [q({ id: "A", leadId: "L-1" })]);
    expect(weakestBasis(m)).toBe("lead");
    expect(basisCaveat(weakestBasis(m))).toBe("");
  });

  it("is null with nothing matched", () => {
    expect(weakestBasis([])).toBeNull();
    expect(basisCaveat(null)).toBe("");
  });
});
