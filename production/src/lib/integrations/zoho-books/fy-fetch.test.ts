/**
 * R-2498 — FY 2025-26 reads from Zoho Books (READ only): credit notes, bills, expenses, vendor
 * payments, invoices by date range; chart of accounts; trial balance as at a date. Paced under
 * Zoho's ~100 calls/minute and resumable from a cursor.
 *
 * Zoho is never called: a fake fetch answers in Zoho Books v3 shapes (list keys, page_context,
 * code 57 = "not authorized" for a scope the stored token does not have, HTTP 429 = busy).
 * All names and numbers are made up.
 */
import { describe, it, expect } from "vitest";
import { ZOHO_BOOKS_SCOPES, buildZohoAuthUrl } from "./config";
import {
  FY_DOC_KINDS, countFyDocs, fyDateRange, getFyDocDetail, listFyDocsPage, readChartOfAccounts,
  runPaced, trialBalanceAsAt, ZOHO_FY_RECONNECT_MESSAGE, type FyCountCursor,
  FyCursorError, fyReconnectMessage, TB_PRIOR_YEARS_ROW,
} from "./fy-fetch";
import { ZohoApiError } from "./api";

const ORG = "60001";
const TOKEN = "testonly-access";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

interface FakeOpts {
  /** Lists answered with 401 code 57 (scope missing on the token). */
  noScope?: string[];
  /** Answer 429 once, on this call number (1-based). */
  busyOnCall?: number;
  rowsPerList?: Record<string, number>;
}

function fakeZoho(opts: FakeOpts = {}) {
  const urls: URL[] = [];
  const f = (async (input: string) => {
    const u = new URL(input);
    urls.push(u);
    if (opts.busyOnCall && urls.length === opts.busyOnCall) return json({ code: 44, message: "too many requests" }, 429);
    const path = u.pathname.replace("/books/v3/", "");
    const list = path.split("/")[0];
    if (opts.noScope?.includes(list)) return json({ code: 57, message: "You are not authorized to perform this operation" }, 401);
    const page = Number(u.searchParams.get("page") ?? 1);
    const per = Number(u.searchParams.get("per_page") ?? 200);
    if (path === "chartofaccounts") {
      return json({ code: 0, chartofaccounts: [
        { account_id: "a-bank", account_name: "Current Account", account_code: "1001", account_type: "bank", is_active: true },
        { account_id: "a-sales", account_name: "Sales", account_code: "4001", account_type: "income", is_active: true },
        { account_id: "a-cap", account_name: "Owner Capital", account_code: "3001", account_type: "equity", is_active: true },
      ], page_context: { has_more_page: false } });
    }
    if (path === "chartofaccounts/accounttransactions") {
      const acc = u.searchParams.get("account_id");
      const tx: Record<string, Array<Record<string, unknown>>> = {
        "a-bank": [
          { transaction_date: "2025-03-01", debit_or_credit: "debit", debit_amount: 100000.5, credit_amount: 0 },
          { transaction_date: "2025-03-20", debit_or_credit: "credit", debit_amount: 0, credit_amount: 20000.25 },
        ],
        "a-sales": [{ transaction_date: "2025-03-01", debit_or_credit: "credit", debit_amount: 0, credit_amount: 30000.25 }],
        "a-cap": [{ transaction_date: "2025-03-01", debit_or_credit: "credit", debit_amount: 0, credit_amount: 50000 }],
      };
      /* Two pages for the bank account to prove paging within one account. */
      if (acc === "a-bank") {
        return json({ code: 0, transactions: [tx["a-bank"][page - 1]], page_context: { has_more_page: page === 1 } });
      }
      return json({ code: 0, transactions: tx[String(acc)] ?? [], page_context: { has_more_page: false } });
    }
    const total = opts.rowsPerList?.[list] ?? 3;
    const start = (page - 1) * per;
    const n = Math.max(0, Math.min(per, total - start));
    const idKey = list === "vendorpayments" ? "payment_id" : `${list.replace(/s$/, "")}_id`;
    const rows = Array.from({ length: n }, (_, i) => ({ [idKey]: `${list}-${start + i}`, date: "2025-06-01", total: 1180, status: "open" }));
    if (path.includes("/")) {
      const single = { creditnotes: "creditnote", bills: "bill", expenses: "expense", vendorpayments: "vendorpayment", invoices: "invoice" }[list]!;
      return json({ code: 0, [single]: DETAILS[list] });
    }
    return json({ code: 0, [list]: rows, page_context: { page, per_page: per, has_more_page: start + n < total } });
  }) as unknown as typeof fetch;
  return { f, urls };
}

