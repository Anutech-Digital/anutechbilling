/**
 * R-2028 (3) — "At least one line has no vendor cost" did not say WHICH line, so the owner of
 * Q-4786-27-0001 could not tell what to fix. The approval reason now names the line(s) and the
 * quote screen gets an "Add cost" button that opens that line's cost box.
 *
 * The approval RULE is untouched (requiredApproval still raises the owner tier on an unknown
 * cost — R-2213 / R-2344); only the words shown for that reason change.
 */
import { describe, it, expect } from "vitest";
import { linesMissingCost, missingCostReason, namedApprovalReasons, addCostHref } from "./missing-cost-reason";
import { lineEconomics } from "./approval-economics";
import { requiredApproval, COST_UNKNOWN_REASON } from "./approval";
import type { QuoteLineItem } from "@/lib/supabase/database.types";

const SUPPORT_ID = "SUP-STANDARD-YR-fbb976f190904f1097260901bd144e42";

const line = (over: Partial<QuoteLineItem>): QuoteLineItem => ({
  id: "l1", item_id: "gw-std", name: "Google Workspace Business Standard", qty: 5,
  rate: 12_960, list_rate: 12_960, cost: 10_368, commitment: "annual_yearly", ...over,
});

const TYPED = line({ id: "typed", item_id: undefined, name: "Google Workspace Business Starter (1 year)", rate: 3_240, list_rate: 3_240, cost: 0 });

describe("linesMissingCost — which lines, by their number on the quote", () => {
  it("the owner's quote: the hand-typed line (line 2) is named; the catalogue line and the support plan are not", () => {
    const lines = [
      line({ id: "a" }),
      TYPED,
      line({ id: "sup", item_id: SUPPORT_ID, name: "Standard Support (Yearly)", cost: 0, rate: 24_000 }),
    ];
    expect(linesMissingCost(lines)).toEqual([{ lineNo: 2, id: "typed", name: "Google Workspace Business Starter (1 year)" }]);
  });
  it("no line missing a cost → empty", () => {
    expect(linesMissingCost([line({})])).toEqual([]);
  });
});

describe("missingCostReason — the sentence", () => {
  it("one line: names it", () => {
    expect(missingCostReason([{ lineNo: 2, id: "typed", name: "GW Starter (1 year)" }]))
      .toBe('Line 2 "GW Starter (1 year)" has no vendor cost, so the margin on this quote is unknown.');
  });
  it("several lines: names each", () => {
    expect(missingCostReason([
      { lineNo: 1, id: "a", name: "Website setup" },
      { lineNo: 3, id: "b", name: "Hosting" },
    ])).toBe('Lines 1 "Website setup" and 3 "Hosting" have no vendor cost, so the margin on this quote is unknown.');
  });
  it("none → null", () => {
    expect(missingCostReason([])).toBeNull();
  });
});

describe("namedApprovalReasons — the generic reason becomes the named one, the rule does not move", () => {
  it("the requirement still says owner tier, and the shown reason names the line", () => {
    const lines = [line({ id: "a" }), TYPED];
    const need = requiredApproval(lineEconomics(lines));
    expect(need.tier).toBe("owner");
    expect(need.reasons).toContain(COST_UNKNOWN_REASON);
    const shown = namedApprovalReasons(need.reasons, lines);
    expect(shown).not.toContain(COST_UNKNOWN_REASON);
    expect(shown).toContain('Line 2 "Google Workspace Business Starter (1 year)" has no vendor cost, so the margin on this quote is unknown.');
  });
  it("other reasons pass through untouched", () => {
    const shown = namedApprovalReasons(["Discount is 25% — above the 20% a manager can clear."], [line({})]);
    expect(shown).toEqual(["Discount is 25% — above the 20% a manager can clear."]);
  });
});

describe("addCostHref — the 'Add cost' button opens the draft's edit page at that line's cost", () => {
  it("encodes the quote id and the line NUMBER (line ids are re-made when the editor loads)", () => {
    expect(addCostHref("Q-4786-27-0001", 2)).toBe("/quotes/Q-4786-27-0001/edit?addCost=2");
  });
});
