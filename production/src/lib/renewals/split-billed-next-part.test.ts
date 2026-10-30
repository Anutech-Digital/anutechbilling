/* R-2095 (staging, 30 Oct): Renewals → Generate on a monthly-billed subscription whose month ended
   refused ("billed monthly…") with no part bill anywhere — month 2 could not be billed. */
import { describe, expect, it } from "vitest";
import { nextPartMessage, rolledRenewalDate } from "./split-billed-next-part";

const monthly = { billing_cycle: "monthly" as const, term_months: 1, start_date: "2026-09-01", renewal_date: "2026-09-30", renewal_quote_id: null };

describe("R-2095 Generate on a subscription billed in parts → the next part", () => {
  it("a monthly term that ended 30 Sep rolls to October on 29 Oct", () => {
    expect(rolledRenewalDate(monthly, "2026-10-29")).toEqual({ renewalDate: "2026-10-31", rolls: 1, heldBy: null });
  });
  it("two months behind → rolls twice", () => {
    expect(rolledRenewalDate(monthly, "2026-11-05").rolls).toBe(2);
  });
  it("a term still running is not rolled", () => {
    expect(rolledRenewalDate(monthly, "2026-09-20")).toEqual({ renewalDate: "2026-09-30", rolls: 0, heldBy: null });
  });
  it("an open renewal quote holds it (paying it would bill twice)", () => {
    expect(rolledRenewalDate({ ...monthly, renewal_quote_id: "Q-1" }, "2026-10-29").heldBy).toBe("Q-1");
  });
  it("says what was made and links to it", () => {
    expect(nextPartMessage("Greentin", { raised: [], requests: [{ period_index: 1, quote_id: "Q-9" }], requestsOpen: [] }, null))
      .toEqual({ ok: true, text: expect.stringMatching(/Payment request Q-9/), href: "/quotes/Q-9" });
    expect(nextPartMessage("Greentin", { raised: [{ period_index: 1, invoice_id: "INV-7" }], requests: [], requestsOpen: [] }, null).href).toBe("/invoices/INV-7");
    expect(nextPartMessage("Greentin", { raised: [], requests: [], requestsOpen: [] }, null).ok).toBe(false);
  });
});
