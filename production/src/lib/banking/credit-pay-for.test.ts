import { describe, it, expect } from "vitest";
import {
  amountCheck, defaultRenewal, guessCustomer, itemDetail, kindLabel, preselectItem, relinkBlocker, relinkSteps, repriceLine,
  resultLines, saleLineFromItem, saleLinesPayload, salePreview, saleMakesSubscription, saleTermsMixed,
  tdsRateToRecord, tdsToRecord, type OldOneOffBooking, type OpenItem, type PayForResult,
} from "./credit-pay-for";

describe("R-1863 advance result", () => {
  it("says the card's sentence, links the customer, names the receipt voucher", () => {
    const ls = resultLines({
      kind: "advance", quote_id: "Q-9", invoice_id: null, invoice_issued: null, payment_id: "p", receipt_voucher_no: "RV-12",
      amount: 25000, advance_credit: 25000, customer_id: "c1", customer_name: "Acme Traders", tds_amount: 0, outstanding: 0,
      is_fully_paid: true, overpaid_credit: 0, renewal_rolled_forward: false, subscription_skipped: false, already_recorded: false, subscriptions: [],
    });
    expect(ls[0]).toEqual({ text: "₹25,000 kept as advance for Acme Traders — it will be offered when you record their next payment", href: "/customers/c1" });
    expect(ls.map((l) => l.text)).toEqual([ls[0].text, "Receipt voucher RV-12"]);
  });
});

const old = (o: Partial<OldOneOffBooking>): OldOneOffBooking => ({
  txn_id: "t", txn_date: "2026-10-12", amount: 11800, description: "NEFT BETA", payment_id: "p", receipt_voucher_no: "RV-3",
  received_on: "2026-10-12", quote_id: "Q-OLD", customer_id: "c2", customer_name: "Beta", product: "Google Workspace",
  invoice_id: "INV-4", invoice_status: "paid", invoice_date: "2026-10-12", invoice_amount: 11800, blocker: null, ...o,
});

describe("R-1863 relink — what will happen, and what blocks it", () => {
  it("an issued invoice gets a full credit note, the receipt + quote go, then the new booking", () => {
    const s = relinkSteps(old({}));
    expect(s[0]).toBe("Invoice INV-4 (₹11,800, 12 Oct 2026) gets a full credit note (GST section 34). It stays in your records with nothing due.");
    expect(s[1]).toContain("receipt RV-3 and one-off quote Q-OLD are removed");
    expect(s[2]).toContain("₹11,800 is then recorded on what you pick below");
  });
  it("a draft invoice is voided, not credit-noted; no invoice → no invoice step", () => {
    expect(relinkSteps(old({ invoice_status: "draft" }))[0]).toBe("Draft invoice INV-4 is voided.");
    expect(relinkSteps(old({ invoice_id: null, invoice_status: null }))).toHaveLength(2);
  });
  it("a locked month says to unlock it and links Close month (§24)", () => {
    expect(relinkBlocker(old({ blocker: "books_locked" }))).toMatchObject({ href: "/accounting/close", action: "Open Close month" });
    expect(relinkBlocker(old({ blocker: "invoice_notes" }))?.href).toBe("/invoices/INV-4");
    expect(relinkBlocker(old({}))).toBeNull();
  });
});

const item = (o: Partial<OpenItem>): OpenItem => ({
  kind: "new", quote_id: "Q-1", invoice_id: null, doc_date: "2026-10-10", amount_due: 11800,
  taxable_value: 10000, makes_subscription: true, subscription_id: null, plan: null, seats: null,
  renewal_date: null, lines: [], ...o,
});

const result = (o: Partial<PayForResult>): PayForResult => ({
  kind: "new", quote_id: "Q-1", invoice_id: null, invoice_issued: null, payment_id: "p1",
  receipt_voucher_no: null, amount: 11800, tds_amount: 0, outstanding: 0, is_fully_paid: true,
  overpaid_credit: 0, renewal_rolled_forward: false, subscription_skipped: false,
  already_recorded: false, subscriptions: [], ...o,
});

const GWS = {
  id: "GW-STD", name: "Google Workspace Business Standard", vendor: "google" as const,
  msrp: 1080, wholesale: 900, item_type: "subscription",
  prices: { annual: { msrp: 1080, wholesale: 900 }, monthly: { msrp: 1300, wholesale: 1080 } },
};
const SETUP = {
  id: "MIG", name: "Email migration", vendor: "other" as const, msrp: 199, wholesale: 0,
  item_type: "one_time", prices: {},
};

