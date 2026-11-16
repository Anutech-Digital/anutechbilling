/**
 * R-2761 — a 'held' renewal undo (R-2749: the renewal part's payment was undone but renewal_date was kept)
 * shows on the Renewals row as a flag "Renewal held — <reason>. <what to do>", also when the chip says
 * Renewed / Expired; a stale hold (renewal_date moved since) is never shown.
 */
import { describe, it, expect } from "vitest";
import { renewalStage, renewalHeldReason, type StageSub, type RenewalHeld } from "./stage";

const TODAY = "2026-11-14";
const sub = (over: Partial<StageSub> = {}): StageSub => ({
  status: "active", renewal_state: "renewed", renewal_date: "2027-09-30", term_months: 12,
  billing_cycle: "quarterly", start_date: "2025-10-01", auto_renew: true, grace_until: null, renewal_quote_id: null, ...over,
});
const held = (over: Partial<RenewalHeld> = {}): RenewalHeld => ({ kind: "not_active", from: "2027-09-30", to: "2026-09-30", ...over });

describe("R-2761 renewalHeldReason", () => {
  it("expired sub: names the status, the kept date and what to do", () => {
    const r = renewalHeldReason(held(), sub({ status: "expired" }));
    expect(r).toMatch(/^Renewal held — subscription expired\./);
    expect(r).toMatch(/stays 30 Sept? 2027./);
    expect(r).toMatch(/Make it active again to move it back to 30 Sept? 2026/);
  });
  it("quote linked / seat cut / unknown kind each say what to do", () => {
    expect(renewalHeldReason(held({ kind: "quote_linked" }), sub({ renewal_quote_id: "Q-1" }))).toMatch(/^Renewal held — renewal quote linked\..*Cancel or unlink that quote/);
    expect(renewalHeldReason(held({ kind: "seat_cut" }), sub())).toMatch(/^Renewal held — seat cut scheduled\..*Bill the part again/);
    expect(renewalHeldReason(held({ kind: null }), sub())).toMatch(/^Renewal held\. .*Bill the part again\.$/);
  });
  it("rev-r2761 MED 1: seat cut / unknown never advise moving the date back by hand (a re-billed term is paid)", () => {
    for (const kind of ["seat_cut", null] as const) {
      const r = renewalHeldReason(held({ kind }), sub()) ?? "";
      expect(r).toMatch(/Bill the part again\.$/);
      expect(r).not.toMatch(/correct the renewal date|move it back/i);
    }
  });
  it("stale hold (renewal_date moved since) or none → null", () => {
    expect(renewalHeldReason(held(), sub({ renewal_date: "2026-09-30" }))).toBeNull();
    expect(renewalHeldReason(held(), sub({ renewal_date: null }))).toBeNull();
    expect(renewalHeldReason(null, sub())).toBeNull();
  });
});

describe("R-2761 renewalStage keeps the held flag", () => {
  it("on a Renewed chip (the term may have no money)", () => {
    const s = renewalStage({ sub: sub(), todayIst: TODAY, renewalPaid: true, flags: { renewalHeld: held({ kind: "quote_linked" }), followUpDue: { nextFollowUpOn: null } } });
    expect(s.key).toBe("renewed");
    expect(s.flags.map((f) => f.key)).toEqual(["renewalHeld"]);
  });
  it("on an Expired chip, first among the flags", () => {
    const s = renewalStage({ sub: sub({ status: "expired" }), todayIst: TODAY, flags: { renewalHeld: held(), atRisk: { reasons: [] } } });
    expect(s).toMatchObject({ key: "stopped", label: "Expired" });
    expect(s.flags[0]).toMatchObject({ key: "renewalHeld" });
    expect(s.flags[0].reason).toMatch(/^Renewal held — subscription expired/);
  });
  it("a stale hold adds no flag", () => {
    const s = renewalStage({ sub: sub({ renewal_date: "2026-12-31" }), todayIst: TODAY, flags: { renewalHeld: held() } });
    expect(s.flags).toEqual([]);
  });
});
