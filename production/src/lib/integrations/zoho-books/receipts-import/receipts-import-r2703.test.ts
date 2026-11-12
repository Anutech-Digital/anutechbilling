/**
 * R-2703 — Zoho receipts whose invoice is outside the year being imported. The owner's real cases on
 * staging Excel (12 Nov 2026), names and numbers made up here:
 *   - 18 receipts on FY 2024-25 invoices with no opening invoice in the app, 7 on FY 2026-27 invoices
 *     paid early and one on a credit / debit note were all left out with "import FY sales first";
 *   - a ₹0 line (30 paise) blocked a ₹15,676 receipt;
 *   - 11 receipts on opening invoices that are already paid here said "re-stated by R-2504 first".
 * This card changes the REASON (and ignores ₹0 lines) — it books nothing new.
 */
import { describe, it, expect } from "vitest";
import type { ZohoFyDocDetail } from "../fy-fetch";
import { zohoReceiptFacts, type ReceiptLine, type ZohoReceiptFacts } from "./normalise";
import { buildReceiptsPlan, invoiceYearOf, type AppZohoInvoice, type ReceiptsPlanContext } from "./plan";

const line = (zohoInvoiceId: string, invoiceNumber: string, settle: number, tds = 0, invoiceDate?: string): ReceiptLine =>
  ({ zohoInvoiceId, invoiceNumber, settle, tds, ...(invoiceDate ? { invoiceDate } : {}) });

function facts(id: string, lines: ReceiptLine[], extra: Partial<ZohoReceiptFacts> = {}): ZohoReceiptFacts {
  const amount = lines.reduce((s, l) => s + l.settle - l.tds, 0);
  return {
    zohoId: id, number: id, date: "2025-06-10", status: "", zohoCustomerId: "zc1", customerName: "Test Buyer", method: "bank_transfer",
    zohoMode: "Bank Transfer", reference: `UTR-${id}`, depositAccountId: "za4523", depositAccountName: "HDFC Current 4523",
    amount, receivedPaise: amount * 100, lines, excess: 0, tds: lines.reduce((s, l) => s + l.tds, 0), fee: 0, feeGst: 0,
    viaSettlement: false, problems: [], currency: "INR", foreignAmount: null, fxRate: null, ...extra,
  };
}
const usd = (id: string, no: string): ZohoReceiptFacts => facts(id, [line("zusd", no, 100)], {
  currency: "USD", foreignAmount: 100, fxRate: 85, amount: 8500, foreignLines: [{ zohoInvoiceId: "zusd", invoiceNumber: no, foreign: 100 }], foreignCharges: 0,
});

const sale: AppZohoInvoice = { id: "INV/25-26/0001", zohoInvoiceId: "zi1", externalNumber: "INV/25-26/0001", documentKind: "tax_invoice", customerId: "c1", due: 5000 };
const opening = (no: string, due: number, extra: Partial<AppZohoInvoice> = {}): AppZohoInvoice =>
  ({ id: no, zohoInvoiceId: null, externalNumber: no, documentKind: "opening_invoice", customerId: "c1", due, ...extra });

function ctx(extra: Partial<ReceiptsPlanContext> = {}): ReceiptsPlanContext {
  return {
    fyStart: "2025-04-01", fyEnd: "2026-03-31", booksStart: "2025-04-01", lockedUntil: null,
    invoices: [sale, opening("INV/24-25/1810", 0), opening("INV/24-25/1663", 780)],
    bankAccounts: [{ id: "b4523", name: "Current", bank_name: "HDFC", account_number_last4: "4523", account_type: "current", is_active: true }],
    booked: new Map(), accountMap: {},
    /* this year's Zoho invoices as read: the imported one and one that was left out of the sales import */
    fyInvoiceIds: new Set(["zi1", "zi-leftout"]),
    ...extra,
  };
}
const one = (f: ZohoReceiptFacts, c: Partial<ReceiptsPlanContext> = {}) => buildReceiptsPlan([f], ctx(c)).rows[0];