const DETAILS: Record<string, Record<string, unknown>> = {
  bills: {
    bill_id: "b1", bill_number: "VB-77", date: "2025-07-10", vendor_id: "v1", vendor_name: "Cloud Vendor", status: "paid",
    total: 1180, balance: 0, currency_code: "INR", gst_treatment: "business_gst", gst_no: "07AAAAA0000A1Z5",
    place_of_supply: "DL", is_reverse_charge_applied: false, tax_total: 180, tds_amount: 20,
    taxes: [{ tax_name: "CGST9 (9%)", tax_amount: 90 }, { tax_name: "SGST9 (9%)", tax_amount: 90 }],
    line_items: [{ line_item_id: "l1", account_id: "a-exp", account_name: "IT and Internet Expenses", description: "Server", hsn_or_sac: "998315", quantity: 1, rate: 1000, item_total: 1000, tax_id: "t18", tax_name: "GST18", tax_percentage: 18 }],
  },
  expenses: {
    expense_id: "e1", reference_number: "EXP-9", date: "2025-08-01", vendor_id: "v2", vendor_name: "Fuel Station",
    account_id: "a-fuel", account_name: "Fuel", total: 590, sub_total: 500, tax_id: "t18", tax_name: "GST18", tax_percentage: 18, tax_amount: 90,
    status: "unbilled", currency_code: "INR",
  },
  creditnotes: {
    creditnote_id: "cn1", creditnote_number: "CN-00012", date: "2025-09-15", customer_id: "c1", customer_name: "Acme Traders",
    total: 236, balance: 0, status: "closed", taxes: [{ tax_name: "IGST18 (18%)", tax_amount: 36 }],
    line_items: [{ account_id: "a-sales", account_name: "Sales", item_total: 200, tax_name: "IGST18", tax_percentage: 18 }],
  },
  vendorpayments: {
    payment_id: "vp1", payment_number: "PM-3", date: "2025-07-20", vendor_id: "v1", vendor_name: "Cloud Vendor", amount: 1160, balance: 0,
    paid_through_account_name: "Current Account", bills: [{ bill_id: "b1", amount_applied: 1160 }],
  },
};

describe("R-2498 scopes — READ only, the new FY lists added", () => {
  it("asks for credit notes, bills, expenses, vendor payments and accountant (chart of accounts) read", () => {
    for (const s of ["ZohoBooks.creditnotes.READ", "ZohoBooks.bills.READ", "ZohoBooks.expenses.READ", "ZohoBooks.vendorpayments.READ", "ZohoBooks.accountants.READ"]) {
      expect(ZOHO_BOOKS_SCOPES).toContain(s);
    }
    /* The old ones stay. */
    for (const s of ["ZohoBooks.contacts.READ", "ZohoBooks.invoices.READ", "ZohoBooks.customerpayments.READ", "ZohoBooks.settings.READ"]) {
      expect(ZOHO_BOOKS_SCOPES).toContain(s);
    }
    for (const s of ZOHO_BOOKS_SCOPES) expect(s).toMatch(/^ZohoBooks\.[a-z]+\.READ$/);
    const url = new URL(buildZohoAuthUrl("cid", "http://localhost:3001/cb", "st"));
    expect(url.searchParams.get("scope")).not.toMatch(/CREATE|UPDATE|DELETE|ALL/);
  });
});

describe("fyDateRange", () => {
  it("FY 2025-26 is 1 Apr 2025 to 31 Mar 2026", () => {
    expect(fyDateRange("2025-26")).toEqual({ dateStart: "2025-04-01", dateEnd: "2026-03-31" });
  });
  it("refuses anything that is not YYYY-YY with consecutive years", () => {
    expect(() => fyDateRange("2025-27")).toThrow();
    expect(() => fyDateRange("25-26")).toThrow();
    expect(() => fyDateRange("2025-26&x=1")).toThrow();
  });
});

describe("listFyDocsPage — one page, filtered by date", () => {
  it("sends organization, page, per_page 200 and date_start / date_end; reads the right list key", async () => {
    const { f, urls } = fakeZoho({ rowsPerList: { bills: 3 } });
    const page = await listFyDocsPage("bills", ORG, TOKEN, fyDateRange("2025-26"), 1, f);
    expect(page.rows.map((r) => r.id)).toEqual(["bills-0", "bills-1", "bills-2"]);
    expect(page.rows[0]).toMatchObject({ kind: "bills", date: "2025-06-01", totalPaise: 118000 });
    expect(page.more).toBe(false);
    const q = urls[0].searchParams;
    expect(urls[0].pathname).toBe("/books/v3/bills");
    expect(q.get("organization_id")).toBe(ORG);
    expect(q.get("date_start")).toBe("2025-04-01");
    expect(q.get("date_end")).toBe("2026-03-31");
    expect(q.get("per_page")).toBe("200");
  });

  it("covers the five FY lists", () => {
    expect([...FY_DOC_KINDS]).toEqual(["invoices", "creditnotes", "bills", "expenses", "vendorpayments"]);
  });
});

