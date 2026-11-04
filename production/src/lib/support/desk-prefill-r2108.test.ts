import { describe, expect, it } from "vitest";
import { supportBuyPrefill, type PrefillCustomerRow } from "./desk-prefill";

const row = (o: Partial<PrefillCustomerRow> = {}): PrefillCustomerRow => ({
  name: "Acme Pvt Ltd", contact_name: "Ravi Old", contact_mobile: "9811111111", contact_phone: "011-222",
  state: "Delhi", state_code: "07", gstin: null, ...o,
});

describe("R-2108 /buy/support prefill for a known customer", () => {
  it("fills name, company, phone and state — the primary contact wins for the person", () => {
    expect(supportBuyPrefill(row(), { name: "Priya Primary", phone: "9822222222" })).toEqual({
      name: "Priya Primary", company: "Acme Pvt Ltd", phone: "9822222222", stateCode: "07",
    });
  });

  it("falls back to the customer record when there is no primary contact", () => {
    expect(supportBuyPrefill(row(), null)).toMatchObject({ name: "Ravi Old", phone: "9811111111" });
    expect(supportBuyPrefill(row({ contact_mobile: " " }), null).phone).toBe("011-222");
  });

  it("reads the state from the GSTIN, then the state name, when the code is blank", () => {
    expect(supportBuyPrefill(row({ state_code: null, gstin: "27AAPFU0939F1ZV" }), null).stateCode).toBe("27");
    expect(supportBuyPrefill(row({ state_code: null, state: "Karnataka" }), null).stateCode).toBe("29");
    expect(supportBuyPrefill(row({ state_code: null, state: null }), null).stateCode).toBe("");
  });

  it("never fills a masked phone", () => {
    expect(supportBuyPrefill(row({ contact_mobile: "••••1111", contact_phone: null }), { name: null, phone: "••••2222" }).phone).toBe("");
  });
});