describe("R-2703 — which year an invoice belongs to", () => {
  it("Zoho's invoice date wins over the number; else the 24-25 in the number; else not known", () => {
    expect(invoiceYearOf({ invoiceNumber: "INV/24-25/1536" })).toBe(2024);
    expect(invoiceYearOf({ invoiceNumber: "LSINV/24-25/0578" })).toBe(2024);
    expect(invoiceYearOf({ invoiceNumber: "INV/26-27/0077" })).toBe(2026);
    expect(invoiceYearOf({ invoiceNumber: "INV/25-26/1979", invoiceDate: "2025-01-28" })).toBe(2024);
    expect(invoiceYearOf({ invoiceNumber: "X", invoiceDate: "2025-04-01" })).toBe(2025);
    expect(invoiceYearOf({ invoiceNumber: "X", invoiceDate: "2026-03-31" })).toBe(2025);
    expect(invoiceYearOf({ invoiceNumber: "CDN-000004" })).toBeNull();
    expect(invoiceYearOf({ invoiceNumber: "INV-A378-26-0001" })).toBeNull();   // 78-26 / 26-00 are not a year pair
    expect(invoiceYearOf({ invoiceNumber: "INV/99-00/1" })).toBe(2099);
  });

  it("the facts keep Zoho's invoice date when the payment detail gives one", () => {
    const d: ZohoFyDocDetail = {
      kind: "customerpayments", id: "p1", number: "7137", date: "2025-04-02", status: "", contactId: "zc1", contactName: "Buyer", totalPaise: 0,
      balancePaise: null, currency: "INR", lines: [], taxes: [], taxTotalPaise: 0, tdsPaise: 0, gstNo: "", gstTreatment: "", placeOfSupply: "", reverseCharge: false,
      raw: { amount: 20000, unused_amount: 0, currency_code: "INR", payment_mode: "Bank Transfer", account_id: "za", account_name: "HDFC",
        invoices: [{ invoice_id: "z1979", invoice_number: "INV/25-26/1979", date: "2025-01-28", amount_applied: 20000 },
          { invoice_id: "z2", invoice_number: "INV/25-26/0002", amount_applied: 0.3 }] },
    };
    const f = zohoReceiptFacts(d);
    expect(f.lines[0]).toEqual({ zohoInvoiceId: "z1979", invoiceNumber: "INV/25-26/1979", settle: 20000, tds: 0, invoiceDate: "2025-01-28" });
    expect(f.lines[1]).toEqual({ zohoInvoiceId: "z2", invoiceNumber: "INV/25-26/0002", settle: 0, tds: 0 });   // no date in Zoho → no key
  });
});

