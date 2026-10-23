import { describe, expect, it } from "vitest";
import { canRenewAnyway, renewAnywayPrompt, vendorHoldState } from "./vendor-hold";

/* 23 Oct 2026, 10:00 IST */
const TODAY = new Date("2026-10-23T04:30:00Z");
const base = { status: "active", renewal_state: "grace_period", renewal_date: "2026-10-13", vendor_hold_override_for: null };

describe("vendorHoldState (R-1796) — derived, nothing stored", () => {
  it("unpaid and past the renewal date → hold", () => {
    expect(vendorHoldState(base, TODAY)).toBe("hold");
    expect(vendorHoldState({ ...base, status: "paused", renewal_state: "suspended" }, TODAY)).toBe("hold");
    expect(vendorHoldState({ ...base, renewal_state: "final_sent" }, TODAY)).toBe("hold");
  });

  it("renewal date is today or later → no hold (IST calendar day)", () => {
    expect(vendorHoldState({ ...base, renewal_date: "2026-10-23" }, TODAY)).toBe("none");
    expect(vendorHoldState({ ...base, renewal_date: "2026-11-01" }, TODAY)).toBe("none");
    /* 22 Oct 23:30 IST is still the 22nd: a renewal dated the 22nd is not past yet */
    expect(vendorHoldState({ ...base, renewal_date: "2026-10-22" }, new Date("2026-10-22T18:00:00Z"))).toBe("none");
  });

  it("paid (renewal_date rolled) → hold gone by itself", () => {
    expect(vendorHoldState({ ...base, renewal_date: "2027-10-13", renewal_state: "renewed" }, TODAY)).toBe("none");
  });

  it("renewed state, cancelled or expired → no hold", () => {
    expect(vendorHoldState({ ...base, renewal_state: "renewed" }, TODAY)).toBe("none");
    expect(vendorHoldState({ ...base, status: "cancelled" }, TODAY)).toBe("none");
    expect(vendorHoldState({ ...base, status: "expired" }, TODAY)).toBe("none");
    expect(vendorHoldState({ ...base, renewal_date: null }, TODAY)).toBe("none");
  });

  it("Renew anyway covers THIS term only", () => {
    expect(vendorHoldState({ ...base, vendor_hold_override_for: "2026-10-13" }, TODAY)).toBe("overridden");
    /* an override from the previous term means nothing for this one */
    expect(vendorHoldState({ ...base, vendor_hold_override_for: "2025-10-13" }, TODAY)).toBe("hold");
  });

  it("works before the migration (column absent)", () => {
    const { vendor_hold_override_for: _drop, ...noCol } = base;
    void _drop;
    expect(vendorHoldState(noCol, TODAY)).toBe("hold");
  });
});

describe("canRenewAnyway", () => {
  it("owner and manager only — same as the RPC", () => {
    expect(canRenewAnyway("owner")).toBe(true);
    expect(canRenewAnyway("manager")).toBe(true);
    for (const r of ["billing", "sales", "support", "accountant", null, undefined, ""]) {
      expect(canRenewAnyway(r)).toBe(false);
    }
  });
});

describe("renewAnywayPrompt", () => {
  it("says it is one term, logged, and the customer still owes", () => {
    const p = renewAnywayPrompt({ customer_name: "Acme", plan: "Business Starter" });
    expect(p.title).toContain("Acme");
    expect(p.body).toMatch(/this term only/);
    expect(p.body).toMatch(/activity log/);
    expect(p.body).toMatch(/still owes/);
  });
});
