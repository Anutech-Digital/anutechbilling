/* R-2922 (18 Nov 2026, Pardeep — staging Q-A378-27-0124: "ye renewal quotation ki tarah jaye"): a NEW part
   request's line also carries the subscription's catalogue item (item_id) and our cost, like a renewal
   quotation's line. Its name (R-2423) and its short label in the description (R-2865) do not change, so every
   reader of a part line keeps reading it — and the oldest lines (the label as the NAME, the product in the
   description) can now be shown by their product. */
import { describe, it, expect } from "vitest";
import { isPartShortLabel, partAdvanceOf, partLabelOf, partLineProductName } from "./part-requests";
import { requestMailPart } from "./part-request-chase.server";
import { withPartCosts } from "@/lib/quotes/part-cost";

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