describe("R-2703 — the reason never says 'import FY sales first' for another year's invoice", () => {
  it("an earlier year's invoice with no opening invoice: add it as an opening invoice", () => {
    const r = one(facts("5594", [line("zi1", "INV/25-26/0001", 6001), line("zold", "INV/24-25/1536", 517)]));
    expect(r.verdict).toBe("skip");
    expect(r.reason).toBe("INV/24-25/1536 is an invoice of FY 2024-25 — add it as an opening invoice, then record this payment on it.");
    expect(one(facts("0257", [line("zls", "LSINV/24-25/0963", 2365)])).reason).toMatch(/^LSINV\/24-25\/0963 is an invoice of FY 2024-25 — add it as an opening invoice/);
    /* a foreign payment: an opening invoice cannot take it — by hand */
    expect(one(usd("u", "INV/24-25/0900")).reason).toBe("INV/24-25/0900 is an invoice of FY 2024-25 and this payment is in USD — book it by hand.");
  });

  it("numbered in this year but dated in an earlier one (INV/25-26/1979, 28 Jan 2025)", () => {
    /* facts read before R-2703 carry no invoice date: not among the year's Zoho invoices → check its date */
    const old = one(facts("7137", [line("z1979", "INV/25-26/1979", 20000)]));
    expect(old.verdict).toBe("skip");
    expect(old.reason).toBe("INV/25-26/1979 is not among the FY 2025-26 invoices read from Zoho — check its date in Zoho: an earlier year's invoice is added as an opening invoice, a later year's is paid in the app.");
    /* read after R-2703: the date says FY 2024-25 */
    expect(one(facts("7137", [line("z1979", "INV/25-26/1979", 20000, 0, "2025-01-28")])).reason)
      .toMatch(/^INV\/25-26\/1979 is an invoice of FY 2024-25 — add it as an opening invoice/);
  });

  it("this year's invoice that Zoho has but the sales import left out: still 'import FY sales first'", () => {
    const r = one(facts("p", [line("zi-leftout", "INV/25-26/0777", 1000)]));
    expect(r.reason).toBe("INV/25-26/0777 is not an FY sale imported from Zoho here — import FY sales first (Invoices → FY 2025-26 sales from Zoho).");
    /* in the year's scan whatever its number says */
    expect(one(facts("p", [line("zi-leftout", "INV/26-27/0009", 1000)])).reason).toMatch(/import FY sales first/);
    /* the year's invoices not read yet → the same advice */
    expect(one(facts("p", [line("zx", "INV/25-26/0778", 1000)]), { fyInvoiceIds: new Set() }).reason).toMatch(/import FY sales first/);
    expect(one(facts("p", [line("zx", "INV/25-26/0778", 1000)]), { fyInvoiceIds: undefined }).reason).toMatch(/import FY sales first/);
  });

  it("a later year's invoice (paid early): record the payment on that invoice in the app — nothing is booked", () => {
    const whole = one(facts("7795", [line("z77", "INV/26-27/0077", 2974)], { date: "2026-03-31" }));
    expect(whole.verdict).toBe("skip");
    expect(whole.reason).toBe("INV/26-27/0077 is an invoice of FY 2026-27 — record this payment on that invoice in the app.");
    /* also when the payment pays this year's invoices too: the WHOLE payment is left out (no advance is made up) */
    const mixed = buildReceiptsPlan([facts("7179", [line("zi1", "INV/25-26/0001", 4438), line("z1043", "INV/26-27/1043", 189)], { date: "2026-01-13" })], ctx());
    expect(mixed.rows[0].verdict).toBe("skip");
    expect(mixed.rows[0].reason).toBe("INV/26-27/1043 is an invoice of FY 2026-27 — record this payment on that invoice in the app.");
    expect(mixed.totals).toEqual({ cash: 0, tds: 0, excess: 0, fee: 0 });
    expect(one(usd("u", "INV/26-27/0078")).reason).toBe("INV/26-27/0078 is an invoice of FY 2026-27 — record this payment on that invoice in the app.");
  });

  it("a credit / debit note line (CDN-000004): book by hand", () => {
    const r = one(facts("6829", [line("zi1", "INV/25-26/0001", 4403), line("zcdn", "CDN-000004", 317)]));
    expect(r.verdict).toBe("skip");
    expect(r.reason).toBe("CDN-000004 is a credit / debit note in Zoho, not an invoice — book this payment by hand.");
  });

  it("an opening invoice here is never paid from the import: paid → in the books; due → by hand; void", () => {
    const paid = one(facts("5010", [line("zo", "inv/24-25/1810 ", 207, 4)]));
    expect(paid.verdict).toBe("skip");
    expect(paid.reason).toBe("inv/24-25/1810  is an opening invoice that is already paid here — this receipt is in the books already.");
    const due = one(facts("6556", [line("zo2", "INV/24-25/1663", 780)]));
    expect(due.verdict).toBe("skip");
    expect(due.reason).toBe("INV/24-25/1663 is an opening invoice here with ₹780 still due — its balance was taken when it was added and may already leave this receipt out. If it does not, record this payment on it by hand (Invoices → INV/24-25/1663 → Record payment).");
    const voided = one(facts("v", [line("zo", "INV/24-25/1810", 207)]), { invoices: [sale, opening("INV/24-25/1810", 0, { voided: true })] });
    expect(voided.reason).toBe("INV/24-25/1810 is an opening invoice that is void here — book this payment by hand.");
  });

  it("the skip reasons group by kind (one line per kind with its count)", () => {
    const p = buildReceiptsPlan([
      facts("a", [line("z1", "INV/24-25/1536", 517)]), facts("b", [line("z2", "LSINV/24-25/0963", 4437)]),
      facts("c", [line("z3", "INV/26-27/0077", 2974)]),
    ], ctx());
    expect(p.skipReasons).toEqual([
      { reason: "… is an invoice of FY 2024-25 — add it as an opening invoice, then record this payment on it.", count: 2 },
      { reason: "… is an invoice of FY 2026-27 — record this payment on that invoice in the app.", count: 1 },
    ]);
  });
});

describe("R-2703 — a ₹0 line is ignored", () => {
  it("30 paise on other invoices no longer block the ₹15,676 on this year's invoice (receipt 6407)", () => {
    /* one ₹0 line on an invoice that IS here (another customer's, nothing due), one on a later-year invoice */
    const other: AppZohoInvoice = { ...sale, id: "INV/25-26/1480", zohoInvoiceId: "zi1480", externalNumber: "INV/25-26/1480", customerId: "c9", due: 0 };
    const f = facts("6407", [line("zi1", "INV/25-26/0001", 4676), line("zi1480", "INV/25-26/1480", 0), line("z15", "INV/26-27/0015", 0)]);
    const p = buildReceiptsPlan([f], ctx({ invoices: [{ ...sale, due: 4676 }, other] }));
    expect(p.rows[0]).toMatchObject({ verdict: "import", customerId: "c1", invoiceIds: ["INV/25-26/0001", null, null] });
    expect(p.totals).toMatchObject({ cash: 4676, excess: 0 });
  });

  it("a payment with only ₹0 lines books nothing", () => {
    const r = one(facts("z", [line("zq", "INV/26-27/0015", 0)], { amount: 1, receivedPaise: 30 }));
    expect(r.verdict).toBe("skip");
    expect(r.reason).toBe("Zoho applies no whole rupee of this payment to an invoice — record it by hand.");
  });

  it("a foreign payment's lines are not rupees: a 0 there is not skipped as a ₹0 line", () => {
    const f = { ...usd("u", "INV/26-27/0078"), lines: [line("zusd", "INV/26-27/0078", 0)] };
    expect(one(f).reason).toMatch(/is an invoice of FY 2026-27/);
  });
});
