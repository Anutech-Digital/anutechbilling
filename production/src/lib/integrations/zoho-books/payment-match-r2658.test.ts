/**
 * R-2658 — "Find in Zoho" on ONE inward-remittance line: Zoho is asked for the payments dated within
 * 10 days (3 for a ₹ line) and the line is paired by its foreign amount. Zoho is a fake fetch.
 */
import { describe, it, expect } from "vitest";
import { findZohoPayment, isFxMoney, lineRemittance, lineWindowDays, pickByAmount, type BankCreditLine } from "./payment-match";

type Pay = Record<string, unknown> & { date: string };
function fakeZoho(payments: Pay[], calls: string[] = [], more = false) {
  return (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    calls.push(url.search);
    const ref = url.searchParams.get("reference_number_contains");
    const from = url.searchParams.get("date_start");
    const to = url.searchParams.get("date_end");
    const first = (url.searchParams.get("page") ?? "1") === "1";
    const rows = ref || !first ? [] : payments.filter((p) => (from && to ? p.date >= from && p.date <= to : true));
    return new Response(JSON.stringify({ code: 0, customerpayments: rows, page_context: { has_more_page: more } }), { status: 200 });
  }) as typeof fetch;
}
const usd = (o: Partial<Pay> = {}): Pay => ({
  payment_id: "p-usd", payment_number: "9001", date: "2026-08-01", amount: 1024, reference_number: "", customer_id: "zc", customer_name: "Design Box",
  currency_code: "USD", exchange_rate: 93.1, ...o,
});
const INW: BankCreditLine = { txnDate: "2026-08-07", credit: 95846, description: "INW 070826I049902623 USD1024.0@93.6", reference: "0000070826114968" };
const deps = (f: typeof fetch) => ({ orgId: "org", token: "t", fetch: f });

