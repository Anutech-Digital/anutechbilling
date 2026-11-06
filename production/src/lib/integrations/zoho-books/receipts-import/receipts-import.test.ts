/**
 * R-2501 — FY 2025-26 Zoho customer payments → receipts (+ TDS) on the imported Zoho invoices.
 * Zoho v3 detail shapes (money in rupees as Zoho sends it); names and numbers are made up.
 */
import { describe, it, expect } from "vitest";
import type { ZohoFyDocDetail } from "../fy-fetch";
import { zohoReceiptFacts, appMethod, apportion, type ZohoReceiptFacts } from "./normalise";
import { LEAVE_OUT, buildReceiptsPlan, suggestAccount, toReceiptPick, type ReceiptsPlanContext, type AppBankAccount } from "./plan";
import { parseAccountMap } from "./store";

function detail(raw: Record<string, unknown>): ZohoFyDocDetail {
  return {
    kind: "customerpayments", id: String(raw.payment_id ?? "p1"), number: String(raw.payment_number ?? "101"), date: String(raw.date ?? "2025-06-10"),
    status: "", contactId: "zc1", contactName: "Test Buyer", totalPaise: 0, balancePaise: null, currency: "INR", raw,
    lines: [], taxes: [], taxTotalPaise: 0, tdsPaise: 0, gstNo: "", gstTreatment: "", placeOfSupply: "", reverseCharge: false,
  };
}

const base = {
  payment_id: "p1", payment_number: "101", date: "2025-06-10", payment_mode: "Bank Transfer", reference_number: "UTR123",
  account_id: "za4523", account_name: "HDFC Current 4523", currency_code: "INR", bank_charges: 0,
};

describe("R-2501 normalise — paise → rupees once; Zoho's own TDS only", () => {
  it("splits applied + TDS per invoice; cash = settle − TDS; excess = unused", () => {
    const f = zohoReceiptFacts(detail({
      ...base, amount: 10900.1, unused_amount: 1000, tax_amount_withheld: 246.9,
      invoices: [
        { invoice_id: "zi1", invoice_number: "INV/25-26/0001", amount_applied: 9900.1, tax_amount_withheld: 246.9 },
      ],
    }));
    expect(f.problems).toEqual([]);
    expect(f.lines).toEqual([{ zohoInvoiceId: "zi1", invoiceNumber: "INV/25-26/0001", settle: 10147, tds: 247 }]);
    expect(f).toMatchObject({ amount: 10900, receivedPaise: 1090010, excess: 1000, tds: 247, method: "bank_transfer", reference: "UTR123", depositAccountId: "za4523" });
  });

  it("rounding: the lines' rupees add up to the money received (500.50 + 500.50 = ₹1,001, not ₹1,002)", () => {
    const f = zohoReceiptFacts(detail({ ...base, amount: 1001, unused_amount: 0, invoices: [
      { invoice_id: "zi1", invoice_number: "A", amount_applied: 500.5 }, { invoice_id: "zi2", invoice_number: "B", amount_applied: 500.5 }] }));
    expect(f.lines.map((l) => l.settle)).toEqual([501, 500]);
    expect(f.lines.reduce((s, l) => s + l.settle, 0) + f.excess).toBe(f.amount);
    expect(apportion([33333, 33333, 33334])).toEqual([333, 333, 334]);
  });

  it("no TDS in Zoho → none booked (never inferred from a short payment)", () => {
    const f = zohoReceiptFacts(detail({ ...base, amount: 900, unused_amount: 0, invoices: [{ invoice_id: "zi1", invoice_number: "A", amount_applied: 900 }] }));
    expect(f.tds).toBe(0);
    expect(f.lines[0]).toMatchObject({ settle: 900, tds: 0 });
  });

  it("refuses payments whose amounts do not add up, foreign money, bank charges, unsplit TDS", () => {
    const p = (extra: Record<string, unknown>) => zohoReceiptFacts(detail({ ...base, amount: 1000, unused_amount: 0,
      invoices: [{ invoice_id: "zi1", invoice_number: "A", amount_applied: 1000 }], ...extra })).problems.join(" | ");
    expect(p({ unused_amount: 50 })).toMatch(/do not add up/);
    expect(p({ amount: 900 })).toMatch(/more to its invoices than the payment received/);
    expect(p({ currency_code: "USD" })).toMatch(/USD/);
    expect(p({ bank_charges: 10 })).toMatch(/bank charges/);
    expect(p({ tax_amount_withheld: 100 })).toMatch(/TDS is not split by invoice/);
    expect(p({ invoices: [{ invoice_id: "zi1", amount_applied: 500 }, { invoice_id: "zi1", amount_applied: 500 }] })).toMatch(/one invoice twice/);
  });

  it("maps Zoho's payment mode to the app's method", () => {
    expect(appMethod("Cash")).toBe("cash");
    expect(appMethod("Cheque")).toBe("cheque");
    expect(appMethod("UPI")).toBe("upi");
    expect(appMethod("Bank Remittance")).toBe("bank_transfer");
    expect(appMethod("Credit Card")).toBe("other");
  });
});

