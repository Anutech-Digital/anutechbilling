/**
 * R-2519b (independent review v9, HIGH): a cancelled EARLIER period was never billed again — the run
 * bills only the current term. Bill next part now bills the freed part on its own row first and
 * reports it as the oldest period (no document twice).
 */
import { describe, it, expect } from "vitest";
import { withFreedPart, termsMessage, type TermsBilled } from "./split-billed-next-part";

const run: TermsBilled = {
  heldBy: null, error: null, stoppedReason: null,
  terms: [{ periodStart: "2026-11-12", periodEnd: "2026-12-11", bill: { raised: [], requests: [{ period_index: 1, quote_id: "PI-A378-27-0002" }], requestsOpen: [], skip: null } }],
};

describe("R-2519b — the freed (cancelled) period is billed first", () => {
  it("BITDECENTRO: 12 Oct–11 Nov re-billed on its row, then 12 Nov–11 Dec", () => {
    const freed = { periodStart: "2026-10-12", periodEnd: "2026-11-11", bill: { raised: [], requests: [{ period_index: 1, quote_id: "PI-A378-27-0001" }], requestsOpen: [], skip: null } };
    const r = withFreedPart(run, freed);
    expect(r.terms.map((t) => t.periodStart)).toEqual(["2026-10-12", "2026-11-12"]);
    expect(termsMessage("BITDECENTRO", r).text).toBe("2 periods billed for BITDECENTRO, oldest first: PI-A378-27-0001 (12 Oct–11 Nov), PI-A378-27-0002 (12 Nov–11 Dec).");
  });
  it("no freed part, or one that billed nothing → the run as it was", () => {
    expect(withFreedPart(run, null)).toBe(run);
    expect(withFreedPart(run, { periodStart: "2026-10-12", periodEnd: "2026-11-11", bill: { raised: [], requests: [], requestsOpen: [], skip: null } })).toBe(run);
  });
  it("the same proforma reported again by the run is not listed twice", () => {
    const freed = { periodStart: "2026-11-12", periodEnd: "2026-12-11", bill: { raised: [], requests: [], requestsOpen: [{ period_index: 1, quote_id: "PI-A378-27-0002", status: "sent" }], skip: null } };
    expect(withFreedPart(run, freed).terms).toHaveLength(1);
  });
});