describe("getFyDocDetail — typed lines, taxes and TDS (paise)", () => {
  it("bill: line items with account + HSN/SAC + tax, tax split, TDS, GSTIN", async () => {
    const { f, urls } = fakeZoho();
    const d = await getFyDocDetail("bills", ORG, TOKEN, "b1", f);
    expect(urls[0].pathname).toBe("/books/v3/bills/b1");
    expect(d).toMatchObject({
      id: "b1", number: "VB-77", contactId: "v1", contactName: "Cloud Vendor", totalPaise: 118000, balancePaise: 0,
      taxTotalPaise: 18000, tdsPaise: 2000, gstNo: "07AAAAA0000A1Z5", placeOfSupply: "DL", reverseCharge: false,
    });
    expect(d.taxes).toEqual([{ name: "CGST9 (9%)", amountPaise: 9000 }, { name: "SGST9 (9%)", amountPaise: 9000 }]);
    expect(d.lines).toEqual([{
      accountId: "a-exp", accountName: "IT and Internet Expenses", description: "Server", hsnOrSac: "998315",
      quantity: 1, amountPaise: 100000, taxId: "t18", taxName: "GST18", taxPercent: 18,
    }]);
  });

  it("expense without line items: one line from its own account, amount and tax", async () => {
    const { f } = fakeZoho();
    const d = await getFyDocDetail("expenses", ORG, TOKEN, "e1", f);
    expect(d).toMatchObject({ id: "e1", number: "EXP-9", totalPaise: 59000, taxTotalPaise: 9000 });
    expect(d.lines).toEqual([{
      accountId: "a-fuel", accountName: "Fuel", description: "", hsnOrSac: "", quantity: 1, amountPaise: 50000,
      taxId: "t18", taxName: "GST18", taxPercent: 18,
    }]);
  });

  it("vendor payment: amount is the total; customer side for credit notes", async () => {
    const { f } = fakeZoho();
    expect(await getFyDocDetail("vendorpayments", ORG, TOKEN, "vp1", f)).toMatchObject({ id: "vp1", number: "PM-3", totalPaise: 116000, contactName: "Cloud Vendor" });
    expect(await getFyDocDetail("creditnotes", ORG, TOKEN, "cn1", f)).toMatchObject({ id: "cn1", number: "CN-00012", contactId: "c1", taxTotalPaise: 3600 });
  });

  it("an id is URL-encoded (never a path trick)", async () => {
    const { f, urls } = fakeZoho();
    await getFyDocDetail("bills", ORG, TOKEN, "../settings", f);
    expect(urls[0].pathname).toBe("/books/v3/bills/..%2Fsettings");
  });
});

describe("runPaced — Zoho's limit, never more than the budget in 60 s", () => {
  it("waits before the call that would cross the budget", async () => {
    let now = 0;
    const waits: number[] = [];
    const history: Array<{ at: number; calls: number }> = [];
    let n = 0;
    const res = await runPaced({
      budget: 3, history, now: () => now,
      sleep: async (ms) => { waits.push(ms); now += ms; },
      maxCalls: 10,
      step: async () => { n += 1; now += 100; return n >= 5; },
    });
    expect(res).toEqual({ calls: 5, stopped: "done" });
    expect(waits.length).toBeGreaterThan(0);
    /* No 60 s window ever holds more than 3 calls. */
    for (const h of history) expect(history.filter((x) => x.at >= h.at && x.at < h.at + 60_000).length).toBeLessThanOrEqual(3);
  });

  it("stops at maxCalls (resumable) and on Zoho busy (429)", async () => {
    const r1 = await runPaced({ maxCalls: 2, step: async () => false });
    expect(r1).toEqual({ calls: 2, stopped: "limit" });
    const r2 = await runPaced({ maxCalls: 9, step: async () => { throw new ZohoApiError("busy", "books_44", 429); } });
    expect(r2).toEqual({ calls: 1, stopped: "busy" });
  });
});

