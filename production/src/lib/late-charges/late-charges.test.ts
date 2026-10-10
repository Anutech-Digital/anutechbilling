import { describe, it, expect } from "vitest";
import {
  resolveLateFee, lateFeeLabel, lateFeeSettingsFromRow, isGstRegistered, mayToggleLateFee, mayBillLateCharges,
  DEFAULT_LATE_FEE_SETTINGS, type LateFeeMode, type LateFeeSettings, type EffectiveLateFee,
} from "./rules";
import {
  computeLateCharges, invoicePaymentTimeline, lateChargeBillMath, lateChargesSentence, type LateChargeInvoice,
} from "./charges";

const ON: LateFeeSettings = { ...DEFAULT_LATE_FEE_SETTINGS, enabled: true };
const eff = (over: Partial<EffectiveLateFee> = {}): EffectiveLateFee =>
  ({ on: true, source: "company", waived: false, waiveReason: null, since: null, ...over });
const inv = (over: Partial<LateChargeInvoice> = {}): LateChargeInvoice => ({
  id: "INV-1", status: "pending", due_date: "2026-09-01", amount: 100_000, net_payable: 100_000,
  paid_amount: 0, tax_rate: 18, ...over,
});
const rupee = (n: number) => `Rs ${n}`;

describe("resolveLateFee — 4 levels, most specific non-Default wins (all combos)", () => {
  const modes: LateFeeMode[] = ["default", "on", "off"];
  for (const company of [true, false]) {
    for (const customer of modes) {
      for (const subscription of modes) {
        for (const invoice of modes) {
          it(`company ${company ? "on" : "off"} / customer ${customer} / sub ${subscription} / invoice ${invoice}`, () => {
            const e = resolveLateFee({
              company: { enabled: company, since: "2026-09-01" },
              customer: { mode: customer, since: "2026-09-02" },
              subscription: { mode: subscription, since: "2026-09-03" },
              invoice: { mode: invoice, since: "2026-09-04" },
            });
            const winner = invoice !== "default" ? ["invoice", invoice]
              : subscription !== "default" ? ["subscription", subscription]
              : customer !== "default" ? ["customer", customer]
              : ["company", company ? "on" : "off"];
            expect(e.source).toBe(winner[0]);
            expect(e.on).toBe(winner[1] === "on");
          });
        }
      }
    }
  }

  it("card example: company off + one customer on → only that customer's invoices", () => {
    expect(resolveLateFee({ company: { enabled: false, since: null }, customer: { mode: "on" } }).on).toBe(true);
    expect(resolveLateFee({ company: { enabled: false, since: null } }).on).toBe(false);
  });
  it("card example: customer on + invoice off → not on that invoice", () => {
    const e = resolveLateFee({ company: { enabled: false, since: null }, customer: { mode: "on" }, invoice: { mode: "off" } });
    expect(e).toMatchObject({ on: false, source: "invoice" });
  });
  it("card example: subscription off → none of its invoices, even with the customer on", () => {
    const e = resolveLateFee({ company: { enabled: true, since: null }, customer: { mode: "on" }, subscription: { mode: "off" } });
    expect(e).toMatchObject({ on: false, source: "subscription" });
  });
  it("since comes from the winning level, and only when it is On", () => {
    expect(resolveLateFee({ company: { enabled: true, since: "2026-09-01" }, customer: { mode: "on", since: "2026-10-01" } }).since).toBe("2026-10-01");
    expect(resolveLateFee({ company: { enabled: true, since: "2026-09-01" } }).since).toBe("2026-09-01");
    expect(resolveLateFee({ company: { enabled: false, since: "2026-09-01" } }).since).toBeNull();
  });
  it("waiver is an invoice-level off with its reason, and beats everything", () => {
    const e = resolveLateFee({ company: { enabled: true, since: null }, customer: { mode: "on" }, invoice: { mode: "off", waived: true, waiveReason: "bank delay" } });
    expect(e).toMatchObject({ on: false, source: "invoice", waived: true, waiveReason: "bank delay" });
    expect(lateFeeLabel(e)).toBe("Late fee: Waived (on this invoice)");
  });
  it("label names the source", () => {
    expect(lateFeeLabel({ on: true, source: "customer", waived: false })).toBe("Late fee: On (from customer)");
    expect(lateFeeLabel({ on: false, source: "company", waived: false })).toBe("Late fee: Off (from company setting)");
  });
});