describe("R-1838 kinds — what the operator sees on each open item", () => {
  it("labels renewal and add-seats quotes the way Pardeep named them", () => {
    expect(kindLabel("renewal")).toBe("Renewal");
    expect(kindLabel("add_seats")).toBe("Add seats · pro-rata");
    expect(kindLabel("new")).toBe("New product");
    expect(kindLabel("instalment")).toBe("Instalment invoice");
  });
  it("a renewal row says which subscription and when it renews", () => {
    const d = itemDetail(item({ kind: "renewal", quote_id: "Q-REN", plan: "Google Workspace", seats: 15, renewal_date: "2026-11-01" }));
    expect(d).toContain("Google Workspace (15 seats)");
    expect(d).toContain("renews");
  });
  it("a new-product row says it starts a subscription", () => {
    expect(itemDetail(item({ lines: [{ name: "GWS Standard" }] }))).toContain("starts a subscription");
  });
});

describe("R-1838 customer guess", () => {
  const customers = [{ id: "c1", name: "Acme Traders" }, { id: "c2", name: "Bharat Steel" }, { id: "c3", name: "Bharat Foods" }];
  it("one customer named in the narration → that customer", () => {
    expect(guessCustomer({ description: "NEFT CR-ACME TRADERS-UTR123" }, customers)?.customerId).toBe("c1");
  });
  it("two customers share the word → no guess", () => {
    expect(guessCustomer({ description: "NEFT BHARAT 123" }, customers)).toBeNull();
  });
  it("falls back to a single certain open-invoice match", () => {
    expect(guessCustomer({ description: "IMPS 99812" }, customers, [{ customerName: "Bharat Steel", confidence: "certain" }])?.customerId).toBe("c2");
    expect(guessCustomer({ description: "IMPS 99812" }, customers, [{ customerName: "Bharat Steel", confidence: "likely" }])).toBeNull();
  });
});

describe("R-1838 pre-selection + amount check", () => {
  const ren = item({ kind: "renewal", quote_id: "Q-REN", amount_due: 35400, taxable_value: 30000 });
  const add = item({ kind: "add_seats", quote_id: "Q-ADD", amount_due: 4720, taxable_value: 4000 });
  const inv = item({ kind: "invoice", quote_id: "Q-INV", invoice_id: "INV-1", amount_due: 11800, taxable_value: 10000 });

  it("renewal: the exact amount picks the renewal quote", () => {
    expect(preselectItem([ren, add, inv], 35400)?.quote_id).toBe("Q-REN");
    expect(amountCheck(35400, ren.amount_due, ren.taxable_value)).toEqual({ kind: "exact" });
  });
  it("add-seats: the exact amount picks the pro-rata quote", () => {
    expect(preselectItem([ren, add, inv], 4720)?.quote_id).toBe("Q-ADD");
  });
  it("two items with the same due → nothing pre-selected", () => {
    expect(preselectItem([inv, item({ quote_id: "Q-2", amount_due: 11800 })], 11800)).toBeNull();
  });
  it("mismatch with TDS: 11,600 on 11,800 due = 2% TDS on 10,000 → pre-selected, TDS 200", () => {
    expect(preselectItem([ren, inv], 11600)?.invoice_id).toBe("INV-1");
    const c = amountCheck(11600, inv.amount_due, inv.taxable_value);
    expect(c).toEqual({ kind: "short", shortBy: 200, tdsRatePct: 2 });
    expect(tdsToRecord(c, "tds")).toBe(200);
    expect(tdsRateToRecord(c, 10000)).toBe(2);
    expect(tdsToRecord(c, "part")).toBe(0);
  });
  it("short with no TDS pattern → part payment, rate from the gap only if the operator says TDS", () => {
    const c = amountCheck(5000, 11800, 10000);
    expect(c).toEqual({ kind: "short", shortBy: 6800, tdsRatePct: null });
    expect(tdsRateToRecord(c, 10000)).toBe(68);
  });
  it("over → the extra is shown (it becomes customer credit)", () => {
    expect(amountCheck(7000, 5900, 5000)).toEqual({ kind: "over", overBy: 1100 });
  });
});

