/**
 * R-2685 — a big "Reconcile from Zoho" run for performance checks: N bank lines with a Zoho payment
 * each, 1,500 customers and subscriptions (like staging Excel). Every 10th line repeats an earlier
 * customer + domain + product, so the run-wide "newest new subscription wins" pass has work to do.
 * Deterministic (seeded); in memory only — Zoho and the database are never called.
 */
import type { BulkMatchRow, PlanContext, PlanSubRow } from "@/lib/integrations/zoho-books/bulk-reconcile-plan";
import type { ZohoMatchLine, ZohoPaymentMatch } from "@/lib/integrations/zoho-books/payment-match";
import { seeded } from "./big-bank-account";

const W = ["Zynk", "Acme", "Learnet", "Inter", "Sharp", "Green", "Venus", "Chemico", "Karma", "Nova", "Delta", "Orbit"];

export function zohoBulkRun(n = 500, seed = 7): { rows: BulkMatchRow[]; ctx: PlanContext } {
  const r = seeded(seed);
  const customers: PlanContext["customers"] = Array.from({ length: 1500 }, (_, i) => ({
    id: `c-${i}`, name: `${W[i % 12]} ${W[(i * 7) % 12]} ${i} Pvt Ltd`, gstin: null, state_code: "07", country: "India", domain: `d${i}.in`,
  }));
  const subscriptions: PlanSubRow[] = Array.from({ length: 1500 }, (_, i) => ({
    id: `s-${i}`, customer_id: `c-${i}`, plan: "Workspace Starter", domain: `d${i}.in`, seats: 5, status: "active",
    start_date: "2026-04-01", renewal_date: "2027-04-01", billing_cycle: "yearly", quote_id: `Q-${i}`,
  }));
  const ctx: PlanContext = { customers, subscriptions, catalog: [], payers: [], ownNames: ["Our Own Company"], today: "2026-11-12" };
  const picked: number[] = [];
  const rows: BulkMatchRow[] = Array.from({ length: n }, (_, i) => {
    const ci = i % 10 === 9 && picked.length ? picked[Math.floor(r() * picked.length)] : Math.floor(r() * 1500);
    picked.push(ci);
    const c = customers[ci];
    const repeat = i % 10 === 9;
    const lines: ZohoMatchLine[] = [{
      invoiceNumber: `INV/26-27/${i}`, name: repeat ? "Cloud Backup" : "Workspace Starter", sku: null, qty: 1 + (i % 5), rate: 1000, itemTotal: null,
      start: `2026-${String(4 + (i % 7)).padStart(2, "0")}-01`, end: "2027-03-31", months: 12, domain: `new${ci}.in`,
    }];
    const amt = Math.round((1 + (i % 5)) * 1000 * 1.18);
    const m: ZohoPaymentMatch = {
      by: "utr",
      payment: { zohoId: `p${i}`, number: String(9000 + i), date: null, amount: amt, reference: "", customerZohoId: `z${c.id}`, customerName: c.name, taxWithheld: 0 },
      customer: { zohoId: `z${c.id}`, name: c.name, gstin: null },
      invoices: [{ zohoId: `zi${i}`, number: `INV/26-27/${i}`, date: "2026-10-01", amountApplied: amt, total: amt, lines }],
      moreInvoices: [],
    };
    return {
      line: { id: `t${String(i).padStart(4, "0")}`, txnDate: `2026-10-${String(1 + (i % 28)).padStart(2, "0")}`, credit: amt, description: `NEFT CR-HDFC0000001-${c.name.toUpperCase()}-UTR${i}`, reference: null },
      result: { kind: "match", match: m }, contact: null,
      facts: { customerId: c.id, openItems: [], openings: [], receipts: [], billed: [] }, booksStart: null,
    };
  });
  return { rows, ctx };
}