describe("settings, roles, registration", () => {
  it("missing row = OFF with the card's defaults", () => {
    expect(lateFeeSettingsFromRow(null, (s) => s)).toEqual(DEFAULT_LATE_FEE_SETTINGS);
    expect(DEFAULT_LATE_FEE_SETTINGS).toMatchObject({ enabled: false, interestPct: 18, flatFee: 500, graceDays: 0, interestRegisteredOnly: true });
  });
  it("reads numeric strings and the enabled date", () => {
    const s = lateFeeSettingsFromRow({ late_fee_enabled: true, late_interest_pct: "24.00", late_fee_flat: 300, late_fee_grace_days: 5, late_interest_registered_only: false, late_fee_enabled_at: "2026-10-01T20:00:00Z" }, (x) => x.slice(0, 10));
    expect(s).toEqual({ enabled: true, interestPct: 24, flatFee: 300, graceDays: 5, interestRegisteredOnly: false, enabledOn: "2026-10-01" });
  });
  it("owner/manager toggle; only owner bills", () => {
    expect([mayToggleLateFee("owner"), mayToggleLateFee("manager"), mayToggleLateFee("sales")]).toEqual([true, true, false]);
    expect([mayBillLateCharges("owner"), mayBillLateCharges("manager")]).toEqual([true, false]);
  });
  it("GSTIN on the invoice or the customer = registered", () => {
    expect(isGstRegistered(null, "07AABCA1234A1Z5")).toBe(true);
    expect(isGstRegistered("", null, undefined)).toBe(false);
  });
});

describe("computeLateCharges", () => {
  const base = { settings: ON, effective: eff(), registered: true, payments: [], bills: [] };

  it("Rs 1,00,000 unpaid 30 days: Rs 500 fee + 18% × 30/365 interest", () => {
    const v = computeLateCharges({ ...base, invoice: inv(), today: "2026-10-01" });
    expect(v.daysLate).toBe(30);
    expect(v.feeAccrued).toBe(500);
    expect(v.interestAccrued).toBe(Math.round(100_000 * 18 * 30 / 36_500)); // 1479
    expect(v.toBill).toBe(500 + 1479);
    expect(v.gstToBill).toBe(Math.round(1979 * 0.18));
    expect(v.grossToBill).toBe(1979 + 356);
  });

  it("not yet late on the due date itself", () => {
    const v = computeLateCharges({ ...base, invoice: inv(), today: "2026-09-01" });
    expect(v).toMatchObject({ applies: true, daysLate: 0, feeAccrued: 0, interestAccrued: 0, toBill: 0 });
  });

  it("grace: nothing inside grace; after it, the fee and interest from grace end", () => {
    const g = { ...ON, graceDays: 5 };
    expect(computeLateCharges({ ...base, settings: g, invoice: inv(), today: "2026-09-06" }).toBill).toBe(0);
    const v = computeLateCharges({ ...base, settings: g, invoice: inv(), today: "2026-09-16" });
    expect(v.daysLate).toBe(10);
    expect(v.feeAccrued).toBe(500);
    expect(v.interestAccrued).toBe(Math.round(100_000 * 18 * 10 / 36_500));
  });

  it("paid within grace → no fee at all", () => {
    const g = { ...ON, graceDays: 5 };
    const v = computeLateCharges({
      ...base, settings: g, invoice: inv({ status: "paid", paid_amount: 100_000 }),
      payments: [{ amount: 100_000, date: "2026-09-04" }], today: "2026-10-01",
    });
    expect(v).toMatchObject({ daysLate: 0, feeAccrued: 0, interestAccrued: 0, toBill: 0 });
  });

  it("partial payment: interest on the outstanding balance per period", () => {
    // 10 days on 1,00,000 then 20 days on 40,000.
    const v = computeLateCharges({
      ...base, invoice: inv({ paid_amount: 60_000 }),
      payments: [{ amount: 60_000, date: "2026-09-11" }], today: "2026-10-01",
    });
    const expected = Math.round((100_000 * 10 + 40_000 * 20) * 18 / 36_500);
    expect(v.interestAccrued).toBe(expected);
    expect(v.outstanding).toBe(40_000);
    expect(v.feeAccrued).toBe(500);
  });

  it("paid late in full: interest stops on the payment day, fee stays", () => {
    const v = computeLateCharges({
      ...base, invoice: inv({ status: "paid", paid_amount: 100_000 }),
      payments: [{ amount: 100_000, date: "2026-09-11" }], today: "2026-10-01",
    });
    expect(v.daysLate).toBe(10);
    expect(v.interestAccrued).toBe(Math.round(100_000 * 18 * 10 / 36_500));
    expect(v.outstanding).toBe(0);
  });

  it("unregistered customer = flat fee only (default rule)", () => {
    const v = computeLateCharges({ ...base, registered: false, invoice: inv(), today: "2026-10-01" });
    expect(v).toMatchObject({ interestApplies: false, interestAccrued: 0, feeAccrued: 500, toBill: 500 });
  });

  it("unregistered still pays interest when the company charges everyone", () => {
    const v = computeLateCharges({ ...base, settings: { ...ON, interestRegisteredOnly: false }, registered: false, invoice: inv(), today: "2026-10-01" });
    expect(v.interestAccrued).toBe(1479);
  });

  it("off or waived → nothing", () => {
    expect(computeLateCharges({ ...base, effective: eff({ on: false }), invoice: inv(), today: "2026-10-01" }))
      .toMatchObject({ applies: false, toBill: 0 });
    const w = computeLateCharges({ ...base, effective: eff({ on: false, waived: true, waiveReason: "bank delay", source: "invoice" }), invoice: inv(), today: "2026-10-01" });
    expect(w).toMatchObject({ applies: false, toBill: 0 });
    expect(w.reason).toContain("bank delay");
  });

  it("charges count only from the day late fees were switched on", () => {
    const v = computeLateCharges({ ...base, effective: eff({ since: "2026-09-21" }), invoice: inv(), today: "2026-10-01" });
    expect(v.daysLate).toBe(11); // 21 Sep .. 1 Oct
    expect(v.interestFrom).toBe("2026-09-21");
  });

  it("already billed: fee once, interest only the new part, principal without the debit note", () => {
    const gross = 500 + 1479 + Math.round(1979 * 0.18);
    const v = computeLateCharges({
      ...base, invoice: inv({ net_payable: 100_000 + gross }),
      bills: [{ fee_amount: 500, interest_amount: 1479, gross_amount: gross }],
      today: "2026-10-11",
    });
    expect(v.feeToBill).toBe(0);
    expect(v.interestAccrued).toBe(Math.round(100_000 * 18 * 40 / 36_500)); // principal stays 1,00,000
    expect(v.interestToBill).toBe(v.interestAccrued - 1479);
  });

  it("R-368 interest debit notes count as interest already billed", () => {
    const v = computeLateCharges({
      ...base, invoice: inv({ net_payable: 100_000 + 1180 }),
      debitNotes: [{ amount: 1180, taxable_value: 1000, notes: "Late payment interest @18% p.a. simple" }],
      today: "2026-10-01",
    });
    expect(v.interestBilled).toBe(1000);
    expect(v.interestToBill).toBe(479);
  });

  it("no GST rate on the invoice → GST unknown (billing refused), never assumed", () => {
    const v = computeLateCharges({ ...base, invoice: inv({ tax_rate: null }), today: "2026-10-01" });
    expect(v.toBill).toBeGreaterThan(0);
    expect(v.gstToBill).toBeNull();
    expect(v.grossToBill).toBeNull();
  });

  it("void / draft / no due date → nothing", () => {
    expect(computeLateCharges({ ...base, invoice: inv({ status: "void" }), today: "2026-10-01" }).applies).toBe(false);
    expect(computeLateCharges({ ...base, invoice: inv({ due_date: null }), today: "2026-10-01" }).applies).toBe(false);
  });
});

