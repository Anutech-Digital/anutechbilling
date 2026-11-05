import { describe, it, expect } from "vitest";
import { guessCustomer } from "./credit-pay-for";
import { payerFromNarration } from "./customer-payer";
import { isNoCustomerYet } from "./no-customer-yet";

/**
 * R-2390 (staging 2 Nov 2026): the ₹40,02,110 FD auto-redeem line guessed "M/S NARAIN AUTO MOBILES"
 * because the narration has "AUTO_REDEEM". Bank words like AUTO_REDEEM / AUTO-SWEEP sit in the same
 * ignore list as our own company name (R-2371) — they never name a payer.
 */
const customers = [
  { id: "narain", name: "M/S NARAIN AUTO MOBILES" },
  { id: "sweep", name: "Sweep Cleaners" },
  { id: "acme", name: "Acme Traders" },
];
const OWN = { payers: [], ownNames: ["Zenova Technologies Private Limited"] };

describe("R-2390 payer guess ignores AUTO_REDEEM / AUTO-SWEEP", () => {
  it("'AUTO_REDEEM' does not guess Narain Auto Mobiles (with or without the payer memory)", () => {
    const d = "TO FD 50300112233 AUTO_REDEEM";
    expect(guessCustomer({ description: d }, customers, [], OWN)).toBeNull();
    expect(guessCustomer({ description: d }, customers)).toBeNull();
    expect(isNoCustomerYet({ credit: 4002110, matched_to_type: null, description: d }, customers, [], OWN)).toBe(true);
  });

  it("'AUTO-SWEEP' / 'AUTO SWEEP' / 'AUTOSWEEP' guess nobody", () => {
    for (const d of ["AUTO-SWEEP IN 1234", "AUTO SWEEP CREDIT", "AUTOSWEEP REVERSAL"]) {
      expect(guessCustomer({ description: d }, customers, [], OWN)).toBeNull();
    }
  });

  it("a certain invoice match resting only on 'auto' is no guess", () => {
    const ms = [{ customerName: "M/S NARAIN AUTO MOBILES", confidence: "certain", reasons: ["Exact amount due", "Narration says “auto”"] }];
    expect(guessCustomer({ description: "FD AUTO_REDEEM 99" }, customers, ms, OWN)).toBeNull();
  });

  it("the customer's own words still guess it", () => {
    expect(guessCustomer({ description: "NEFT CR-HDFC0001-NARAIN AUTO MOBILES-UTR9" }, customers, [], OWN)?.customerId).toBe("narain");
  });

  it("the rail's payer slot 'AUTO SWEEP' is not a payer", () => {
    expect(payerFromNarration("NEFT CR-HDFC0001-AUTO SWEEP-UTR9", OWN.ownNames)).toBeNull();
    expect(payerFromNarration("NEFT CR-HDFC0001-ACME TRADERS-UTR9", OWN.ownNames)?.name).toBe("ACME TRADERS");
  });
});
