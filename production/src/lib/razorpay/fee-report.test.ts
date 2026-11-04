/**
 * R-2418 — the Online fee report's maths: every rupee Razorpay kept is split into
 * "recovered from the customer" and "absorbed by us", per month and per customer + reason.
 */
import { describe, expect, it } from "vitest";
import {
  buildFeeReport,
  blockedFeeGst,
  feeGstBlockedText,
  feeReportLine,
  settlementFeeSplit,
  FEE_REASON_LABEL,
  type FeeReportPayment,
} from "./fee-report";

function pay(over: Partial<FeeReportPayment> = {}): FeeReportPayment {
  return {
    id: "p1",
    receivedAt: "2026-11-02T10:00:00Z",
    customerId: "c1",
    customerName: "Sharma Traders",
    gatewayFee: 236,
    gatewayFeeGst: 36,
    feeBearer: "customer",
    feeCharged: 0,
    billWaived: false,
    customerAbsorbs: false,
    ...over,
  };
}

describe("one payment → reason, recovered, absorbed", () => {
  it("fee_bearer null (captured before the policy) → absorbed, 'before the policy'", () => {
    const l = feeReportLine(pay({ feeBearer: null, feeCharged: null }))!;
    expect(l).toMatchObject({ reason: "before_policy", fee: 236, recovered: 0, absorbed: 236, surplus: 0, gst: 36 });
  });

  it("business bearer: bill waiver beats customer absorb beats the company rule", () => {
    expect(feeReportLine(pay({ feeBearer: "business", billWaived: true, customerAbsorbs: true }))!.reason).toBe("bill_waived");
    expect(feeReportLine(pay({ feeBearer: "business", customerAbsorbs: true }))!.reason).toBe("customer_absorbs");
    expect(feeReportLine(pay({ feeBearer: "business" }))!.reason).toBe("company_rule");
    expect(feeReportLine(pay({ feeBearer: "business" }))!.absorbed).toBe(236);
  });

  it("customer bearer but nothing charged yet → 'not charged', fully absorbed", () => {
    const l = feeReportLine(pay({ feeBearer: "customer", feeCharged: 0 }))!;
    expect(l).toMatchObject({ reason: "not_charged", recovered: 0, absorbed: 236 });
  });

  it("customer paid the grossed-up fee → recovered, the extra over Razorpay's fee is surplus", () => {
    const l = feeReportLine(pay({ feeBearer: "customer", feeCharged: 286 }))!;
    expect(l).toMatchObject({ reason: "customer_pays", fee: 236, recovered: 286, absorbed: 0, surplus: 50 });
  });

  it("customer paid less than the fee → the gap is absorbed", () => {
    const l = feeReportLine(pay({ feeBearer: "customer", feeCharged: 200 }))!;
    expect(l).toMatchObject({ reason: "customer_pays", recovered: 200, absorbed: 36, surplus: 0 });
  });

  it("no fee on record (manual payment) → not in the report; bad numbers are not guessed", () => {
    expect(feeReportLine(pay({ gatewayFee: null }))).toBeNull();
    expect(feeReportLine(pay({ gatewayFee: -4 }))).toBeNull();
    expect(feeReportLine(pay({ gatewayFee: 10.5 }))).toBeNull();
    expect(feeReportLine(pay({ gatewayFeeGst: 999 }))!.gst).toBe(0);
  });

  it("every reason has an English label", () => {
    for (const r of ["customer_pays", "not_charged", "bill_waived", "customer_absorbs", "company_rule", "before_policy"] as const) {
      expect(FEE_REASON_LABEL[r]).toMatch(/\w/);
    }
  });
});