const acct = (id: string, name: string, last4: string | null, accountType = "current", extra: Partial<AppBankAccount> = {}): AppBankAccount =>
  ({ id, name, bank_name: "HDFC", account_number_last4: last4, account_type: accountType, is_active: true, ...extra });

function facts(id: string, extra: Partial<ZohoReceiptFacts> = {}): ZohoReceiptFacts {
  return {
    zohoId: id, number: id, date: "2025-06-10", status: "", zohoCustomerId: "zc1", customerName: "Test Buyer", method: "bank_transfer",
    zohoMode: "Bank Transfer", reference: `UTR-${id}`, depositAccountId: "za4523", depositAccountName: "HDFC Current 4523",
    amount: 1000, receivedPaise: 100000, lines: [{ zohoInvoiceId: "zi1", invoiceNumber: "INV/25-26/0001", settle: 1000, tds: 0 }],
    excess: 0, tds: 0, problems: [], ...extra,
  };
}

function ctx(extra: Partial<ReceiptsPlanContext> = {}): ReceiptsPlanContext {
  return {
    fyStart: "2025-04-01", fyEnd: "2026-03-31", booksStart: "2025-04-01", lockedUntil: null,
    invoices: [
      { id: "INV/25-26/0001", zohoInvoiceId: "zi1", externalNumber: "INV/25-26/0001", documentKind: "tax_invoice", customerId: "c1", due: 1500 },
      { id: "INV/25-26/0002", zohoInvoiceId: "zi2", externalNumber: "INV/25-26/0002", documentKind: "tax_invoice", customerId: "c2", due: 500 },
      { id: "INV/24-25/0099", zohoInvoiceId: null, externalNumber: "INV/24-25/0099", documentKind: "opening_invoice", customerId: "c1", due: 700 },
    ],
    bankAccounts: [acct("b4523", "Current", "4523"), acct("bcash", "Petty cash", null, "cash")],
    booked: new Map(), accountMap: {}, ...extra,
  };
}

