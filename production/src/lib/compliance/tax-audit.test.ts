import { describe, it, expect } from "vitest";
import {
  taxAuditStatus, cashShares, TAX_AUDIT_LIMITS, taxAuditFyFor, inrShort,
} from "./tax-audit";
import { buildComplianceRows, obligationsFor } from "./obligations";

const CR = 1_00_00_000;
const L = 1_00_000;

describe("R-1859 taxAuditStatus — s.44AB from turnover + cash share", () => {
  it("the limits are the CBDT ones: ₹1 Cr, ₹10 Cr when cash ≤ 5 %, report by 30 Sep, ITR 31 Oct", () => {
    expect(TAX_AUDIT_LIMITS.basic).toBe(CR);
    expect(TAX_AUDIT_LIMITS.raised).toBe(10 * CR);
    expect(TAX_AUDIT_LIMITS.cashPct).toBe(5);
    expect(TAX_AUDIT_LIMITS.reportDue).toEqual({ month: 9, day: 30 });
    expect(TAX_AUDIT_LIMITS.itrDueAudited).toEqual({ month: 10, day: 31 });
    expect(TAX_AUDIT_LIMITS.sources.every((s) => /incometaxindia\.gov\.in/.test(s.url))).toBe(true);
  });

  it("₹62L → not applicable, with the turnover in the reason", () => {
    const r = taxAuditStatus({ businessType: "proprietor", fyStartYear: 2025, turnover: 62 * L, cashReceiptsPct: null, cashPaymentsPct: null });
    expect(r.verdict).toBe("not_applicable");
    expect(r.reason).toMatch(/₹62L/);
    expect(r.reason).toMatch(/₹1 Cr/);
  });

  it("exactly ₹1 Cr → not applicable (the Act says 'exceeds')", () => {
    expect(taxAuditStatus({ businessType: "partnership", fyStartYear: 2025, turnover: CR, cashReceiptsPct: null, cashPaymentsPct: null }).verdict).toBe("not_applicable");
  });

  it("₹3 Cr + cash 2 % / 1 % → not applicable (₹10 Cr limit)", () => {
    const r = taxAuditStatus({ businessType: "proprietor", fyStartYear: 2025, turnover: 3 * CR, cashReceiptsPct: 2, cashPaymentsPct: 1 });
    expect(r.verdict).toBe("not_applicable");
    expect(r.reason).toMatch(/₹10 Cr/);
  });

  it("₹3 Cr + cash receipts 8 % → applies", () => {
    const r = taxAuditStatus({ businessType: "proprietor", fyStartYear: 2025, turnover: 3 * CR, cashReceiptsPct: 8, cashPaymentsPct: 1 });
    expect(r.verdict).toBe("applies");
    expect(r.reason).toMatch(/8%/);
  });

  it("₹3 Cr + cash payments 6 % → applies (both receipts AND payments must be within 5 %)", () => {
    expect(taxAuditStatus({ businessType: "llp", fyStartYear: 2025, turnover: 3 * CR, cashReceiptsPct: 0, cashPaymentsPct: 6 }).verdict).toBe("applies");
  });

  it("₹3 Cr + cash share unknown → maybe, says what is missing", () => {
    const r = taxAuditStatus({ businessType: "proprietor", fyStartYear: 2025, turnover: 3 * CR, cashReceiptsPct: null, cashPaymentsPct: null });
    expect(r.verdict).toBe("maybe");
    expect(r.reason).toMatch(/cash/i);
  });

  it("over ₹10 Cr → applies whatever the cash share", () => {
    expect(taxAuditStatus({ businessType: "proprietor", fyStartYear: 2025, turnover: 12 * CR, cashReceiptsPct: 0, cashPaymentsPct: 0 }).verdict).toBe("applies");
  });

  it("turnover not known → maybe", () => {
    expect(taxAuditStatus({ businessType: "proprietor", fyStartYear: 2025, turnover: null, cashReceiptsPct: null, cashPaymentsPct: null }).verdict).toBe("maybe");
  });

  it("company (and an empty type = Pvt Ltd): statutory audit always, tax audit by the same rule", () => {
    const small = taxAuditStatus({ businessType: null, fyStartYear: 2025, turnover: 62 * L, cashReceiptsPct: null, cashPaymentsPct: null });
    expect(small.verdict).toBe("not_applicable");
    expect(small.companyNote).toMatch(/statutory audit/i);
    expect(taxAuditStatus({ businessType: "proprietor", fyStartYear: 2025, turnover: 62 * L, cashReceiptsPct: null, cashPaymentsPct: null }).companyNote).toBeNull();
  });

  it("a running FY reads 'so far'", () => {
    const r = taxAuditStatus({ businessType: "proprietor", fyStartYear: 2026, turnover: 40 * L, cashReceiptsPct: null, cashPaymentsPct: null, partialYear: true });
    expect(r.reason).toMatch(/so far/i);
  });
});

