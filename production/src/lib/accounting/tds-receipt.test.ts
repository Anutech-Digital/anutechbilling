import { describe, it, expect } from "vitest";
import { paymentOutcome, receiptSplit, receiptSplitLine, tdsByPayment, tdsRateMismatches } from "./tds-receipt";

describe("R-523 receipt split — bank money and TDS shown apart", () => {
  it("the tester's receipt: ₹1,52,928 settled = ₹1,50,336 in bank + ₹2,592 TDS", () => {
    expect(receiptSplit(1_52_928, 2_592)).toEqual({ received: 1_50_336, tds: 2_592, gross: 1_52_928 });
    expect(receiptSplitLine(1_52_928, 2_592)).toBe("Received ₹1,50,336 + TDS ₹2,592 = ₹1,52,928");
  });

  it("no TDS → no split line (the plain total stays)", () => {
    expect(receiptSplitLine(50_000, 0)).toBeNull();
    expect(receiptSplitLine(50_000, null)).toBeNull();
    expect(receiptSplit(50_000, undefined)).toEqual({ received: 50_000, tds: 0, gross: 50_000 });
  });

  it("TDS can never exceed the gross", () => {
    expect(receiptSplit(1_000, 5_000)).toEqual({ received: 0, tds: 1_000, gross: 1_000 });
  });

  it("tdsByPayment sums per payment and skips rows with no payment", () => {
    expect(tdsByPayment([
      { payment_id: "p1", tds_amount: 2_592 },
      { payment_id: "p1", tds_amount: 8 },
      { payment_id: null, tds_amount: 999 },
      { payment_id: "p2", tds_amount: null },
    ])).toEqual({ p1: 2_600, p2: 0 });
  });
});

describe("R-523 paymentOutcome — one sentence, never 'fully paid' and 'outstanding' together", () => {
  it("bank + TDS settles exactly → fully paid, nothing outstanding", () => {
    const o = paymentOutcome({ expected: 1_52_928, alreadyReceived: 0, settled: 1_50_336 + 2_592 });
    expect(o.kind).toBe("full");
    expect(o.sentence).toBe("Quote will be marked fully paid.");
    expect(o.sentence).not.toMatch(/outstanding/);
  });

  it("the tester's case: TDS at 10% then cut to 2% with the bank amount kept → ₹10,368 outstanding, not 'fully paid'", () => {
    // Bank amount was filled at 10% (₹1,52,928 − ₹12,960); TDS then corrected to ₹2,592.
    const o = paymentOutcome({ expected: 1_52_928, alreadyReceived: 0, settled: 1_39_968 + 2_592 });
    expect(o.kind).toBe("partial");
    expect(o.due).toBe(10_368);
    expect(o.sentence).toBe("₹10,368 will still be outstanding — the quote stays partly paid.");
    expect(o.sentence).not.toMatch(/fully paid/);
  });

  it("prior payments count", () => {
    expect(paymentOutcome({ expected: 1_000, alreadyReceived: 400, settled: 600 }).kind).toBe("full");
    expect(paymentOutcome({ expected: 1_000, alreadyReceived: 400, settled: 500 }).due).toBe(100);
  });

  it("over-payment says fully paid AND by how much, once", () => {
    const o = paymentOutcome({ expected: 1_000, alreadyReceived: 0, settled: 1_200 });
    expect(o.kind).toBe("over");
    expect(o.excess).toBe(200);
    expect(o.sentence).toMatch(/fully paid, with ₹200 more/);
  });

  it("nothing entered → no claim either way", () => {
    expect(paymentOutcome({ expected: 1_000, alreadyReceived: 0, settled: 0 }).kind).toBe("none");
  });
});

describe("R-523 owner report — past entries whose rate does not fit the section", () => {
  const row = (id: string, section: string, rate: number | string, date = "2026-10-09") =>
    ({ id, customer_name: id, section, rate_pct: rate, tds_amount: 100, payment_received_date: date });

  it("lists 194J @ 2% (soft — technical services) and 194C @ 10% (firm), skips matching ones", () => {
    const out = tdsRateMismatches([
      row("ok-j", "194J", 10), row("ok-c", "194C", "2.00"),
      row("kapoor", "194J", "2.00"), row("wrong-c", "194C", 10),
      row("unknown", "192", 30),
    ]);
    expect(out.map((m) => m.entry.id)).toEqual(["wrong-c", "kapoor"]);
    expect(out[0]).toMatchObject({ defaultPct: 2, knownVariant: false });
    expect(out[0].message).toBe("194C is 2%, not 10%. Check the section or the rate before saving.");
    expect(out[1]).toMatchObject({ defaultPct: 10, knownVariant: true });
    expect(out[1].message).toMatch(/technical services/);
  });

  it("never changes the rows it reads", () => {
    const rows = [row("wrong-c", "194C", 10)];
    const before = JSON.stringify(rows);
    tdsRateMismatches(rows);
    expect(JSON.stringify(rows)).toBe(before);
  });
});