describe("report totals = the sum of gateway_fee, split by fee_bearer", () => {
  const rows: FeeReportPayment[] = [
    pay({ id: "a", receivedAt: "2026-10-05T05:00:00Z", feeBearer: null, feeCharged: null, gatewayFee: 100, gatewayFeeGst: 15 }),
    pay({ id: "b", receivedAt: "2026-10-31T19:00:00Z", feeBearer: "business", gatewayFee: 50, gatewayFeeGst: 8, customerId: "c2", customerName: "Gupta & Co" }), // 1 Nov IST
    pay({ id: "c", receivedAt: "2026-11-03T05:00:00Z", feeBearer: "customer", feeCharged: 286, gatewayFee: 236, gatewayFeeGst: 36 }),
    pay({ id: "d", receivedAt: "2026-11-03T06:00:00Z", feeBearer: "customer", feeCharged: 0, gatewayFee: 40, gatewayFeeGst: 6 }),
    pay({ id: "e", receivedAt: "2026-11-03T07:00:00Z", gatewayFee: null }),
  ];
  const r = buildFeeReport(rows);

  it("totals", () => {
    expect(r.totals.payments).toBe(4);
    expect(r.totals.fee).toBe(100 + 50 + 236 + 40);
    expect(r.totals.byBearer).toEqual({ customer: 276, business: 50, beforePolicy: 100 });
    expect(r.totals.byBearer.customer + r.totals.byBearer.business + r.totals.byBearer.beforePolicy).toBe(r.totals.fee);
    expect(r.totals.recovered).toBe(286);
    expect(r.totals.absorbed).toBe(100 + 50 + 40);
    expect(r.totals.surplus).toBe(50);
    /* fee = recovered + absorbed − surplus, always */
    expect(r.totals.recovered + r.totals.absorbed - r.totals.surplus).toBe(r.totals.fee);
    expect(r.totals.feeGst).toBe(15 + 8 + 36 + 6);
  });

  it("months by IST calendar month, newest first, each adding up", () => {
    expect(r.months.map((m) => m.month)).toEqual(["2026-11", "2026-10"]);
    const nov = r.months[0]!;
    expect(nov).toMatchObject({ payments: 3, fee: 326, recovered: 286, absorbed: 90, surplus: 50 });
    expect(r.months[1]).toMatchObject({ payments: 1, fee: 100, absorbed: 100 });
    expect(r.months.reduce((s, m) => s + m.fee, 0)).toBe(r.totals.fee);
  });

  it("customers × reason, biggest absorbed first", () => {
    expect(r.customers.map((c) => [c.customerName, c.reason, c.absorbed])).toEqual([
      ["Sharma Traders", "before_policy", 100],
      ["Gupta & Co", "company_rule", 50],
      ["Sharma Traders", "not_charged", 40],
      ["Sharma Traders", "customer_pays", 0],
    ]);
    expect(r.customers.reduce((s, c) => s + c.fee, 0)).toBe(r.totals.fee);
  });

  it("empty → zeros, no rows", () => {
    const e = buildFeeReport([]);
    expect(e.totals.fee).toBe(0);
    expect(e.months).toEqual([]);
    expect(e.customers).toEqual([]);
  });
});

describe("GST on the fee is blocked while Razorpay has no GSTIN in Vendors", () => {
  const rows = [pay({ gatewayFeeGst: 36 }), pay({ id: "x", gatewayFeeGst: 8 }), pay({ id: "y", gatewayFee: null, gatewayFeeGst: 99 })];

  it("no vendor / empty / wrong GSTIN → the fee GST is blocked", () => {
    expect(blockedFeeGst(rows, null)).toBe(44);
    expect(blockedFeeGst(rows, "")).toBe(44);
    expect(blockedFeeGst(rows, "29ABC")).toBe(44);
  });

  it("a valid GSTIN → nothing blocked, so no banner", () => {
    expect(blockedFeeGst(rows, "29AAGCR4375J1ZU")).toBe(0);
  });

  it("banner text", () => {
    expect(feeGstBlockedText(44)).toBe("Fee GST ₹44 credit blocked — add Razorpay's GSTIN");
  });
});

describe("a settlement: fee charged vs recovered", () => {
  it("adds up the matched payments' fee_charged", () => {
    expect(settlementFeeSplit(500, [286, null, 0])).toEqual({ fee: 500, recovered: 286, absorbed: 214, surplus: 0 });
    expect(settlementFeeSplit(100, [286])).toEqual({ fee: 100, recovered: 286, absorbed: 0, surplus: 186 });
    expect(settlementFeeSplit(0, [])).toEqual({ fee: 0, recovered: 0, absorbed: 0, surplus: 0 });
  });
});
