/**
 * R-2540: a Zoho FY scan read before R-2536 carries no billingAddress at all (the key is missing) —
 * a same-PAN branch invoice imported from it would get no address. The preview counts them so the
 * owner presses "Read from Zoho again". A scan read after R-2536 has the key (null = Zoho had none).
 */
import { describe, it, expect } from "vitest";
import { staleAddressCount } from "./stale-address";
import type { PlannedSale } from "./plan";

const row = (verdict: PlannedSale["verdict"], matchedBy: PlannedSale["matchedBy"], facts: Record<string, unknown>) =>
  ({ verdict, matchedBy, facts, reason: null, customerId: "c", itemIds: [] }) as unknown as PlannedSale;

describe("staleAddressCount (R-2540)", () => {
  it("counts to-import rows read before addresses were kept; branch ones separately", () => {
    const s = staleAddressCount([
      row("import", "gstin", {}),                                   // old scan, same registration
      row("import", "pan", {}),                                     // old scan, another branch
      row("import", "chosen", {}),                                  // old scan, owner's pick
      row("import", "pan", { billingAddress: null }),               // new scan, Zoho had none
      row("import", "pan", { billingAddress: "Gurugram, Haryana" }), // new scan
      row("skip", null, {}),                                        // not coming in
      row("already", "gstin", {}),                                  // already in the app
    ]);
    expect(s).toEqual({ count: 3, branch: 2 });
  });

  it("nothing stale → zeros", () => {
    expect(staleAddressCount([row("import", "gstin", { billingAddress: null })])).toEqual({ count: 0, branch: 0 });
  });
});
