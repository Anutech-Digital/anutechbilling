/**
 * R-2735 (Pardeep, 13 Nov 2026 — p0 money): a subscription billed in parts renews only when the new term's
 * first part is PAID. These cover the app half: the new term is billed on a VIRTUAL roll, and neither
 * "Bill next part" nor the renewals cron writes renewal_date / 'renewed' any more. The database half
 * (the roll on payment, exactly once) is supabase/tests/r2735_renew_on_payment.test.sql.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { termToBill, firstPartIndex, renewsWhenPaidNote } from "./pay-to-renew";

const quarterly = {
  billing_cycle: "quarterly" as const, term_months: 12, start_date: "2025-12-01", renewal_date: "2026-11-30",
  renewal_quote_id: null as string | null, auto_renew: true,
};

describe("R-2735 termToBill — the new term billed as if renewed, nothing written", () => {
  it("term still running → nothing to roll", () => {
    expect(termToBill(quarterly, "2026-11-30")).toBeNull();
  });

  it("new term begun (1 Dec) → bill as renewed to 30 Nov 2027; the roll 30 Nov 2026 → 30 Nov 2027", () => {
    const t = termToBill(quarterly, "2026-12-01");
    expect(t?.billAs.renewal_date).toBe("2027-11-30");
    expect(t?.roll).toEqual({ from: "2026-11-30", to: "2027-11-30" });
    /* the input row is not changed */
    expect(quarterly.renewal_date).toBe("2026-11-30");
  });

  it("anniversary-shaped renewal date (start + 1 year) keeps its shape", () => {
    const t = termToBill({ ...quarterly, start_date: "2025-12-01", renewal_date: "2026-12-01" }, "2026-12-01");
    expect(t?.roll).toEqual({ from: "2026-12-01", to: "2027-12-01" });
  });

  it("monthly flex (1-month term): each month is a term", () => {
    const t = termToBill({ ...quarterly, billing_cycle: "monthly", term_months: 1, start_date: "2026-10-01", renewal_date: "2026-10-31" }, "2026-11-01");
    expect(t?.roll).toEqual({ from: "2026-10-31", to: "2026-11-30" });
  });

  it("an open renewal quote holds it (R-808); Won't renew (auto_renew false) never rolls; yearly is not split", () => {
    expect(termToBill({ ...quarterly, renewal_quote_id: "Q-1" }, "2026-12-05")).toBeNull();
    expect(termToBill({ ...quarterly, auto_renew: false }, "2026-12-05")).toBeNull();
    expect(termToBill({ ...quarterly, billing_cycle: "yearly" as never }, "2026-12-05")).toBeNull();
  });

  it("the term's first part is its lowest period index", () => {
    expect(firstPartIndex([3, 1, 2])).toBe(1);
    expect(firstPartIndex([2, 4])).toBe(2);
    expect(firstPartIndex([])).toBeNull();
  });

  it("the Bill-next-part toast says the renewal waits for the payment", () => {
    expect(renewsWhenPaidNote({ from: "2026-11-30", to: "2027-11-30" })).toBe(" The renewal date moves to 30 Nov 2027 only when it is paid.");
    expect(renewsWhenPaidNote(null)).toBe("");
  });
});

/* Source checks: the two places that rolled on RAISE no longer write the subscription. */
const root = join(__dirname, "..", "..", "..");
const src = (p: string) => readFileSync(join(root, p), "utf8");

describe("R-2735 nothing rolls renewal_date when a part is billed", () => {
  it("Bill next part (generate-renewal-quote) writes no renewal_date / 'renewed' itself", () => {
    const route = src("src/app/api/subscriptions/[id]/generate-renewal-quote/route.ts");
    expect(route).not.toMatch(/renewal_state:\s*"renewed"/);
    expect(route).not.toMatch(/\.update\(\{\s*renewal_date/);
    expect(route).toMatch(/termRoll/);
  });

  it("the renewals cron does not roll a split-billed term", () => {
    const cron = src("src/app/api/cron/renewals/route.ts");
    expect(cron).not.toMatch(/renewal_state:\s*"renewed"/);
    expect(cron).toMatch(/split_awaiting_payment/);
  });

  it("the billing cron bills the new term with its roll", () => {
    const cron = src("src/app/api/cron/billing/route.ts");
    expect(cron).toMatch(/termToBill\(/);
    expect(cron).toMatch(/termRoll/);
  });
});
