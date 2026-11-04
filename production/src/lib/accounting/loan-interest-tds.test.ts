/**
 * R-2376 — TDS on interest paid to a non-bank lender (s.393(1) Table 5(iii) Income-tax Act 2025,
 * old s.194A). Owner-delegated decision 3 Nov 2026 (TAX-DECISIONS memo §4):
 *   10% once the interest (+ loan processing fee ex-GST) to ONE lender in a FY is above ₹10,000;
 *   banks exempt; a Pvt Ltd always deducts; a proprietorship only when tax-audited last year
 *   (asked once, never silently off); a setting turns it off.
 * Owner example (OD audit 2 Nov): Tata Capital — ₹4,000 processing fee + monthly interest.
 */
import { describe, expect, it } from "vitest";
import {
  LOAN_TDS, loanInterestTds, deductorGate, lenderKey, fyStartOf, sectionLabel, thresholdFor,
  suggestTdsForPayment, paymentTdsAdvice, emptyLoanTdsSettings, readLoanTdsSettings, type InterestEvent, type LoanTdsSettings,
} from "./loan-interest-tds";

const ev = (o: Partial<InterestEvent>): InterestEvent => ({
  lender: "Tata Capital", on: "2026-06-05", amount: 3000, kind: "interest", tdsKept: 0, ...o,
});
const settings = (o: Partial<LoanTdsSettings> = {}): LoanTdsSettings => ({
  ...emptyLoanTdsSettings(), lenders: { [lenderKey("Tata Capital")]: "non_bank", [lenderKey("HDFC Bank")]: "bank" }, ...o,
});
const run = (events: InterestEvent[], s: LoanTdsSettings = settings(), businessType: "pvt_ltd" | "proprietor" | null = "pvt_ltd", fy = 2026) =>
  loanInterestTds({ events, settings: s, businessType, fyStart: fy });

describe("R-2376 basics", () => {
  it("rate 10%, limit ₹10,000 from FY 2025-26 (₹5,000 before)", () => {
    expect(LOAN_TDS.ratePct).toBe(10);
    expect(thresholdFor(2025)).toBe(10_000);
    expect(thresholdFor(2026)).toBe(10_000);
    expect(thresholdFor(2024)).toBe(5_000);
  });
  it("FY starts in April", () => {
    expect(fyStartOf("2026-03-31")).toBe(2025);
    expect(fyStartOf("2026-04-01")).toBe(2026);
  });
  it("section label shows both laws from FY 2026-27", () => {
    expect(sectionLabel(2026)).toBe("s.393(1) Table 5(iii) (old 194A)");
    expect(sectionLabel(2025)).toBe("194A");
  });
  it("lender names match across spelling (Ltd / case / dots)", () => {
    expect(lenderKey("Tata Capital Ltd.")).toBe(lenderKey("TATA CAPITAL"));
    expect(lenderKey("Bajaj Finance Limited")).toBe(lenderKey("bajaj  finance"));
  });
  it("settings read safely from the tenant row (missing / junk → empty)", () => {
    expect(readLoanTdsSettings(null)).toEqual(emptyLoanTdsSettings());
    expect(readLoanTdsSettings({ off: true, audited: { "2025": false, x: "y" }, lenders: { a: "bank", b: "zzz" } }))
      .toEqual({ off: true, audited: { "2025": false }, lenders: { a: "bank" } });
  });
});

