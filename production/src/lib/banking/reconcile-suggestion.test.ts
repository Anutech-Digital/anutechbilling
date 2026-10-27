/* R-2007 — the Suggestion card on the Reconcile sheet: ONE confident answer, else none.
   Owner's examples (Pardeep, 27 Oct, scenarios project-receipts + vendor-sharma):
     · "NEFT CR-…-SCN BHARAT APPS-KIST 1 2 LESS TDS" ₹2,12,400 → SCN Bharat Apps · SCN Mobile app ·
       Kist 1 + 2 · TDS ₹23,600 (2,36,000 − 10%);
     · "NEFT DR-…-GOOGLE CLOUD INDIA PVT LTD-…" ₹5,000 → Google's ONLY open bill SCN-G-20
       (₹11,800 due) as a part payment. */
import { describe, expect, it } from "vitest";

import {
  inferTds, suggestMoneyIn, suggestMoneyOut, instalmentWords,
  type SuggestProject,
} from "./reconcile-suggestion";
import type { OpenItem } from "./credit-pay-for";
import type { VendorOpenItem } from "./debit-pay-for";

const bharat = { id: "cu-bharat", name: "SCN Bharat Apps" };
const ms = (id: string, seq: number, remaining: number, label: string, invoiceId: string | null = null) =>
  ({ id, seq, label, remaining, invoiceId });
const mobileApp: SuggestProject = {
  id: "p-mobile", title: "SCN Mobile app", customerId: bharat.id, gstRate: 18,
  milestones: [ms("k1", 1, 118000, "Kist 1 — advance"), ms("k2", 2, 118000, "Kist 2 — delivery")],
};
const website: SuggestProject = {
  id: "p-web", title: "SCN Website", customerId: "cu-acme", gstRate: 18,
  milestones: [ms("a1", 1, 118000, "Kist 1 — design"), ms("a2", 2, 118000, "Kist 2 — build"), ms("a3", 3, 118000, "Kist 3 — go-live")],
};
const item = (o: Partial<OpenItem>): OpenItem => ({
  kind: "invoice", quote_id: "Q-1", invoice_id: "INV-1", doc_date: "2026-10-01", amount_due: 11800, taxable_value: 10000,
  makes_subscription: false, subscription_id: null, plan: null, seats: null, renewal_date: null, lines: null, ...o,
});

describe("inferTds — bank = due less a common TDS rate", () => {
  it("2,12,400 = 2,36,000 − 23,600 → 10% TDS of ₹23,600 (on the invoice value)", () => {
    expect(inferTds(212400, 236000, null)).toMatchObject({ amount: 23600, ratePct: 10, section: "194J", sectionKey: "194J-10" });
  });
  it("10% on the value before GST: 2,16,000 on 2,36,000 (taxable 2,00,000) → ₹20,000", () => {
    expect(inferTds(216000, 236000, 200000)).toMatchObject({ amount: 20000, ratePct: 10 });
  });
  it("2%: 11,600 on 11,800 (taxable 10,000) → ₹200", () => {
    expect(inferTds(11600, 11800, 10000)).toMatchObject({ amount: 200, ratePct: 2, sectionKey: "194J-2" });
  });
  it("any other gap is not TDS", () => {
    expect(inferTds(200000, 236000, null)).toBeNull();
    expect(inferTds(236000, 236000, null)).toBeNull();
    expect(inferTds(240000, 236000, null)).toBeNull();
  });
});

describe("instalmentWords", () => {
  it("uses the project's own word for its instalments", () => {
    expect(instalmentWords(mobileApp.milestones)).toBe("Kist 1 + 2");
    expect(instalmentWords([ms("x", 1, 1, "Advance"), ms("y", 2, 1, "Balance")])).toBe("Instalment 1 + 2");
  });
});

