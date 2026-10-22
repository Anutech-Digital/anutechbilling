/**
 * R-1763 — the owner's three domains from the 22 Oct local import (Excel tenant, real Zoho):
 *   - jhfashions-like: old item name 3 seats (2025-26) + new item name 3 seats (2026-27)
 *     → ONE subscription, 3 seats, renewal 24 Oct 2027;
 *   - richcotton-like: 44 seats + a 1-seat top-up under the other item name, same term end
 *     → ONE subscription, 45 seats;
 *   - setaragroup-like: M365 Basic "Email Solutions" 49 + "User License (Resale)" 10, same term
 *     → ONE subscription, 59 seats, renewal 18 Nov 2026.
 * "with Teams" / "without Teams" and different editions stay separate.
 * Fixtures are made up (T- names, example domains) in the shape Zoho gave them.
 */
import { describe, expect, it } from "vitest";
import {
  buildImportPlan, summarisePlan, type PlanInput, type ZohoContactRec, type ZohoInvoiceRec, type ZohoLineRec,
} from "./import-plan";

const contact = (o: Partial<ZohoContactRec> & { zohoId: string; name: string }): ZohoContactRec => ({
  gstin: null, gstTreatment: null, placeOfContact: null, paymentTermsDays: null,
  email: null, phone: null, personName: null, subType: "business", ...o,
});
const line = (plan: string, quantity: number, itemTotal: number, description: string): ZohoLineRec => ({
  plan, quantity, itemTotal, rate: itemTotal / quantity, description,
});
const invoice = (o: Partial<ZohoInvoiceRec> & { zohoId: string; number: string; date: string }): ZohoInvoiceRec => ({
  zohoCustomerId: "c1", dueDate: o.date, customerName: "T-Fashions", status: "paid",
  total: 0, balance: 0, currency: "INR", gstin: null, placeOfSupply: null,
  subsPeriod: "Yearly", newBusiness: null, serviceExpiry: null, lines: [], ...o,
});
const base = (invoices: ZohoInvoiceRec[]): PlanInput => ({
  contacts: [contact({ zohoId: "c1", name: "T-Fashions" })],
  invoices,
  existingCustomers: [],
  existingSubscriptions: [],
  items: [{ name: "Google Workspace Business Starter", vendor: "google" }, { name: "Microsoft 365 Business Basic", vendor: "microsoft" }],
  existingInvoiceNumbers: new Set(),
  today: "2026-10-22",
  since: "2024-10-22",
});

const GW_OLD = "Google Workspace - Business Starter ( Email Solutions )";
const GW_NEW = "Google Workspace Business Starter - User License (Resale)";
const MS_OLD = "Microsoft 365 Business Basic ( Email Solutions )";
const MS_NEW = "Microsoft 365 Business Basic - User License (Resale)";

describe("R-1763 — one subscription per domain + product, whatever Zoho's item was called", () => {
  it("renamed item, old term then renewal → one subscription, 3 seats, renewal 24 Oct 2027, from the renewal invoice", () => {
    const plan = buildImportPlan(base([
      invoice({ zohoId: "i1", number: "INV-T-0101", date: "2025-10-20",
        lines: [line(GW_OLD, 3, 5400, "Domain Name: t-fashions.in Subscription Period: 1 Year/s (25/10/2025 - 24/10/2026)")] }),
      invoice({ zohoId: "i2", number: "INV-T-0871", date: "2026-10-15",
        lines: [line(GW_NEW, 3, 5940, "Domain Name: t-fashions.in Subscription Period: 1 Year/s (25/10/2026 - 24/10/2027)")] }),
    ]));
    expect(plan.subscriptions).toHaveLength(1);
    expect(plan.subscriptions[0]).toMatchObject({
      domain: "t-fashions.in", seats: 3, renewal_date: "2027-10-24", start_date: "2025-10-25",
      plan: GW_NEW, source_invoice: "INV-T-0871", source_invoice_date: "2026-10-15",
    });
    expect(plan.counts.subscriptionsMerged).toBe(1);
    const sum = summarisePlan(plan);
    expect(sum.problems).toEqual([expect.objectContaining({ code: "merged_item_names", count: 1, blocks: false })]);
  });

  it("top-up under the other item name in the same term (not marked pro-rata) → seats add: 44 + 1 = 45", () => {
    const plan = buildImportPlan(base([
      invoice({ zohoId: "i1", number: "INV-T-0200", date: "2025-12-05",
        lines: [line(GW_OLD, 44, 79200, "Domain Name: t-cotton.net Subscription Period: 1 Year/s (11/12/2025 - 10/12/2026)")] }),
      invoice({ zohoId: "i2", number: "INV-T-0350", date: "2026-05-01",
        lines: [line(GW_NEW, 1, 1100, "Domain Name: t-cotton.net Subscription Period: 224 Day/s (01/05/2026 - 10/12/2026)")] }),
    ]));
    expect(plan.subscriptions).toHaveLength(1);
    expect(plan.subscriptions[0]).toMatchObject({ seats: 45, renewal_date: "2026-12-10", source_invoice: "INV-T-0200", term_months: 12 });
  });

  it("M365 Basic 49 'Email Solutions' + 10 'User License (Resale)', same term → one subscription, 59 seats, renewal 18 Nov 2026", () => {
    const plan = buildImportPlan(base([
      invoice({ zohoId: "i1", number: "INV-T-0300", date: "2025-11-15",
        lines: [line(MS_OLD, 49, 88200, "Domain Name: t-setara.com Subscription Period: 1 Year/s (19/11/2025 - 18/11/2026)")] }),
      invoice({ zohoId: "i2", number: "INV-T-0301", date: "2025-11-16",
        lines: [line(MS_NEW, 10, 18000, "Domain Name: t-setara.com Subscription Period: 1 Year/s (19/11/2025 - 18/11/2026)")] }),
    ]));
    expect(plan.subscriptions).toHaveLength(1);
    expect(plan.subscriptions[0]).toMatchObject({ seats: 59, renewal_date: "2026-11-18", vendor: "microsoft" });
  });

  it("with Teams / without Teams and different editions stay separate", () => {
    const plan = buildImportPlan(base([
      invoice({ zohoId: "i1", number: "INV-T-0400", date: "2026-04-01",
        lines: [
          line("Microsoft 365 Business Basic (without Teams)", 5, 9000, "Domain Name: t-printers.com Subscription Period: 1 Year/s (01/04/2026 - 31/03/2027)"),
          line("Microsoft 365 Business Basic", 3, 5400, "Domain Name: t-printers.com Subscription Period: 1 Year/s (01/04/2026 - 31/03/2027)"),
          line("Microsoft 365 Business Standard", 2, 9600, "Domain Name: t-printers.com Subscription Period: 1 Year/s (01/04/2026 - 31/03/2027)"),
          line("Google Workspace Business Standard", 2, 9600, "Domain Name: t-printers.com Subscription Period: 1 Year/s (01/04/2026 - 31/03/2027)"),
        ] }),
    ]));
    expect(plan.subscriptions.map((s) => s.seats).sort()).toEqual([2, 2, 3, 5]);
    expect(plan.counts.subscriptionsMerged).toBe(0);
  });
});