describe("invoicePaymentTimeline", () => {
  it("skips advances adjusted at issue and caps at the paid amount", () => {
    const t = invoicePaymentTimeline({
      payments: [{ id: "adv", amount: 5000, date: "2026-08-01" }, { id: "p1", amount: 3000, date: "2026-09-05" }, { id: "p2", amount: 9000, date: "2026-09-10" }],
      adjustedPaymentIds: ["adv"], paidAmount: 7000, principal: 20_000, status: "pending", dueDate: "2026-09-01",
    });
    expect(t).toEqual([{ amount: 3000, date: "2026-09-05" }, { amount: 4000, date: "2026-09-10" }]);
  });
  it("an undated paid amount counts as paid on the due date (no interest on it)", () => {
    const t = invoicePaymentTimeline({ payments: [], paidAmount: 2000, principal: 10_000, status: "pending", dueDate: "2026-09-01" });
    expect(t).toEqual([{ amount: 2000, date: "2026-09-01" }]);
  });
  it("a paid invoice is fully covered even if paid_amount was never written", () => {
    const t = invoicePaymentTimeline({ payments: [{ amount: 10_000, date: "2026-09-20" }], paidAmount: 0, principal: 10_000, status: "paid", dueDate: "2026-09-01" });
    expect(t).toEqual([{ amount: 10_000, date: "2026-09-20" }]);
  });
});

describe("charges invoice math", () => {
  it("taxable + GST at the invoice's rate, matches bill_late_charges", () => {
    expect(lateChargeBillMath(500, 175, 18)).toEqual({ taxable: 675, gst: 122, gross: 797 });
    expect(lateChargeBillMath(500, 0, 0)).toEqual({ taxable: 500, gst: 0, gross: 500 });
    expect(lateChargeBillMath(500, 0, null)).toBeNull();
  });
  it("the debit-note back-calculation recovers the taxable value exactly", () => {
    for (let t = 1; t < 5000; t += 37) {
      const m = lateChargeBillMath(t, 0, 18)!;
      expect(Math.round((m.gross * 100) / 118)).toBe(t);
    }
  });
  it("sentence for the reminder email", () => {
    const s = lateChargesSentence({ applies: true, feeToBill: 500, interestToBill: 1479, interestPct: 18, daysLate: 30 }, rupee);
    expect(s).toBe("Late payment charges so far: Rs 500 late fee + Rs 1479 interest (18% a year for 30 days), plus GST. These are billed separately as a debit note; paying the invoice now stops further interest.");
    expect(lateChargesSentence({ applies: true, feeToBill: 0, interestToBill: 0, interestPct: 18, daysLate: 0 }, rupee)).toBeNull();
  });
});
