// @vitest-environment jsdom
/* R-2843 (Renewals history H8): each payment line in the drawer's History shows its receipt no., its
   reference / UTR and its TDS ("TDS ₹x · 194J" — the customer page's PaymentTdsLine, reused). The data
   rides on the drawer's one payments read (receipt_voucher_no, reference) + tds_receivable by payment id. */
import { describe, it, expect, vi, afterEach } from "vitest";
import * as React from "react";
import { render, cleanup, screen, within, fireEvent } from "@testing-library/react";
import { lastDocsBySubscription, attachDocDetails, type DocInvoice, type DocQuote, type LastDocs, type LastDocsInput } from "./last-docs";
import { lastPaidBySubscription, type LastPaid, type LastPaidInput } from "./last-paid";
import { tdsInfoByPayment, type PaymentTds } from "@/components/features/customers/payment-tds-line";

type Q = { data: { docs: LastDocs | undefined; paid: LastPaid | undefined; reminders: null; tds?: Record<string, PaymentTds> } | undefined; isLoading: boolean; isError: boolean; isSuccess: boolean };
const drawerQuery = vi.fn((): Q => ({ data: { docs: undefined, paid: undefined, reminders: null }, isLoading: false, isError: false, isSuccess: true }));
vi.mock("@/lib/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ data: { role: "owner" } }) }));
vi.mock("@/lib/dates/ist", async (orig) => ({ ...(await orig<typeof import("@/lib/dates/ist")>()), istToday: () => "2026-11-15" }));
vi.mock("./drawer-data", () => ({ useRenewalDrawerData: () => drawerQuery() }));
vi.mock("./drawer-cost-data", () => ({ useRenewalDrawerCatalog: () => ({ data: [], isError: false }) }));
vi.mock("./drawer-seat-cut-data", () => ({ useRenewalDrawerSeatCuts: () => ({ data: [], isError: false }) }));
vi.mock("@/components/features/renewals/renewal-actions", () => ({ RenewalActions: () => null }));
vi.mock("next/link", () => ({ default: ({ href, children, ...p }: { href: string; children: React.ReactNode }) => <a href={href} {...p}>{children}</a> }));

import { RenewalDrawer, type DrawerItem } from "./renewal-drawer";
import { renewalAmount } from "./queue";

const q = (over: Partial<DocQuote> & { id: string }): DocQuote => ({
  status: "accepted", payment_status: "invoiced", created_at: "2025-10-01T05:00:00Z", created_date: "2025-10-01",
  expires_date: null, invoice_id: null, renewal_subscription_id: null, add_seats_subscription_id: null,
  subscription_billing_id: null, superseded_by: null, amount: 11800, currency: "INR", exchange_rate: 1, ...over,
});
const inv = (over: Partial<DocInvoice> & { id: string }): DocInvoice => ({
  quote_id: null, invoice_date: "2025-10-01", status: "paid", amount: 11800, paid_amount: 11800, currency: "INR",
  created_at: "2025-10-01T05:00:00Z", due_date: null, ...over,
});
type DSub = LastDocsInput["subs"][number];
const dsub: DSub = { id: "S3", quote_id: "Q-3", renewal_quote_id: null, start_date: "2025-10-01" };
const docs = (): LastDocs => {
  const m = lastDocsBySubscription({ subs: [dsub], quotes: [q({ id: "Q-3", invoice_id: "INV-3" })], billings: [], invoices: [inv({ id: "INV-3", quote_id: "Q-3" })] }, { all: true });
  return attachDocDetails(m, { quotes: [], notes: new Map() }).get("S3")!;
};
type Pay = LastPaidInput["payments"][number];
const pay = (over: Partial<Pay> & { id: string }): Pay => ({
  amount: 11800, method: "bank_transfer", status: "received", received_at: "2026-01-10T05:00:00Z",
  refunded_at: null, quote_id: null, invoice_id: "INV-3", ...over,
});
const paidOf = (payments: Pay[]) => lastPaidBySubscription({
  subs: [dsub], linkedQuotes: [{ id: "Q-3", renewal_subscription_id: null, add_seats_subscription_id: null, invoice_id: "INV-3" }],
  billings: [], invoices: [{ id: "INV-3", quote_id: "Q-3" }], payments,
}, { historySize: Infinity }).get("S3");

const SUB = {
  id: "S3", tenant_id: "t-1", customer_id: "c-1", customer_name: "CT R2843 Traders", plan: "Google Workspace Business Standard",
  seats: 5, vendor: "google", item_id: null, term_months: 12, mrr: 1000, term_amount: null, renewal_date: "2026-12-01",
  start_date: "2025-10-01", status: "active", renewal_quote_id: null, quote_id: "Q-3", reminder_count: 0,
};
const item = (): DrawerItem => ({
  sub: SUB as never, daysUntil: 17, stage: null, amount: renewalAmount(SUB as never, null), frequency: "Yearly", payHref: null, docs: undefined,
  followup: { ownerId: null, nextFollowUpOn: null, promisedOn: null, promisedAmount: null, promiseStatus: null, confirmed: false } as never,
});
const withData = (paid: LastPaid | undefined, tds?: Record<string, PaymentTds>) =>
  drawerQuery.mockReturnValue({ data: { docs: docs(), paid, reminders: null, tds }, isLoading: false, isError: false, isSuccess: true });
const show = () => render(<RenewalDrawer item={item()} open onClose={() => {}} names={undefined} followupRows={[]} strong={false} />);
const history = () => within(screen.getByTestId("renewal-drawer-history"));
const pick = (el: HTMLElement) => { fireEvent.mouseDown(el, { button: 0 }); fireEvent.click(el); };

afterEach(() => { cleanup(); drawerQuery.mockReset(); });

describe("R-2843 last-paid carries receipt no. and reference", () => {
  it("lastPaidBySubscription puts receipt_voucher_no and reference on the line (trimmed, null when blank)", () => {
    const p = paidOf([pay({ id: "P1", receipt_voucher_no: " RV-0007 ", reference: "UTR123456" }), pay({ id: "P0", received_at: "2025-12-01T05:00:00Z", reference: "  " })])!;
    expect(p.history[0]).toMatchObject({ paymentId: "P1", receiptNo: "RV-0007", reference: "UTR123456" });
    expect(p.history[1]).toMatchObject({ paymentId: "P0", receiptNo: null, reference: null });
  });
});

describe("R-2843 drawer History payment line", () => {
  const tds = tdsInfoByPayment([{ payment_id: "P1", tds_amount: 1180, section: "194J" }]);

  it("shows Receipt no., Ref (UTR) and TDS under the payment, on All (under its invoice) and on Payments", () => {
    withData(paidOf([pay({ id: "P1", receipt_voucher_no: "RV-0007", reference: "UTR123456" })]), tds);
    show();
    let row = history().getAllByTestId("renewal-drawer-payment")[0];
    expect(within(row).getByTestId("renewal-drawer-payment-ids").textContent).toBe("Receipt RV-0007 · Ref UTR123456");
    expect(within(row).getByTestId("payment-tds-line").textContent).toContain("TDS ₹1,180");
    expect(within(row).getByTestId("payment-tds-line").textContent).toContain("194J");
    pick(history().getByRole("tab", { name: /^Payments/ }));
    row = history().getAllByTestId("renewal-drawer-payment")[0];
    expect(row.textContent).toContain("Receipt RV-0007");
    expect(within(row).getByTestId("payment-tds-line").textContent).toContain("194J");
  });

  it("no TDS, no receipt no., no reference: nothing extra is drawn", () => {
    withData(paidOf([pay({ id: "P1" })]), {});
    show();
    const row = history().getAllByTestId("renewal-drawer-payment")[0];
    expect(within(row).queryByTestId("renewal-drawer-payment-ids")).toBeNull();
    expect(within(row).queryByTestId("payment-tds-line")).toBeNull();
  });

  it("only a reference: shows just 'Ref …'", () => {
    withData(paidOf([pay({ id: "P1", reference: "CHQ 000123" })]));
    show();
    expect(history().getByTestId("renewal-drawer-payment-ids").textContent).toBe("Ref CHQ 000123");
  });

  it("a payment split over two invoices shows TDS only at its full amount (Payments tab), not on each part", () => {
    const two = lastDocsBySubscription({
      subs: [dsub], quotes: [q({ id: "Q-3", invoice_id: "INV-B", amount: 20000 })], billings: [],
      invoices: [inv({ id: "INV-B", quote_id: "Q-3", invoice_date: "2026-04-01", created_at: "2026-04-01T05:00:00Z", amount: 10000, paid_amount: 4000, status: "pending" }), inv({ id: "INV-A", quote_id: "Q-3", amount: 10000, paid_amount: 10000 })],
    }, { all: true });
    const d = attachDocDetails(two, { quotes: [], notes: new Map() }).get("S3")!;
    const paid = lastPaidBySubscription({
      subs: [dsub], linkedQuotes: [{ id: "Q-3", renewal_subscription_id: null, add_seats_subscription_id: null, invoice_id: "INV-B" }],
      billings: [], invoices: [{ id: "INV-A", quote_id: "Q-3" }, { id: "INV-B", quote_id: "Q-3" }],
      payments: [pay({ id: "P1", amount: 14000, quote_id: "Q-3", invoice_id: null, receipt_voucher_no: "RV-9" })],
    }, { historySize: Infinity }).get("S3");
    drawerQuery.mockReturnValue({ data: { docs: d, paid, reminders: null, tds: tdsInfoByPayment([{ payment_id: "P1", tds_amount: 1400, section: "194C" }]) }, isLoading: false, isError: false, isSuccess: true });
    show();
    expect(history().queryAllByTestId("payment-tds-line")).toHaveLength(0);   // All: two parts
    pick(history().getByRole("tab", { name: /^Payments/ }));
    expect(history().getAllByTestId("payment-tds-line")).toHaveLength(1);
    expect(history().getByTestId("renewal-drawer-payment-ids").textContent).toBe("Receipt RV-9");
  });
});