describe("R-2376 threshold crossing — on the booking that crosses it", () => {
  const events = [
    ev({ on: "2026-04-10", amount: 4000, kind: "fee" }),   // processing fee ex-GST counts as interest
    ev({ on: "2026-05-05", amount: 3000 }),
    ev({ on: "2026-06-05", amount: 3000 }),                 // ₹10,000 exactly — not above
    ev({ on: "2026-07-05", amount: 3000 }),                 // ₹13,000 → crosses here
  ];
  it("below the limit: nothing due", () => {
    const r = run(events.slice(0, 3));
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatchObject({ status: "below_limit", total: 10_000, tdsDue: 0, crossedOn: null });
  });
  it("the booking that crosses → 10% on the WHOLE year's amount, earlier entries too", () => {
    const r = run(events);
    expect(r.gate.kind).toBe("on");
    expect(r.lines[0]).toMatchObject({
      lender: "Tata Capital", status: "due", total: 13_000, tdsDue: 1300, crossedOn: "2026-07-05",
      section: "s.393(1) Table 5(iii) (old 194A)",
    });
    expect(r.lines[0].entry).toEqual({ dr: "Tata Capital", cr: "TDS payable — s.393(1) Table 5(iii) (old 194A)", amount: 1300 });
  });
  it("TDS already kept back counts — only the rest is due; all of it → settled", () => {
    expect(run([...events, ev({ on: "2026-08-05", amount: 3000, tdsKept: 1000 })]).lines[0]).toMatchObject({ total: 16_000, tdsDue: 600 });
    expect(run([...events, ev({ on: "2026-08-05", amount: 3000, tdsKept: 1600 })]).lines[0]).toMatchObject({ status: "settled", tdsDue: 0 });
  });
  it("ONE lender: two lenders each under the limit → nothing due", () => {
    const r = run([ev({ amount: 8000 }), ev({ lender: "Bajaj Finance", amount: 8000 })],
      settings({ lenders: { [lenderKey("Tata Capital")]: "non_bank", [lenderKey("Bajaj Finance")]: "non_bank" } }));
    expect(r.lines.every((l) => l.status === "below_limit")).toBe(true);
  });
  it("two loans from the same lender add up (name spelt two ways)", () => {
    const r = run([ev({ amount: 6000 }), ev({ lender: "TATA CAPITAL LTD", amount: 6000, on: "2026-09-01" })]);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatchObject({ status: "due", total: 12_000, tdsDue: 1200, crossedOn: "2026-09-01" });
  });
});

describe("R-2376 who is exempt", () => {
  it("a bank lender: exempt whatever the amount", () => {
    const r = run([ev({ lender: "HDFC Bank", amount: 90_000 })]);
    expect(r.lines[0]).toMatchObject({ status: "bank_exempt", tdsDue: 0 });
  });
  it("an unmarked lender above the limit → a one-time question, not silently skipped", () => {
    const r = run([ev({ lender: "Some Finance Co", amount: 20_000 })]);
    expect(r.lines[0]).toMatchObject({ status: "ask_type", tdsDue: 2000 });
  });
  it("a director's loan is a non-bank lender without asking", () => {
    const r = run([ev({ lender: "Rahul Sharma", amount: 20_000, lenderType: "non_bank" })]);
    expect(r.lines[0]).toMatchObject({ status: "due", tdsDue: 2000 });
  });
});

describe("R-2376 the deductor — Pvt Ltd always, proprietor only if tax-audited last year", () => {
  const big = [ev({ amount: 20_000 })];
  it("Pvt Ltd: on", () => expect(deductorGate("pvt_ltd", settings(), 2026)).toEqual({ kind: "on" }));
  it("proprietorship, not tax-audited in FY 2025-26 → no TDS line due", () => {
    const r = run(big, settings({ audited: { "2025": false } }), "proprietor");
    expect(r.gate.kind).toBe("not_required");
    expect(r.lines.filter((l) => l.status === "due")).toHaveLength(0);
  });
  it("proprietorship, tax-audited last year → due", () => {
    const r = run(big, settings({ audited: { "2025": true } }), "proprietor");
    expect(r.gate.kind).toBe("on");
    expect(r.lines[0].status).toBe("due");
  });
  it("proprietorship, not answered → ask once (FY 2025-26), lines held as 'would be due'", () => {
    const r = run(big, settings(), "proprietor");
    expect(r.gate).toEqual({ kind: "ask_audit", prevFyStart: 2025 });
    expect(r.lines[0].status).toBe("due");      // the screen shows it under the question
  });
  it("setting off → off, for any business", () => {
    expect(run(big, settings({ off: true })).gate.kind).toBe("off");
  });
});

