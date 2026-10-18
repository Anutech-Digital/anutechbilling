/**
 * R-1561 — every screen and the dunning cron ask for the SAME due on an instalment invoice.
 *
 * raise_subscription_billing used to store net_payable = gross − credit AND paid_amount =
 * credit, and every reader below computes net_payable − paid_amount, so the money already
 * received came off twice (₹2,360 instalment, ₹1,000 received → ₹360 due, not ₹1,360).
 * Migration 20261018030414 stores net_payable = gross, paid_amount = credit; SQL proof in
 * supabase/tests/r1561_instalment_due_once.test.sql.
 *
 * The fixtures are the rows that function now writes (paid 0 / part / full / leftover
 * credit on a second instalment), plus a generate_invoice-style advance-adjusted invoice
 * (net_payable = amount − advance, paid_amount = 0), whose convention must give the same
 * answer for the same money. Readers:
 *   · invoiceAmountDue — invoice PDF/QR (api/v1/documents/invoice/[id]/pdf), dunning cron
 *     (api/cron/invoice-dunning/route.ts), overdue suspension
 *   · invoiceBalance   — /invoices Outstanding tile and Customer Aging (accounting/aging)
 *   · receivableRows   — Accounting dashboard receivables
 *   · buildCollectionRows — /collections
 *   · buildPendingDuesStatement — the customer's pending-dues statement / reminders
 */
import { describe, expect, it } from "vitest";
import { invoiceAmountDue } from "./amount-due";
import { invoiceBalance } from "@/lib/invoices/kpis";
import { receivableRows } from "@/app/(app)/accounting/receivables";
import { buildCollectionRows, type CollectionInvoice } from "@/lib/queries/collections";
import { buildPendingDuesStatement } from "@/lib/collections/pending-dues";

const TODAY = "2026-10-18";

interface Fixture {
  name: string;
  amount: number;
  net_payable: number;
  paid_amount: number;
  status: "pending" | "overdue" | "paid";
  /** gross − money received, once. */
  due: number;
}

const FIXTURES: Fixture[] = [
  { name: "instalment, nothing received",            amount: 2360, net_payable: 2360, paid_amount: 0,    status: "pending", due: 2360 },
  { name: "instalment, ₹1,000 received (the bug)",   amount: 2360, net_payable: 2360, paid_amount: 1000, status: "overdue", due: 1360 },
  { name: "instalment, fully covered",               amount: 2360, net_payable: 2360, paid_amount: 2360, status: "paid",    due: 0 },
  { name: "2nd instalment, ₹640 credit left over",   amount: 2360, net_payable: 2360, paid_amount: 640,  status: "pending", due: 1720 },
  { name: "advance adjusted at issue (generate_invoice)", amount: 2360, net_payable: 1360, paid_amount: 0, status: "pending", due: 1360 },
];

const invoiceRow = (f: Fixture, i: number): CollectionInvoice & { currency: string } => ({
  id: `INV-R1561-${i}`,
  customer_id: "cust-1",
  customer_name: "Delhi 1561",
  amount: f.amount,
  net_payable: f.net_payable,
  paid_amount: f.paid_amount,
  status: f.status,
  invoice_date: "2026-09-01",
  due_date: "2026-10-01",
  quote_id: null,
  taxable_value: 2000,
  tax_amount: 360,
  tax_rate: 18,
  currency: "INR",
});

describe("R-1561: instalment invoice due is the same on every screen", () => {
  FIXTURES.forEach((f, i) => {
    it(f.name, () => {
      const inv = invoiceRow(f, i);

      const pdfAndDunning = invoiceAmountDue(inv);
      const invoicesAndAging = invoiceBalance({ ...inv, amount: f.amount });
      const dashboard = receivableRows([inv], TODAY)[0]?.amountDue ?? 0;
      const collections = buildCollectionRows({
        invoices: [inv], subscriptions: [], quoteSubscriptions: [], invoicedQuoteIds: new Set(),
        customers: [{ id: "cust-1", name: "Delhi 1561", display_name: null, account_manager_id: null }],
        followups: [],
      }, TODAY)[0]?.amountDue ?? 0;
      const statement = buildPendingDuesStatement({
        customer: { id: "cust-1", name: "Delhi 1561", display_name: null, gstin: null, address: null, city: null, state: null },
        tenant: null, invoices: [inv], subscriptions: [], invoicedQuoteIds: new Set(),
      }, TODAY).total;

      expect({ pdfAndDunning, invoicesAndAging, dashboard, collections, statement }).toEqual({
        pdfAndDunning: f.due, invoicesAndAging: f.due, dashboard: f.due, collections: f.due, statement: f.due,
      });
    });
  });

  it("the OLD stored shape (net = gross − credit AND paid = credit) under-asks by the credit", () => {
    // Documents what the repair (supabase/maintenance/r1561-instalment-due-repair.sql) fixes.
    const old = { amount: 2360, net_payable: 2360 - 1000, paid_amount: 1000, status: "pending" };
    expect(invoiceAmountDue(old)).toBe(360);
    expect(invoiceAmountDue({ ...old, net_payable: old.amount })).toBe(1360);
  });
});
