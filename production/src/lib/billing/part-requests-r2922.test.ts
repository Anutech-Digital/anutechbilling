/* R-2922 (18 Nov 2026, Pardeep — staging Q-A378-27-0124: "ye renewal quotation ki tarah jaye"): a NEW part
   request's line also carries the subscription's catalogue item (item_id) and our cost, like a renewal
   quotation's line. Its name (R-2423) and its short label in the description (R-2865) do not change, so every
   reader of a part line keeps reading it — and the oldest lines (the label as the NAME, the product in the
   description) can now be shown by their product. */
import { describe, it, expect } from "vitest";
import { isPartShortLabel, partAdvanceOf, partLabelOf, partLineProductName } from "./part-requests";
import { requestMailPart } from "./part-request-chase.server";
import { withPartCosts } from "@/lib/quotes/part-cost";
import { renewalCatalogCost, type RenewalCatalogRow } from "@/lib/renewals/renewal-catalog-cost";

const LABEL = "Payment for month 2 · 15 Oct–14 Nov 2026";
const NAME = "Google Workspace Business Starter · acme.in · 49 seats · 15 Oct–14 Nov 2026 (part 2 of 12)";
/** A line as the R-2922 migration writes it (supabase/tests/r2922_part_request_like_renewal.test.sql, case A). */
const NEW_LINE = {
  id: "part-2", name: NAME, description: LABEL, qty: 49, rate: 450, per_seat: true, cost: 300, one_time: true,
  item_id: "GW-STR-a37802c6", period_start: "2026-10-15", period_end: "2026-11-14",
};
/** The oldest shape (staging Q-A378-27-0124): the label is the name, the product is the description. */
const OLDEST_LINE = {
  id: "part-1", name: "Payment for month 1 · 1 Oct–31 Oct 2026", description: "Google Workspace Business Starter · 473 seats",
  qty: 1, rate: 63855, cost: 0, one_time: true,
};

describe("R-2922 a part line with item_id + cost — the readers of its name and label", () => {
  it("the label readers read the new line exactly as before", () => {
    expect(isPartShortLabel(NEW_LINE.description)).toBe(true);
    expect(isPartShortLabel(NEW_LINE.name)).toBe(false);
    expect(partLabelOf(NEW_LINE.name)).toBe("part 2 of 12");
    expect(partLabelOf(NEW_LINE.description)).toBe("month 2");
    expect(requestMailPart([NEW_LINE])).toBe(NAME);
    expect(requestMailPart([NEW_LINE, { ...NEW_LINE, id: "part-2-2" }])).toBe(LABEL);   // billed together: the short label
    expect(partAdvanceOf({ lines: [NEW_LINE], partShort: "Part 2 of 12", subscription: "Google Workspace Business Starter · acme.in" }))
      .toEqual({ what: "15 Oct–14 Nov 2026", part: "Part 2 of 12", subscription: "Google Workspace Business Starter · acme.in" });
  });

  it("a stored cost is kept — the quote page's on-screen fill (R-2423) only fills an unknown one", () => {
    const fill = () => 99_999;
    expect(withPartCosts([NEW_LINE], "B1", fill)[0].cost).toBe(300);
    expect(withPartCosts([{ ...NEW_LINE, cost: 0 }], "B1", () => 14_700)[0].cost).toBe(300);   // ₹14,700 over 49 seats
  });

  it("partLineProductName: the oldest line is shown by its product, not by 'Payment for month 1'", () => {
    expect(partLineProductName(OLDEST_LINE)).toBe("Google Workspace Business Starter · 473 seats");
    expect(partLineProductName({ name: "Advance payment for Q2 · 28 Jan–27 Apr 2027", description: "Zoho Mail · 5 seats" })).toBe("Zoho Mail · 5 seats");
    /* a line already named by its product (R-2423 and later) keeps its name */
    expect(partLineProductName(NEW_LINE)).toBeNull();
    /* nothing better to show: no description, or the description is a label too */
    expect(partLineProductName({ name: LABEL })).toBeNull();
    expect(partLineProductName({ name: LABEL, description: "  " })).toBeNull();
    expect(partLineProductName({ name: LABEL, description: LABEL })).toBeNull();
    expect(partLineProductName(null)).toBeNull();
  });
});

/* The database works the line's cost out (r2922_part_seat_cost) by the renewal quote's catalogue rule. The same
   catalogue rows as supabase/tests/r2922_part_request_like_renewal.test.sql (case C), priced here by the renewal
   quote's own code: a 12-month renewal's cost a seat ÷ 12 is the SQL test's cost a seat a month. */

describe("R-2922 the part line's cost is the renewal quote's catalogue rule (same rows as the SQL test)", () => {
  const row = (wholesale: number, prices: unknown, over: Partial<RenewalCatalogRow> = {}): RenewalCatalogRow =>
    ({ name: "Row", vendor: "google", msrp: 200, wholesale, prices, item_type: "subscription", ...over });
  const STR = row(290, { annual: { msrp: 450, wholesale: 300 }, monthly: { msrp: 540, wholesale: 360 } }, { msrp: 450 });
  const SLAB = row(120, { slabs: [{ minSeats: 1, maxSeats: 10, msrp: 200, wholesale: 110 }, { minSeats: 11, maxSeats: null, msrp: 180, wholesale: 100 }] });
  const BAD = row(120, { slabs: [{ minSeats: "one", maxSeats: 10, msrp: 200, wholesale: 110 }] });
  const GAP = row(120, { annual: { msrp: 200, wholesale: 125 }, slabs: [{ minSeats: 1, maxSeats: 10, msrp: 200, wholesale: 110 }, { minSeats: 20, maxSeats: null, msrp: 180, wholesale: 100 }] });
  const OPEN = row(120, { slabs: [{ minSeats: 1, maxSeats: 10, msrp: 200, wholesale: 110 }, { minSeats: 11, msrp: 180, wholesale: 100 }] });
  const aSeatAMonth = (r: RenewalCatalogRow, seats: number) => renewalCatalogCost(r, { termMonths: 12, seats }).perSeat / 12;

  it("annual commitment: the annual tier / the slab for the seats; a broken slab table → the flat price", () => {
    expect(aSeatAMonth(STR, 49)).toBe(300);
    expect(aSeatAMonth(SLAB, 10)).toBe(110);
    expect(aSeatAMonth(SLAB, 11)).toBe(100);
    expect(aSeatAMonth(SLAB, 5000)).toBe(100);
    expect(aSeatAMonth(BAD, 5)).toBe(120);
    expect(aSeatAMonth(GAP, 5)).toBe(125);
    expect(aSeatAMonth(GAP, 25)).toBe(125);
    /* an open band saved with no maxSeats key: the bands that have one still price; that band never matches */
    expect(aSeatAMonth(OPEN, 5)).toBe(110);
    expect(aSeatAMonth(OPEN, 12)).toBe(120);
  });

  it("a Flexible (1-month) term: the monthly tier", () => {
    expect(renewalCatalogCost(STR, { termMonths: 1, seats: 49 }).perSeat).toBe(360);
  });

  it("no wholesale → unknown (0), never a guess", () => {
    expect(renewalCatalogCost(row(0, {}), { termMonths: 12, seats: 5 })).toMatchObject({ known: false, perSeat: 0 });
    expect(renewalCatalogCost(null, { termMonths: 12, seats: 5 })).toMatchObject({ known: false, perSeat: 0 });
  });
});