describe("R-1859 cashShares — from bank / cash account lines", () => {
  it("cash-account lines over all lines; transfers between own accounts left out", () => {
    const s = cashShares([
      { credit: 98_000, debit: 0, isCash: false, isTransfer: false },
      { credit: 2_000, debit: 0, isCash: true, isTransfer: false },
      { credit: 0, debit: 50_000, isCash: false, isTransfer: false },
      { credit: 0, debit: 5_000, isCash: true, isTransfer: false },
      { credit: 10_000, debit: 0, isCash: true, isTransfer: true },   // bank → petty cash
      { credit: 0, debit: 10_000, isCash: false, isTransfer: true },
    ]);
    expect(s).toEqual({ receiptsPct: 2, paymentsPct: 5 / 55 * 100 });
  });
  it("no bank lines at all (only cash, or nothing) → unknown", () => {
    expect(cashShares([])).toBeNull();
    expect(cashShares([{ credit: 1000, debit: 0, isCash: true, isTransfer: false }])).toBeNull();
  });
});

describe("R-1859 calendar rows", () => {
  const today = new Date(2026, 9, 25); // 25 Oct 2026
  it("the audit FY is the one the next report is for (FY 2025-26 on 25 Oct 2026)", () => {
    expect(taxAuditFyFor(today, () => false)).toBe(2025);
  });

  it("not applicable → the Tax audit row reads N/A with the reason; ITR stays on 31 Jul", () => {
    const taxAudit = taxAuditStatus({ businessType: "proprietor", fyStartYear: 2025, turnover: 62 * L, cashReceiptsPct: null, cashPaymentsPct: null });
    const rows = buildComplianceRows(new Date(2026, 8, 1), new Map(), ["income_tax"], undefined, { businessType: "proprietor", gstFiling: null, taxAudit });
    const audit = rows.find((r) => r.ob.key === "it_taxaudit")!;
    expect(audit.status).toBe("not_applicable");
    expect(audit.ob.applies).toMatch(/₹62L/);
    const itr = rows.find((r) => r.ob.key === "it_itr_business")!;
    expect(itr.inst.dueDate.slice(5)).toBe("07-31");
  });

  it("applies → Tax audit row is due 30 Sep and the business ITR moves to 31 Oct", () => {
    const taxAudit = taxAuditStatus({ businessType: "proprietor", fyStartYear: 2025, turnover: 3 * CR, cashReceiptsPct: 8, cashPaymentsPct: 1 });
    const rows = buildComplianceRows(today, new Map(), ["income_tax"], undefined, { businessType: "proprietor", gstFiling: null, taxAudit });
    const audit = rows.find((r) => r.ob.key === "it_taxaudit")!;
    expect(audit.status).toBe("overdue");
    expect(audit.inst.dueDate).toBe("2026-09-30");
    const itr = rows.find((r) => r.ob.key === "it_itr_business")!;
    expect(itr.inst.dueDate).toBe("2026-10-31");
    expect(itr.inst.periodLabel).toMatch(/2025-26/);
  });

  it("no verdict (not loaded) → the calendar is exactly as before", () => {
    const before = obligationsFor({ businessType: "proprietor", gstFiling: null });
    const audit = before.find((o) => o.key === "it_taxaudit")!;
    expect(audit.applies).toMatch(/₹1 cr/);
  });

  it("inrShort writes lakh / crore the Indian way", () => {
    expect(inrShort(62 * L)).toBe("₹62L");
    expect(inrShort(3 * CR)).toBe("₹3 Cr");
    expect(inrShort(1.25 * CR)).toBe("₹1.25 Cr");
    expect(inrShort(45_000)).toBe("₹45,000");
  });
});