describe("R-2376 FY reset", () => {
  it("last FY's interest does not count toward this FY", () => {
    const r = run([ev({ on: "2026-03-05", amount: 9000 }), ev({ on: "2026-04-05", amount: 3000 })]);
    expect(r.lines[0]).toMatchObject({ fyStart: 2026, total: 3000, status: "below_limit" });
  });
  it("each FY on its own: crossed last FY, below this FY", () => {
    const events = [ev({ on: "2025-10-05", amount: 12_000 }), ev({ on: "2026-05-05", amount: 2000 })];
    expect(run(events, settings(), "pvt_ltd", 2025).lines[0]).toMatchObject({ status: "due", tdsDue: 1200, section: "194A" });
    expect(run(events, settings(), "pvt_ltd", 2026).lines[0]).toMatchObject({ status: "below_limit", tdsDue: 0 });
  });
});

describe("R-2376 TDS to keep back on a repayment (OD / loan repayment split)", () => {
  const earlier = [ev({ on: "2026-05-05", amount: 4000 }), ev({ on: "2026-06-05", amount: 4000 })];
  const base = { settings: settings(), businessType: "pvt_ltd" as const, lender: "Tata Capital" };
  it("the payment that crosses → 10% of the whole year so far, up to this interest", () => {
    expect(suggestTdsForPayment({ ...base, events: earlier, on: "2026-07-05", interest: 4000 })).toBe(1200);
  });
  it("capped at this payment's interest", () => {
    expect(suggestTdsForPayment({ ...base, events: [ev({ amount: 50_000 })], on: "2026-07-05", interest: 1000 })).toBe(1000);
  });
  it("still under the limit → 0", () => {
    expect(suggestTdsForPayment({ ...base, events: [], on: "2026-07-05", interest: 4000 })).toBe(0);
  });
  it("a bank, an unmarked lender, or the setting off → 0 (never guessed)", () => {
    expect(suggestTdsForPayment({ ...base, lender: "HDFC Bank", events: [], on: "2026-07-05", interest: 20_000 })).toBe(0);
    expect(suggestTdsForPayment({ ...base, lender: "New NBFC", events: [], on: "2026-07-05", interest: 20_000 })).toBe(0);
    expect(suggestTdsForPayment({ ...base, settings: settings({ off: true }), events: [], on: "2026-07-05", interest: 20_000 })).toBe(0);
  });
});

describe("R-2376 review fixes — advice on a payment, EMI-only lenders", () => {
  const base = { settings: settings(), businessType: "pvt_ltd" as const, lender: "Tata Capital", on: "2026-07-05" };
  it("an unmarked lender above the limit → ask_type with the would-be amount (not silently 0)", () => {
    expect(paymentTdsAdvice({ ...base, lender: "New NBFC", events: [], interest: 20_000 })).toEqual({ status: "ask_type", amount: 2000 });
  });
  it("proprietor not answered → ask_audit; answered not audited → none", () => {
    expect(paymentTdsAdvice({ ...base, businessType: "proprietor", events: [], interest: 20_000 })).toEqual({ status: "ask_audit", amount: 2000 });
    expect(paymentTdsAdvice({ ...base, businessType: "proprietor", settings: settings({ audited: { "2025": false } }), events: [], interest: 20_000 }).status).toBe("none");
  });
  it("due → the amount; bank → none", () => {
    expect(paymentTdsAdvice({ ...base, events: [], interest: 20_000 })).toEqual({ status: "due", amount: 2000 });
    expect(paymentTdsAdvice({ ...base, lender: "HDFC Bank", events: [], interest: 20_000 }).status).toBe("none");
  });
  it("a lender booked only through EMIs is flagged (the EMI reconcile has no TDS box)", () => {
    expect(run([ev({ amount: 20_000, viaEmi: true })]).lines[0].onlyEmi).toBe(true);
    expect(run([ev({ amount: 20_000, viaEmi: true }), ev({ amount: 1000 })]).lines[0].onlyEmi).toBe(false);
  });
});
