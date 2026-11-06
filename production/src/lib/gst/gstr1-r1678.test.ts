/* R-1678 / R-2171 — an export invoice booked from a USD inward credit (reconcile_bank_credit_new_sale_fx:
   dated the bank line, gst_treatment overseas, POS 96, 0% under the FY's LUT, inter_state false as the
   RPC writes it) is GSTR-1 table 6A (EXP, WOPAY) — never B2CS / B2CL. R-2094 #10: TIMBERGLOSS (UAE)
   USD 759 → INV in USD, ₹ value at its rate. */
import { describe, expect, it } from "vitest";
import { buildGstr1, type Gstr1Doc } from "./gstr1";

const seller = { stateCode: "07", state: "Delhi", gstin: "07ABDCA0000A1Z5" };

const exportFromUsdCredit: Gstr1Doc = {
  id: "INV-A378-27-0901", date: "2026-08-05", docType: "invoice", customerName: "Timbergloss Industries",
  customerGstin: null, customerStateCode: null, customerState: null, customerCountry: "United Arab Emirates",
  amount: 71004, taxableValue: 71004, gst: 0, taxRate: 0, interState: false, gstTreatment: "overseas",
};

describe("R-1678 export invoice from a USD inward credit in GSTR-1", () => {
  it("goes to table 6A as WOPAY (under LUT, no IGST) with the invoice date — not B2CS / B2CL", () => {
    const s = buildGstr1([exportFromUsdCredit], seller);
    expect(s.exp).toEqual([{ exportType: "WOPAY", id: "INV-A378-27-0901", date: "2026-08-05", value: 71004, rate: 0, taxable: 71004, igst: 0 }]);
    expect(s.b2cs).toEqual([]);
    expect(s.b2cl).toEqual([]);
    expect(s.b2b).toEqual([]);
  });
});