describe("R-1838 new sale — seats × unit price", () => {
  it("a per-seat product asks seats and a per-seat unit price from the catalogue", () => {
    const l = saleLineFromItem(GWS, "annual_yearly", 5);
    expect(l).toMatchObject({ itemId: "GW-STD", qty: 5, rate: 1080 * 12, perSeat: true, cycle: "annual_yearly" });
    const m = repriceLine(l, GWS, "monthly");
    expect(m.rate).toBe(1300);
    expect(m.qty).toBe(5);
  });
  it("seats × unit price + GST is the preview the amount check uses", () => {
    const lines = [{ ...saleLineFromItem(GWS, "annual_yearly", 5), rate: 3000 }];
    expect(salePreview(lines, 18)).toEqual({ taxable: 15000, gst: 2700, total: 17700 });
    expect(salePreview(lines, 0).total).toBe(15000);
    expect(amountCheck(17700, salePreview(lines, 18).total, 15000)).toEqual({ kind: "exact" });
  });
  it("sends whole-rupee qty/rate and the line's own term to the RPC", () => {
    const p = saleLinesPayload([{ ...saleLineFromItem(GWS, "annual_yearly", 5), rate: 3000.4 }, saleLineFromItem(SETUP)]);
    expect(p[0]).toMatchObject({ item_id: "GW-STD", qty: 5, rate: 3000, commitment: "annual_yearly" });
    expect(p[1]).toMatchObject({ item_id: "MIG", qty: 1, rate: 199, commitment: "one_time" });
  });
  it("a subscription product makes a subscription; a one-time one does not", () => {
    expect(saleMakesSubscription([saleLineFromItem(GWS)])).toBe(true);
    expect(saleMakesSubscription([saleLineFromItem(SETUP)])).toBe(false);
  });
  it("monthly + annual on one sale is flagged before the server refuses it", () => {
    expect(saleTermsMixed([saleLineFromItem(GWS, "monthly"), saleLineFromItem(GWS, "annual_yearly")])).toBe(true);
    expect(saleTermsMixed([saleLineFromItem(GWS, "monthly"), saleLineFromItem(SETUP)])).toBe(false);
  });
  it("default renewal = start + 1 year (annual) / + 1 month (monthly), month-end clamped", () => {
    expect(defaultRenewal("2026-10-24", false)).toBe("2027-10-24");
    expect(defaultRenewal("2026-01-31", true)).toBe("2026-02-28");
  });
});

describe("R-1838 result — what happened, in words", () => {
  it("renewal: subscription renewed to its new date + invoice", () => {
    const lines = resultLines(result({
      kind: "renewal", quote_id: "Q-REN", renewal_rolled_forward: true, invoice_issued: "INV-9",
      subscriptions: [{ id: "s1", plan: "Google Workspace", seats: 15, start_date: "2025-10-24", renewal_date: "2027-10-24", billing_cycle: "yearly" }],
    }));
    expect(lines[0].text).toBe("Renewal of Google Workspace (15 seats) paid → subscription renewed to 24 Oct 2027");
    expect(lines.some((l) => l.text === "Invoice INV-9 issued" && l.href === "/invoices/INV-9")).toBe(true);
  });
  it("add seats", () => {
    expect(resultLines(result({ kind: "add_seats", subscriptions: [{ id: "s1", plan: "GWS", seats: 17, start_date: null, renewal_date: null, billing_cycle: null }] }))[0].text)
      .toBe("Add-seats payment recorded → GWS (17 seats)");
  });
  it("fresh quote, subscription ticked → 'Subscription created: plan × seats, renews …'", () => {
    const lines = resultLines(result({
      subscriptions: [{ id: "s2", plan: "GWS Standard", seats: 5, start_date: "2026-10-18", renewal_date: "2027-10-31", billing_cycle: "yearly" }],
    }));
    expect(lines.map((l) => l.text)).toContain("Subscription created: GWS Standard × 5, renews 31 Oct 2027");
    expect(lines.some((l) => l.tone === "warn")).toBe(false);
  });
  it("fresh quote, subscription unticked → a visible 'No subscription created … create it from the quote'", () => {
    const lines = resultLines(result({ subscription_skipped: true, quote_id: "Q-NEW2" }));
    const warn = lines.find((l) => l.tone === "warn");
    expect(warn?.text).toMatch(/No subscription created for this paid quote/);
    expect(warn?.href).toBe("/quotes/Q-NEW2");
    expect(lines.some((l) => l.text.startsWith("Subscription created"))).toBe(false);
  });
  it("TDS, part payment and extra credit are each said once", () => {
    const t = resultLines(result({ tds_amount: 200, outstanding: 500, overpaid_credit: 1100 })).map((l) => l.text).join("\n");
    expect(t).toContain("TDS booked as TDS receivable");
    expect(t).toContain("still due");
    expect(t).toContain("extra kept as the customer's advance credit");
  });
});