describe("R-2501 plan — receipts only onto imported Zoho sales", () => {
  it("books a payment onto its imported invoice, deposit account suggested by last 4 digits", () => {
    const p = buildReceiptsPlan([facts("p1")], ctx());
    expect(p.rows[0]).toMatchObject({ verdict: "import", customerId: "c1", bankAccountId: "b4523", invoiceIds: ["INV/25-26/0001"] });
    expect(p.deposits[0]).toMatchObject({ zohoAccountId: "za4523", appAccountId: "b4523", suggested: true });
    expect(toReceiptPick(p.rows[0])).toEqual({ zoho_payment_id: "p1", bank_account_id: "b4523" });
    expect(Object.keys(toReceiptPick(p.rows[0]))).not.toContain("amount");
  });

  it("an opening invoice or a not-imported invoice skips the WHOLE payment", () => {
    const p = buildReceiptsPlan([
      facts("p1", { lines: [{ zohoInvoiceId: "zi1", invoiceNumber: "INV/25-26/0001", settle: 500, tds: 0 }, { zohoInvoiceId: "zx", invoiceNumber: "INV/24-25/0099", settle: 500, tds: 0 }] }),
      facts("p2", { lines: [{ zohoInvoiceId: "zmissing", invoiceNumber: "INV/25-26/0777", settle: 1000, tds: 0 }] }),
    ], ctx());
    expect(p.rows[0]).toMatchObject({ verdict: "skip" });
    expect(p.rows[0].reason).toMatch(/opening invoice/);
    expect(p.rows[1].reason).toMatch(/not an FY sale imported from Zoho/);
  });

  it("refuses: before books start, in the lock, no books start, pure advance, two customers, more than due, no account", () => {
    const r = (f: ZohoReceiptFacts, c: Partial<ReceiptsPlanContext> = {}) => buildReceiptsPlan([f], ctx(c)).rows[0].reason ?? "";
    expect(r(facts("a", { date: "2025-04-20" }), { booksStart: "2025-05-01" })).toMatch(/before the books start/);
    expect(r(facts("a"), { lockedUntil: "2025-06-30" })).toMatch(/books lock/);
    expect(r(facts("a"), { booksStart: null })).toMatch(/books start date is not set/);
    expect(r(facts("a", { lines: [] }))).toMatch(/advance/);
    expect(r(facts("a", { lines: [{ zohoInvoiceId: "zi1", invoiceNumber: "1", settle: 100, tds: 0 }, { zohoInvoiceId: "zi2", invoiceNumber: "2", settle: 100, tds: 0 }] }))).toMatch(/different customers/);
    expect(r(facts("a", { lines: [{ zohoInvoiceId: "zi1", invoiceNumber: "INV/25-26/0001", settle: 1600, tds: 0 }] }))).toMatch(/only ₹1500 due/);
    expect(r(facts("a", { depositAccountId: "zx", depositAccountName: "Some Wallet" }))).toMatch(/Choose the app account/);
    expect(r(facts("a", { problems: ["Zoho took bank charges off this payment — book it by hand."] }))).toMatch(/bank charges/);
  });

  it("two payments on one invoice: the second sees what the first took", () => {
    const p = buildReceiptsPlan([facts("p1"), facts("p2", { lines: [{ zohoInvoiceId: "zi1", invoiceNumber: "INV/25-26/0001", settle: 1000, tds: 0 }] })], ctx());
    expect(p.rows.map((x) => x.verdict)).toEqual(["import", "skip"]);
    expect(p.rows[1].reason).toMatch(/only ₹500 due/);
  });

  it("rerun: an imported payment is 'already'; one with no bank line yet says so", () => {
    const p = buildReceiptsPlan([facts("p1"), facts("p2")], ctx({ booked: new Map([["p1", { banked: true }], ["p2", { banked: false }]]) }));
    expect(p.rows.map((x) => x.verdict)).toEqual(["already", "already"]);
    expect(p.counts).toMatchObject({ already: 2, alreadyNotBanked: 1, import: 0 });
  });

  it("the owner's account choice wins over the suggestion; another company's id is ignored", () => {
    expect(buildReceiptsPlan([facts("p1")], ctx({ accountMap: { za4523: "bcash" } })).rows[0].bankAccountId).toBe("bcash");
    expect(buildReceiptsPlan([facts("p1")], ctx({ accountMap: { za4523: "not-ours" } })).rows[0].bankAccountId).toBe("b4523");
  });

  it("suggests by last 4 digits, exact name, or the company's cash account (Record payment's rules)", () => {
    const list = [acct("b1", "Current", "4523"), acct("b2", "Savings", "9876"), acct("c", "Cash in hand", null, "cash"),
      acct("pc", "Petty Cash", null, "cash", { is_default_petty_cash: true }), acct("cc", "Card", "4523", "credit_card")];
    expect(suggestAccount("HDFC Bank - 50200012344523", list)).toBe("b1");   // the credit card ending 4523 is never a deposit account
    expect(suggestAccount("Petty Cash", list)).toBe("pc");                    // several cash accounts → the company's Petty Cash
    expect(suggestAccount("Undeposited Funds", list)).toBeNull();
  });

  it("Pardeep's case: Kachha Khata + Petty Cash left out by the owner → 0 receipts booked for them, listed as skipped", () => {
    const bankAccounts = [acct("b4523", "Current", "4523"), acct("pc", "Petty Cash", null, "cash", { is_default_petty_cash: true })];
    const kk = { depositAccountId: "zkk", depositAccountName: "Kachha Khata Cash" };
    const pc = { depositAccountId: "zpc", depositAccountName: "Petty Cash" };
    const all = [facts("p1"), facts("p2", { ...kk, lines: [{ zohoInvoiceId: "zi2", invoiceNumber: "INV/25-26/0002", settle: 500, tds: 0 }] }), facts("p3", { ...pc, lines: [{ zohoInvoiceId: "zi1", invoiceNumber: "INV/25-26/0001", settle: 500, tds: 0 }] })];
    /* Without a choice both are suggested (shown in the dialog) … */
    const shown = buildReceiptsPlan(all, ctx({ bankAccounts }));
    expect(shown.deposits.find((d) => d.zohoAccountId === "zpc")).toMatchObject({ appAccountId: "pc", suggested: true, leftOut: false });
    /* … the owner leaves them out. */
    const p = buildReceiptsPlan(all, ctx({ bankAccounts, accountMap: { zkk: LEAVE_OUT, zpc: LEAVE_OUT } }));
    expect(p.rows.map((r) => r.verdict)).toEqual(["import", "skip", "skip"]);
    expect(p.rows.filter((r) => r.facts.depositAccountId !== "za4523").every((r) => r.reason === "Left out by owner." && r.bankAccountId === null)).toBe(true);
    expect(p.rows.filter((r) => r.verdict !== "skip").map(toReceiptPick)).toEqual([{ zoho_payment_id: "p1", bank_account_id: "b4523" }]);
    expect(p.deposits.filter((d) => d.leftOut).map((d) => [d.zohoAccountId, d.appAccountId, d.suggested]).sort()).toEqual([["zkk", null, false], ["zpc", null, false]]);
    expect(p.skipReasons).toContainEqual({ reason: "Left out by owner.", count: 2 });
    expect(p.totals.cash).toBe(1000);
  });

  it("a suggested account can be left out too; an explicit blank is never filled with a suggestion", () => {
    expect(buildReceiptsPlan([facts("p1")], ctx({ accountMap: { za4523: LEAVE_OUT } })).rows[0]).toMatchObject({ verdict: "skip", reason: "Left out by owner." });
    const blank = buildReceiptsPlan([facts("p1")], ctx({ accountMap: { za4523: "" } }));
    expect(blank.rows[0]).toMatchObject({ verdict: "skip", bankAccountId: null });
    expect(blank.deposits[0]).toMatchObject({ appAccountId: null, suggested: false });
  });

  it("import (suggest off): only what the dialog sent is used — no account is mapped behind the screen", () => {
    const p = buildReceiptsPlan([facts("p1")], ctx(), { suggest: false });
    expect(p.rows[0]).toMatchObject({ verdict: "skip", bankAccountId: null });
    expect(buildReceiptsPlan([facts("p1")], ctx({ accountMap: { za4523: "b4523" } }), { suggest: false }).rows[0]).toMatchObject({ verdict: "import", bankAccountId: "b4523" });
  });

  it("parseAccountMap keeps the Leave out choice and an explicit blank, drops anything else", () => {
    expect(parseAccountMap({ a: LEAVE_OUT, b: "", c: "x' or 1=1", d: "22222222-2222-4222-8222-222222222222" }))
      .toEqual({ a: LEAVE_OUT, b: "", d: "22222222-2222-4222-8222-222222222222" });
  });

  it("a credit card is never a deposit account, even when the owner picks it", () => {
    const p = buildReceiptsPlan([facts("p1")], ctx({ bankAccounts: [acct("cc", "Card", "4523", "credit_card")], accountMap: { za4523: "cc" } }));
    expect(p.rows[0]).toMatchObject({ verdict: "skip", bankAccountId: null });
  });
});