describe("suggestMoneyIn — the customer's project instalments or one open invoice", () => {
  it("Bharat ₹2,12,400: Mobile app · Kist 1 + 2 · TDS ₹23,600, both kists ticked in full", () => {
    const s = suggestMoneyIn({
      bank: 212400, customer: bharat, guessReason: "the bank line says “bharat apps”",
      projects: [website, mobileApp], items: [],
    });
    expect(s).toMatchObject({ kind: "project", tile: "customer", customerId: bharat.id, projectId: "p-mobile", settled: 236000 });
    expect(s?.kind === "project" && s.tds).toMatchObject({ amount: 23600, ratePct: 10, sectionKey: "194J-10" });
    expect(s?.kind === "project" && s.rows.filter((r) => r.on).map((r) => [r.id, r.amount])).toEqual([["k1", 118000], ["k2", 118000]]);
    expect(s?.title).toBe("SCN Bharat Apps · SCN Mobile app · Kist 1 + 2 · TDS ₹23,600");
    expect(s?.why).toContain("bharat apps");
    expect(s?.why).toContain("₹2,12,400 + TDS ₹23,600 (10%) = ₹2,36,000");
  });
  it("exact kists, no TDS: Acme ₹2,36,000 → Kist 1 + 2 of SCN Website", () => {
    const s = suggestMoneyIn({ bank: 236000, customer: { id: "cu-acme", name: "SCN Acme Website Co" }, guessReason: "x", projects: [website, mobileApp], items: [] });
    expect(s).toMatchObject({ kind: "project", projectId: "p-web", tds: null });
    expect(s?.title).toBe("SCN Acme Website Co · SCN Website · Kist 1 + 2");
  });
  it("more than everything due (₹4,00,000 on Acme) → no card", () => {
    expect(suggestMoneyIn({ bank: 400000, customer: { id: "cu-acme", name: "SCN Acme Website Co" }, guessReason: "x", projects: [website], items: [] })).toBeNull();
  });
  it("one open invoice that the money pays (after 2% TDS) → that invoice", () => {
    const s = suggestMoneyIn({ bank: 11600, customer: bharat, guessReason: "x", projects: [], items: [item({})] });
    expect(s).toMatchObject({ kind: "item", tile: "customer" });
    expect(s?.kind === "item" && s.item.invoice_id).toBe("INV-1");
    expect(s?.kind === "item" && s.tds).toMatchObject({ amount: 200, ratePct: 2 });
  });
  it("a project AND an invoice both fit → ambiguous → no card", () => {
    const s = suggestMoneyIn({ bank: 236000, customer: bharat, guessReason: "x", projects: [mobileApp], items: [item({ amount_due: 236000, taxable_value: 200000 })] });
    expect(s).toBeNull();
  });
  it("an instalment invoice of the same project is the project, not a second answer", () => {
    const p = { ...mobileApp, milestones: [ms("k1", 1, 118000, "Kist 1 — advance", "INV-K1")] };
    const s = suggestMoneyIn({ bank: 118000, customer: bharat, guessReason: "x", projects: [p], items: [item({ kind: "instalment", invoice_id: "INV-K1", amount_due: 118000 })] });
    expect(s).toMatchObject({ kind: "project", projectId: "p-mobile" });
  });
  it("a sale that would start a subscription needs dates → no card", () => {
    expect(suggestMoneyIn({ bank: 11800, customer: bharat, guessReason: "x", projects: [], items: [item({ makes_subscription: true })] })).toBeNull();
  });
  it("no customer guessed → no card", () => {
    expect(suggestMoneyIn({ bank: 212400, customer: null, guessReason: "", projects: [mobileApp], items: [] })).toBeNull();
  });
});

const vbill = (o: Partial<VendorOpenItem>): VendorOpenItem => ({
  source: "vendor_bill", doc_id: "BILL-SCN-G-20", bill_no: "SCN-G-20", doc_date: "2026-10-12", due_date: null, category: "COGS-Workspace",
  total: 11800, amount_due: 11800, gst: 1800, tds_base: 10000, tds_amount: 0, tds_section: null, can_part: true, in_run: null, ...o,
});
const google = { id: "v-google", name: "Google Cloud India Pvt Ltd", default_tds_section: null };

describe("suggestMoneyOut — the vendor's bill", () => {
  it("Google ₹5,000, ONE open bill SCN-G-20 ₹11,800 → that bill as a part payment of ₹5,000", () => {
    const s = suggestMoneyOut({ debit: 5000, vendor: google, guessReason: "the bank line says “google cloud”", items: [vbill({})] });
    expect(s).toMatchObject({ kind: "vendor", tile: "vendor", vendorId: "v-google", cash: 5000, tds: 0, part: true });
    expect(s?.title).toBe("Google Cloud India Pvt Ltd · Bill SCN-G-20 · part payment");
    expect(s?.why).toContain("only open bill");
    expect(s?.why).toContain("₹5,000 of ₹11,800 due");
  });
  it("the exact bill among several → that bill in full", () => {
    const s = suggestMoneyOut({
      debit: 11800, vendor: { id: "v-sharma", name: "Sharma Associates", default_tds_section: null },
      guessReason: "x",
      items: [vbill({ source: "expense", doc_id: "EXP-1", bill_no: "SCN-PS-1", amount_due: 59000, total: 59000 }), vbill({ source: "expense", doc_id: "EXP-2", bill_no: "SCN-PS-2" })],
    });
    expect(s).toMatchObject({ kind: "vendor", cash: 11800, part: false });
    expect(s?.kind === "vendor" && s.item.doc_id).toBe("EXP-2");
  });
  it("two open bills and no exact one → no card (the owner picks)", () => {
    expect(suggestMoneyOut({ debit: 5000, vendor: google, guessReason: "x", items: [vbill({}), vbill({ doc_id: "B2", bill_no: "G-21" })] })).toBeNull();
  });
  it("more than the only bill → no card (the extra is the owner's call)", () => {
    expect(suggestMoneyOut({ debit: 20000, vendor: google, guessReason: "x", items: [vbill({})] })).toBeNull();
  });
  it("TDS still to work out (vendor has a section, expense bill without TDS) → no card", () => {
    expect(suggestMoneyOut({
      debit: 5000, vendor: { ...google, default_tds_section: "194J" }, guessReason: "x",
      items: [vbill({ source: "expense" })],
    })).toBeNull();
  });
  it("a bill held in a payment run is not offered", () => {
    expect(suggestMoneyOut({ debit: 5000, vendor: google, guessReason: "x", items: [vbill({ in_run: "RUN-1" })] })).toBeNull();
  });
  it("no vendor guessed → no card", () => {
    expect(suggestMoneyOut({ debit: 5000, vendor: null, guessReason: "", items: [vbill({})] })).toBeNull();
  });
});