describe("countFyDocs — FY counts, resumable, scope gaps reported (not fatal)", () => {
  it("counts each list over many pages", async () => {
    const { f } = fakeZoho({ rowsPerList: { invoices: 450, creditnotes: 12, bills: 201, expenses: 0, vendorpayments: 7 } });
    const r = await countFyDocs(ORG, TOKEN, "2025-26", null, { maxCalls: 50 }, f);
    expect(r.cursor).toBeNull();
    expect(r.counts).toEqual({ invoices: 450, creditnotes: 12, bills: 201, expenses: 0, vendorpayments: 7 });
    expect(r.needsReconnect).toEqual([]);
    expect(r.calls).toBe(3 + 1 + 2 + 1 + 1);
  });

  it("a list the token has no scope for → needsReconnect, the others still counted", async () => {
    const { f } = fakeZoho({ noScope: ["creditnotes", "bills", "expenses", "vendorpayments"], rowsPerList: { invoices: 5 } });
    const r = await countFyDocs(ORG, TOKEN, "2025-26", null, { maxCalls: 50 }, f);
    expect(r.counts.invoices).toBe(5);
    expect(r.needsReconnect).toEqual(["creditnotes", "bills", "expenses", "vendorpayments"]);
    expect(r.cursor).toBeNull();
    expect(ZOHO_FY_RECONNECT_MESSAGE).toMatch(/Reconnect to allow reading credit notes, bills, expenses/);
  });

  it("every list (invoices too) refused = the token itself ended, not a scope gap → thrown", async () => {
    const { f } = fakeZoho({ noScope: ["invoices", "creditnotes", "bills", "expenses", "vendorpayments"] });
    await expect(countFyDocs(ORG, TOKEN, "2025-26", null, { maxCalls: 50 }, f)).rejects.toMatchObject({ status: 401 });
    const resumed = { fy: "2025-26", list: "bills", page: 1, counts: { invoices: 5 }, needsReconnect: [] } as FyCountCursor;
    await expect(countFyDocs(ORG, TOKEN, "2025-26", resumed, { maxCalls: 50 }, f)).rejects.toMatchObject({ status: 401 });
  });

  it("stopped by the call limit or Zoho busy → a cursor; resuming gives the same totals as one run", async () => {
    const rows = { invoices: 450, creditnotes: 12, bills: 201, expenses: 3, vendorpayments: 7 };
    const one = await countFyDocs(ORG, TOKEN, "2025-26", null, { maxCalls: 50 }, fakeZoho({ rowsPerList: rows }).f);

    const { f } = fakeZoho({ rowsPerList: rows, busyOnCall: 4 });
    let r = await countFyDocs(ORG, TOKEN, "2025-26", null, { maxCalls: 2 }, f);
    expect(r.cursor).not.toBeNull();
    let guard = 0;
    while (r.cursor && guard++ < 20) r = await countFyDocs(ORG, TOKEN, "2025-26", r.cursor, { maxCalls: 2 }, f);
    expect(r.counts).toEqual(one.counts);
  });

  it("a cursor from the browser is checked: wrong FY, list or numbers are refused", async () => {
    const { f } = fakeZoho();
    const bad = [
      { fy: "2024-25", list: "bills", page: 1, counts: {}, needsReconnect: [] },
      { fy: "2025-26", list: "journals", page: 1, counts: {}, needsReconnect: [] },
      { fy: "2025-26", list: "bills", page: -3, counts: {}, needsReconnect: [] },
      { fy: "2025-26", list: "bills", page: 1, counts: { bills: -1 }, needsReconnect: [] },
    ] as unknown as FyCountCursor[];
    for (const c of bad) await expect(countFyDocs(ORG, TOKEN, "2025-26", c, { maxCalls: 5 }, f)).rejects.toThrow(/cursor/i);
  });
});