describe("R-2501 scan — customer payments through the FY import framework (READ only)", () => {
  it("lists /customerpayments for the FY, reads each detail (key 'payment'), stores rupees", async () => {
    const { scanStep } = await import("../fy-import/scan");
    const rows = new Map<string, ZohoReceiptFacts | null>();
    let run: { nextPage: number; listDone: boolean } | null = null;
    const store = {
      readRun: async () => run, saveRun: async (_fy: string, r: { nextPage: number; listDone: boolean }) => { run = { ...r }; },
      addListed: async (_fy: string, l: Array<{ zohoId: string }>) => { for (const x of l) if (!rows.has(x.zohoId)) rows.set(x.zohoId, null); },
      pendingDetails: async () => [...rows.entries()].filter(([, v]) => !v).map(([k]) => k),
      saveDetail: async (_fy: string, id: string, f: ZohoReceiptFacts) => { rows.set(id, f); },
      drop: async (_fy: string, id: string) => { rows.delete(id); },
      counts: async () => ({ listed: rows.size, detailed: [...rows.values()].filter(Boolean).length }),
      reset: async () => {},
    };
    const urls: URL[] = [];
    const j = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
    const f = (async (input: string, init?: RequestInit) => {
      expect((init?.method ?? "GET").toUpperCase()).toBe("GET");
      const u = new URL(input); urls.push(u);
      if (u.pathname === "/books/v3/customerpayments") {
        return j({ code: 0, customerpayments: [{ payment_id: "p1", payment_number: "101", date: "2025-06-10", amount: 1180.5, customer_id: "zc", customer_name: "B" }], page_context: { has_more_page: false } });
      }
      return j({ code: 0, payment: { ...base, payment_id: "p1", amount: 1180.5, unused_amount: 0, customer_id: "zc", customer_name: "B",
        invoices: [{ invoice_id: "zi1", invoice_number: "INV/25-26/0001", amount_applied: 1180.5 }] } });
    }) as unknown as typeof fetch;
    const r = await scanStep(store, "customerpayments", zohoReceiptFacts, "600", "tok", "2025-26", { sleep: async () => {}, now: () => 0, maxCalls: 10 }, f);
    expect(r).toMatchObject({ listed: 1, detailed: 1, complete: true });
    expect(rows.get("p1")).toMatchObject({ amount: 1181, receivedPaise: 118050, lines: [{ zohoInvoiceId: "zi1", settle: 1181, tds: 0 }] });
    const list = urls.find((u) => u.pathname === "/books/v3/customerpayments")!;
    expect(list.searchParams.get("date_start")).toBe("2025-04-01");
    expect(list.searchParams.get("date_end")).toBe("2026-03-31");
    expect(urls.some((u) => u.pathname === "/books/v3/customerpayments/p1")).toBe(true);
  });
});