describe("R-2658 Find in Zoho on a USD inward line", () => {
  it("the remittance of a line: only when amount × rate is the credit (±₹1)", () => {
    expect(lineRemittance(INW)).toEqual({ currency: "USD", amount: 1024, rate: 93.6 });
    expect(lineRemittance({ ...INW, credit: 95847 })).not.toBeNull();
    expect(lineRemittance({ ...INW, credit: 95000 })).toBeNull();
    expect(lineRemittance({ credit: 11800, description: "NEFT CR-HDFC0000240-KAPOOR LEGAL" })).toBeNull();
    expect(lineWindowDays(INW)).toBe(10);
    expect(lineWindowDays({ ...INW, credit: 95000 })).toBe(3);
    expect(lineWindowDays({ txnDate: "2026-08-07" })).toBe(3);
  });

  it("isFxMoney: same currency (Zoho must say it), within 1 unit", () => {
    const rem = lineRemittance(INW);
    expect(isFxMoney({ amount: 1024, currency: "USD" }, rem)).toBe(true);
    expect(isFxMoney({ amount: 1025, currency: "USD" }, rem)).toBe(true);
    expect(isFxMoney({ amount: 1023, currency: "USD" }, rem)).toBe(true);
    expect(isFxMoney({ amount: 1025.01, currency: "USD" }, rem)).toBe(false);
    expect(isFxMoney({ amount: 1024, currency: "EUR" }, rem)).toBe(false);
    expect(isFxMoney({ amount: 1024, currency: "INR" }, rem)).toBe(false);
    expect(isFxMoney({ amount: 1024 }, rem)).toBe(false);
    expect(isFxMoney({ amount: 1024, currency: "USD" }, null)).toBe(false);
  });

  it("asks Zoho for ±10 days and returns the one USD payment, by fx_amount", async () => {
    const calls: string[] = [];
    const found = await findZohoPayment(INW, deps(fakeZoho([usd(), usd({ payment_id: "p-other", amount: 300 })], calls)));
    expect(found).toMatchObject({ kind: "one", by: "fx_amount", payment: { zohoId: "p-usd", currency: "USD" } });
    const last = new URLSearchParams(calls[calls.length - 1]);
    expect(last.get("date_start")).toBe("2026-07-28");
    expect(last.get("date_end")).toBe("2026-08-17");
  });

  it("two USD payments of that amount → several (the person picks)", async () => {
    const found = await findZohoPayment(INW, deps(fakeZoho([usd(), usd({ payment_id: "p-2", date: "2026-08-10" })])));
    expect(found.kind).toBe("several");
    if (found.kind === "several") expect(found.by).toBe("fx_amount");
  });

  it("nothing of that amount → none, and it says the window it searched", async () => {
    const found = await findZohoPayment(INW, deps(fakeZoho([usd({ amount: 2000 })])));
    expect(found).toMatchObject({ kind: "none", from: "2026-07-28", to: "2026-08-17" });
  });

  it("a ₹ line still asks for ±3 days", async () => {
    const calls: string[] = [];
    const rupeeLine: BankCreditLine = { txnDate: "2026-08-07", credit: 11800, description: "CASH DEPOSIT", reference: null };
    const found = await findZohoPayment(rupeeLine, deps(fakeZoho([{ ...usd({ currency_code: "INR", amount: 11800, date: "2026-08-09" }) }], calls)));
    expect(found).toMatchObject({ kind: "one", by: "amount_date" });
    const last = new URLSearchParams(calls[calls.length - 1]);
    expect(last.get("date_start")).toBe("2026-08-04");
    expect(last.get("date_end")).toBe("2026-08-10");
  });

  it("pickByAmount: nearest date first among several", () => {
    const row = (zohoId: string, date: string) => ({ zohoId, number: "", date, amount: 1024, reference: "", customerZohoId: "", customerName: "", currency: "USD" });
    const got = pickByAmount(INW, [row("far", "2026-07-29"), row("near", "2026-08-06")]);
    expect(got.kind === "several" && got.candidates.map((c) => c.zohoId)).toEqual(["near", "far"]);
  });
  it("an inward line reads up to 5 pages of its window; Zoho still has more → found, but not sure", async () => {
    const calls: string[] = [];
    const found = await findZohoPayment(INW, deps(fakeZoho([usd()], calls, true)));
    expect(found).toMatchObject({ kind: "one", by: "fx_amount", payment: { zohoId: "p-usd" }, notSure: expect.stringContaining("more payments in this period") });
    expect(calls.filter((c) => c.includes("date_start")).map((c) => new URLSearchParams(c).get("page"))).toEqual(["1", "2", "3", "4", "5"]);
  });

  it("the payment on a later page of the window is still found (it is dated before the bank date)", async () => {
    const paged = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const page = url.searchParams.get("page") ?? "1";
      const rows = url.searchParams.get("reference_number_contains") ? [] : page === "2" ? [usd()] : page === "1" ? [usd({ payment_id: "p-other", amount: 77 })] : [];
      return new Response(JSON.stringify({ code: 0, customerpayments: rows, page_context: { has_more_page: page === "1" } }), { status: 200 });
    }) as typeof fetch;
    const found = await findZohoPayment(INW, deps(paged));
    expect(found).toMatchObject({ kind: "one", by: "fx_amount", payment: { zohoId: "p-usd" } });
    expect(found.kind === "one" && found.notSure).toBeUndefined();
  });

  it("another open bank line of the same USD amount near that payment → not sure (live lookup too)", async () => {
    const other: BankCreditLine = { txnDate: "2026-08-03", credit: 95334, description: "INW 030826I049902000 USD1024.0@93.1", reference: null };
    const found = await findZohoPayment(INW, deps(fakeZoho([usd()])), [INW, other]);
    expect(found).toMatchObject({ kind: "one", by: "fx_amount", notSure: expect.stringContaining("Another bank line") });
    const alone = await findZohoPayment(INW, deps(fakeZoho([usd()])), [INW]);
    expect(alone).toMatchObject({ kind: "one", by: "fx_amount" });
    expect(alone.kind === "one" && alone.notSure).toBeUndefined();
  });
});