describe("chart of accounts + trial balance as at a date", () => {
  it("reads the accounts typed", async () => {
    const { f, urls } = fakeZoho();
    const accounts = await readChartOfAccounts(ORG, TOKEN, f);
    expect(urls[0].pathname).toBe("/books/v3/chartofaccounts");
    expect(urls[0].searchParams.get("filter_by")).toBe("AccountType.All");
    expect(accounts).toEqual([
      { id: "a-bank", name: "Current Account", code: "1001", type: "bank", active: true },
      { id: "a-sales", name: "Sales", code: "4001", type: "income", active: true },
      { id: "a-cap", name: "Owner Capital", code: "3001", type: "equity", active: true },
    ]);
  });

  it("sums each account's transactions up to the as-at date (date_end) in paise; Dr = Cr", async () => {
    const { f, urls } = fakeZoho();
    const r = await trialBalanceAsAt(ORG, TOKEN, "2025-03-31", null, { maxCalls: 50 }, f);
    expect(r.cursor).toBeNull();
    const tx = urls.filter((u) => u.pathname.endsWith("/accounttransactions"));
    expect(tx.every((u) => u.searchParams.get("date_end") === "2025-03-31")).toBe(true);
    expect(tx.every((u) => !u.searchParams.has("date_start"))).toBe(true);
    expect(r.rows).toEqual([
      { accountId: "a-bank", name: "Current Account", code: "1001", type: "bank", debitPaise: 8000025, creditPaise: 0 },
      { accountId: "a-sales", name: "Sales", code: "4001", type: "income", debitPaise: 0, creditPaise: 3000025 },
      { accountId: "a-cap", name: "Owner Capital", code: "3001", type: "equity", debitPaise: 0, creditPaise: 5000000 },
    ]);
    expect(r.totalDebitPaise).toBe(r.totalCreditPaise);
  });

  it("is resumable across a call limit with the same result", async () => {
    const whole = await trialBalanceAsAt(ORG, TOKEN, "2025-03-31", null, { maxCalls: 50 }, fakeZoho().f);
    const { f } = fakeZoho();
    let r = await trialBalanceAsAt(ORG, TOKEN, "2025-03-31", null, { maxCalls: 1 }, f);
    let guard = 0;
    while (r.cursor && guard++ < 20) r = await trialBalanceAsAt(ORG, TOKEN, "2025-03-31", r.cursor, { maxCalls: 1 }, f);
    expect(r.rows).toEqual(whole.rows);
  });

  it("refuses an as-at date that is not YYYY-MM-DD", async () => {
    await expect(trialBalanceAsAt(ORG, TOKEN, "31/03/2025", null, {}, fakeZoho().f)).rejects.toThrow();
  });
});

describe("R-2498 review fixes", () => {
  it("trial balance in a later year: income / expense before that year's 1 April go to the earlier-years row; Dr = Cr", async () => {
    const r = await trialBalanceAsAt(ORG, TOKEN, "2026-03-31", null, { maxCalls: 50 }, fakeZoho().f);
    expect(r.cursor).toBeNull();
    expect(r.rows).toEqual([
      { accountId: "a-bank", name: "Current Account", code: "1001", type: "bank", debitPaise: 8000025, creditPaise: 0 },
      { accountId: "a-sales", name: "Sales", code: "4001", type: "income", debitPaise: 0, creditPaise: 0 },
      { accountId: "a-cap", name: "Owner Capital", code: "3001", type: "equity", debitPaise: 0, creditPaise: 5000000 },
      { ...TB_PRIOR_YEARS_ROW, debitPaise: 0, creditPaise: 3000025 },
    ]);
    expect(r.totalDebitPaise).toBe(r.totalCreditPaise);
  });

  it("the invoices probe after a refused list is counted in `calls` and in the pace history", async () => {
    const { f, urls } = fakeZoho({ noScope: ["creditnotes", "bills", "expenses", "vendorpayments"], rowsPerList: { invoices: 5 } });
    const history: Array<{ at: number; calls: number }> = [];
    const r = await countFyDocs(ORG, TOKEN, "2025-26", null, { maxCalls: 50, history }, f);
    expect(r.calls).toBe(urls.length);
    expect(r.calls).toBe(1 + 4 * 2);
    expect(history.reduce((s, h) => s + h.calls, 0)).toBe(urls.length);
  });

  it("a bad cursor is a FyCursorError (the route answers 400 by type, not by wording)", async () => {
    const c = { fy: "2025-26", list: "journals", page: 1, counts: {}, needsReconnect: [] } as unknown as FyCountCursor;
    await expect(countFyDocs(ORG, TOKEN, "2025-26", c, { maxCalls: 5 }, fakeZoho().f)).rejects.toBeInstanceOf(FyCursorError);
  });

  it("the Reconnect line names only the refused lists", () => {
    expect(fyReconnectMessage(["expenses"])).toBe("Reconnect to allow reading expenses. Press Reconnect, then Allow on the Zoho screen.");
    expect(fyReconnectMessage(["vendorpayments", "bills"])).toMatch(/^Reconnect to allow reading bills and vendor payments\./);
    expect(fyReconnectMessage(["creditnotes", "bills", "expenses", "vendorpayments"])).toBe(ZOHO_FY_RECONNECT_MESSAGE);
  });
});
