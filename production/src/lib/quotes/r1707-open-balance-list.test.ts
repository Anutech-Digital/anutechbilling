/**
 * R-1707 — the quotes list shows money due that is not due.
 *
 * The owner's real record (billing audit, 20 Oct 2026): #0020 (T-L5) — invoiced ₹38,232, refunded
 * and credit-noted, invoice net ₹0, quotes.payment_amount 0 — showed "₹38,232 due" and sat in
 * Awaiting payment. The database half (quote_open_balances = quote_open_balance per quote, one
 * call) is proven by supabase/tests/r1707_quote_open_balances.test.sql.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { quoteListTab, quoteTabCounts, quoteBalanceDue } from "./list-tab";
import { cashNote } from "./status-badge";
import { withOpenBalances, toOpenBalanceMap } from "./open-balances";
import { quoteInFocus } from "./focus";

const SRC = join(__dirname, "../..");
const read = (p: string) => readFileSync(join(SRC, p), "utf8");

/* #0020 exactly as the list read it: invoiced, nothing in payment_amount. */
const q0020 = {
  id: "Q-F588-27-0020", status: "accepted" as const, payment_status: "invoiced" as const, invoice_id: "INV-F588-27-0004" as string | null,
  amount: 38_232, payment_amount: 0, superseded_by: null,
};
/* An invoiced quote part-paid ₹20,000 of ₹38,232. */
const partInvoiced = { ...q0020, id: "Q-IP", invoice_id: "INV-IP", payment_amount: 20_000 };
/* Part-paid before any invoice: ₹5,000 of ₹11,800. */
const partial = { id: "Q-PP", status: "accepted" as const, payment_status: "partial" as const, invoice_id: null as string | null, amount: 11_800, payment_amount: 5_000, superseded_by: null };

const balances = toOpenBalanceMap([
  { quote_id: "Q-F588-27-0020", open_balance: 0 },
  { quote_id: "Q-IP", open_balance: 18_232 },
  { quote_id: "Q-PP", open_balance: 6_800 },
]);
const [cn, ip, pp] = withOpenBalances([q0020, partInvoiced, partial], balances)!;

describe("R-1707: a credit-noted / refunded quote is not 'due'", () => {
  it("#0020 sits in Invoiced, not Awaiting payment", () => {
    expect(quoteListTab(cn)).toBe("invoiced");
  });
  it("#0020 shows no '₹38,232 due' chip", () => {
    expect(cashNote(cn)).toBeNull();
  });
  it("tab counts move it too (the tabs still add up to All)", () => {
    const c = quoteTabCounts([cn, ip, pp]);
    expect(c.invoiced).toBe(1);
    expect(c.awaiting).toBe(2);
    expect(c.all).toBe(3);
  });
  it("the review tile, which reads the tab, does not count it either", () => {
    expect(quoteInFocus(cn, "review")).toBe(false);
  });
});

describe("R-1707: a part-paid quote still shows the right ₹", () => {
  it("invoiced, part-paid → Awaiting payment, ₹20,000 paid · ₹18,232 left (R-1710: both halves)", () => {
    expect(quoteListTab(ip)).toBe("awaiting");
    expect(cashNote(ip)).toEqual({ text: "₹20,000 paid · ₹18,232 left", tone: "owed" });
  });
  it("part-paid before invoice → ₹5,000 paid · ₹6,800 left", () => {
    expect(quoteListTab(pp)).toBe("awaiting");
    expect(cashNote(pp)).toEqual({ text: "₹5,000 paid · ₹6,800 left", tone: "owed" });
  });
});

describe("R-1707: balances not loaded → the old arithmetic, never a silent 0", () => {
  it("open_balance null falls back to amount − payment_amount", () => {
    const [notLoaded] = withOpenBalances([q0020], undefined)!;
    expect(notLoaded.open_balance).toBeNull();
    expect(quoteBalanceDue(notLoaded)).toBe(38_232);
    expect(quoteListTab(notLoaded)).toBe("awaiting");
  });
  it("a quote the RPC did not return is unknown, not 0", () => {
    const [missing] = withOpenBalances([{ ...q0020, id: "Q-OTHER" }], balances)!;
    expect(missing.open_balance).toBeNull();
  });
});

describe("R-1707: the list reads the balances in ONE call", () => {
  it("the quotes page merges quote_open_balances into the rows every rule reads", () => {
    const page = read("app/(app)/quotes/page.tsx");
    expect(page).toMatch(/const \{ data: openBalances \} = useQuoteOpenBalances\(\);/);
    expect(page).toMatch(/const quotes = React\.useMemo\(\(\) => withOpenBalances\(rawQuotes, openBalances\)/);
  });
  it("the hook calls the set-returning RPC, never quote_open_balance per row", () => {
    const src = read("lib/quotes/open-balances.ts");
    expect(src).toContain('"quote_open_balances"');
    expect(src).not.toMatch(/"quote_open_balance"/);
  });
});
