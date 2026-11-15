// @vitest-environment jsdom
/* R-2838 (Renewals history H3) — the drawer's "Quotes & invoices" + "Payments" sections become ONE
   "History" section right under the header (above Terms): tabs All · Quotes · Invoices · Payments with
   counts (role=tab, arrow keys), a "Last quote · Last invoice · Last paid" strip, "Show all N" paging,
   each payment under the invoice it paid (R-2836 historyTabs) and a link to the customer's whole history. */
import { describe, it, expect, vi, afterEach } from "vitest";
import * as React from "react";
import { readFileSync } from "node:fs";
import { render, cleanup, screen, within, fireEvent, waitFor, act } from "@testing-library/react";
import { lastDocsBySubscription, attachDocDetails, type DocInvoice, type DocQuote, type LastDocs, type LastDocsInput } from "./last-docs";
import { lastPaidBySubscription, type LastPaid, type LastPaidInput } from "./last-paid";

type Q = { data: { docs: LastDocs | undefined; paid: LastPaid | undefined; reminders: null } | undefined; isLoading: boolean; isError: boolean; isSuccess: boolean };
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
  quote_id: null, invoice_date: "2025-10-01", status: "pending", amount: 11800, paid_amount: 0, currency: "INR",
  created_at: "2025-10-01T05:00:00Z", due_date: null, ...over,
});
type DSub = LastDocsInput["subs"][number];
const docsOf = (sub: DSub, over: Partial<LastDocsInput>, periods: Record<string, string> = {}): LastDocs => {
  const m = lastDocsBySubscription({ subs: [sub], quotes: [], billings: [], invoices: [], ...over }, { all: true });
  const d = attachDocDetails(m, { quotes: [], notes: new Map() }).get(sub.id)!;
  const withPeriod = <T extends { id: string; period: string | null }>(x: T) => ({ ...x, period: periods[x.id] ?? x.period });
  return { ...d, allInvoices: d.allInvoices?.map(withPeriod), allQuotes: d.allQuotes?.map(withPeriod) };
};
type Pay = LastPaidInput["payments"][number];
const pay = (over: Partial<Pay> & { id: string }): Pay => ({
  amount: 11800, method: "bank_transfer", status: "received", received_at: "2026-01-10T05:00:00Z",
  refunded_at: null, quote_id: null, invoice_id: null, ...over,
});

const SUB = {
  id: "S2", tenant_id: "t-1", customer_id: "c-1", customer_name: "CT R2838 Traders", plan: "Google Workspace Business Standard",
  seats: 5, vendor: "google", item_id: null, term_months: 12, mrr: 1000, term_amount: null, renewal_date: "2026-12-01",
  start_date: "2025-10-01", status: "active", renewal_quote_id: null, quote_id: "Q-2", reminder_count: 0,
};
const dsub: DSub = { id: "S2", quote_id: "Q-2", renewal_quote_id: null, start_date: "2025-10-01" };
/* One quote, two invoices, one ₹14,000 receipt on the quote — today's drawer listed INV-A's ₹10,000 twice. */
const twoInvoiceDocs = docsOf(dsub, {
  quotes: [q({ id: "Q-2", invoice_id: "INV-B", amount: 20000 })],
  invoices: [
    inv({ id: "INV-B", quote_id: "Q-2", invoice_date: "2026-04-01", created_at: "2026-04-01T05:00:00Z", amount: 10000, paid_amount: 4000 }),
    inv({ id: "INV-A", quote_id: "Q-2", invoice_date: "2025-10-01", amount: 10000, paid_amount: 10000, status: "paid" }),
  ],
}, { "INV-A": "Oct 2025 – Mar 2026", "INV-B": "Apr 2026 – Sep 2026" });
const twoInvoicePaid = lastPaidBySubscription({
  subs: [dsub],
  linkedQuotes: [{ id: "Q-2", renewal_subscription_id: null, add_seats_subscription_id: null, invoice_id: "INV-B" }],
  billings: [], invoices: [{ id: "INV-A", quote_id: "Q-2" }, { id: "INV-B", quote_id: "Q-2" }],
  payments: [pay({ id: "P-14K", amount: 14000, method: "upi", quote_id: "Q-2", received_at: "2026-05-01T05:00:00Z" })],
}, { historySize: Infinity }).get("S2");

const item = (sub: Record<string, unknown> = SUB): DrawerItem => ({
  sub: sub as never, daysUntil: 17, stage: null, amount: renewalAmount(sub as never, null), frequency: "Yearly", payHref: null, docs: undefined,
  followup: { ownerId: null, nextFollowUpOn: null, promisedOn: null, promisedAmount: null, promiseStatus: null, confirmed: false } as never,
});
const withData = (docs: LastDocs | undefined, paid: LastPaid | undefined) =>
  drawerQuery.mockReturnValue({ data: { docs, paid, reminders: null }, isLoading: false, isError: false, isSuccess: true });
const show = (it = item()) => render(<RenewalDrawer item={it} open onClose={() => {}} names={undefined} followupRows={[]} strong={false} />);
const history = () => within(screen.getByTestId("renewal-drawer-history"));
const tab = (name: RegExp) => history().getByRole("tab", { name });
/* the shared Radix tabs select on mouse down (a real click = down + up) */
const pick = (el: HTMLElement) => { fireEvent.mouseDown(el, { button: 0 }); fireEvent.click(el); };

afterEach(() => { cleanup(); drawerQuery.mockReset(); withData(undefined, undefined); });

describe("R-2838 one History section replaces 'Quotes & invoices' + 'Payments'", () => {
  it("History sits under the header, above Terms; the two old sections are gone", () => {
    withData(twoInvoiceDocs, twoInvoicePaid);
    show();
    const hist = screen.getByTestId("renewal-drawer-history");
    const terms = screen.getByTestId("renewal-drawer-terms");
    expect(hist.compareDocumentPosition(terms) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByTestId("renewal-drawer-docs")).toBeNull();
    expect(screen.queryByTestId("renewal-drawer-payments")).toBeNull();
    expect(screen.queryByText(/Quotes & invoices/)).toBeNull();
    expect(within(hist).getByRole("heading", { name: "History" })).toBeTruthy();
  });

  it("tabs All · Quotes · Invoices · Payments with counts; All is selected first", () => {
    withData(twoInvoiceDocs, twoInvoicePaid);
    show();
    const tabs = history().getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["All4", "Quotes1", "Invoices2", "Payments1", "Timeline4"]);   // R-2844 added Timeline
    expect(tabs.map((t) => t.getAttribute("aria-selected"))).toEqual(["true", "false", "false", "false", "false"]);
    expect(history().getByRole("tablist", { name: "History" })).toBeTruthy();
    expect(history().getByRole("tabpanel").getAttribute("aria-labelledby")).toBe(tabs[0].id);
  });

  it("All: each invoice carries its payments — the ₹14,000 quote receipt is ₹10,000 under INV-A and ₹4,000 under INV-B, never twice", () => {
    withData(twoInvoiceDocs, twoInvoicePaid);
    show();
    const doc = (id: string) => history().getAllByTestId("renewal-drawer-doc").find((el) => el.getAttribute("data-doc") === id)!;
    const a = within(doc("INV-A")).getAllByTestId("renewal-drawer-payment");
    const b = within(doc("INV-B")).getAllByTestId("renewal-drawer-payment");
    expect(a).toHaveLength(1);
    expect(a[0].textContent).toContain("₹10,000");
    expect(a[0].textContent).toContain("part of ₹14,000");
    expect(b).toHaveLength(1);
    expect(b[0].textContent).toContain("₹4,000");
    expect(history().queryByText(/no receipt in the app/)).toBeNull();
    expect(history().getAllByTestId("renewal-drawer-doc").map((el) => el.getAttribute("data-doc"))).toEqual(["INV-B", "INV-A", "Q-2"]);   // same day: the invoice before its quote (drawerDocRows)
  });

  it("Payments tab: the receipt once at its full amount, saying which invoices it paid", () => {
    withData(twoInvoiceDocs, twoInvoicePaid);
    show();
    pick(tab(/^Payments/));
    expect(tab(/^Payments/).getAttribute("aria-selected")).toBe("true");
    const rows = history().getAllByTestId("renewal-drawer-payment");
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain("₹14,000");
    expect(rows[0].textContent).toContain("UPI");
    expect(rows[0].textContent).toContain("for INV-A, INV-B");
    /* each invoice id is still a link to its invoice (the old Payments list linked it) */
    expect(within(rows[0]).getAllByRole("link").map((a) => a.textContent)).toEqual(["INV-A", "INV-B"]);
    expect(history().queryAllByTestId("renewal-drawer-doc")).toHaveLength(0);
  });

  it("Invoices tab shows only invoices (payments nested); Quotes tab only quotes", () => {
    withData(twoInvoiceDocs, twoInvoicePaid);
    show();
    pick(tab(/^Invoices/));
    expect(history().getAllByTestId("renewal-drawer-doc").map((el) => el.getAttribute("data-kind"))).toEqual(["invoice", "invoice"]);
    expect(history().getAllByTestId("renewal-drawer-payment")).toHaveLength(2);
    pick(tab(/^Quotes/));
    expect(history().getAllByTestId("renewal-drawer-doc").map((el) => el.getAttribute("data-doc"))).toEqual(["Q-2"]);
    expect(history().queryAllByTestId("renewal-drawer-payment")).toHaveLength(0);
  });

  it("keyboard: arrows move and select (wrap), Home / End jump; only the selected tab is in the Tab order", async () => {
    withData(twoInvoiceDocs, twoInvoicePaid);
    show();
    expect(history().getAllByRole("tab").map((t) => t.tabIndex)).toEqual([0, -1, -1, -1, -1]);
    /* Radix moves focus on the next tick, then selects the focused tab */
    const press = async (key: string, to: RegExp) => {
      fireEvent.keyDown(document.activeElement!, { key });
      await waitFor(() => expect(document.activeElement).toBe(tab(to)));
      await waitFor(() => expect(tab(to).getAttribute("aria-selected")).toBe("true"));
    };
    act(() => tab(/^All/).focus());
    await press("ArrowRight", /^Quotes/);
    await press("End", /^Timeline/);   // R-2844: Timeline is the last tab
    await press("ArrowRight", /^All/);
    await press("ArrowLeft", /^Timeline/);
    await press("Home", /^All/);
    expect(history().getAllByRole("tab").map((t) => t.tabIndex)).toEqual([0, -1, -1, -1, -1]);
  });

  it("the strip: Last quote · Last invoice · Last paid", () => {
    withData(twoInvoiceDocs, twoInvoicePaid);
    show();
    const strip = within(screen.getByTestId("renewal-drawer-history-last"));
    expect(strip.getByTestId("history-last-quote").textContent).toMatch(/^Q-2/);
    expect(strip.getByTestId("history-last-invoice").textContent).toMatch(/^INV-B · /);
    expect(strip.getByTestId("history-last-paid").textContent).toBe("₹14,000 · 1 May 2026");
  });

  it("footer: 'All history for <customer> →' opens the customer's Transactions → Payments", () => {
    withData(twoInvoiceDocs, twoInvoicePaid);
    show();
    const link = history().getByRole("link", { name: /All history for CT R2838 Traders/ });
    expect(link.getAttribute("href")).toBe("/customers/c-1?tab=transactions&show=payments");
  });

  it("'Show all N' paging is kept per tab", () => {
    const many = Array.from({ length: 25 }, (_, n) => q({
      id: `Q-${String(n + 10)}`, created_at: `2025-${String((n % 9) + 1).padStart(2, "0")}-${String((n % 27) + 1).padStart(2, "0")}T05:00:00Z`,
      created_date: `2025-${String((n % 9) + 1).padStart(2, "0")}-${String((n % 27) + 1).padStart(2, "0")}`, status: "draft", payment_status: null as never, renewal_subscription_id: "S2",
    }));
    withData(docsOf({ ...dsub, quote_id: null }, { quotes: many }), undefined);
    show(item({ ...SUB, quote_id: null }));
    pick(tab(/^Quotes/));
    expect(history().getAllByTestId("renewal-drawer-doc")).toHaveLength(20);
    fireEvent.click(history().getByRole("button", { name: "Show all 25" }));
    expect(history().getAllByTestId("renewal-drawer-doc")).toHaveLength(25);
  });

  it("USD invoice with $500 on it and no receipt (R-2818): under its invoice in All, and 'for <invoice> · <period>' in Payments", () => {
    const usub: DSub = { id: "U", quote_id: "Q-U", renewal_quote_id: null, start_date: "2025-11-09" };
    withData(docsOf(usub, {
      quotes: [q({ id: "Q-U", invoice_id: "INV-U", amount: 100800 })],
      invoices: [inv({ id: "INV-U", quote_id: "Q-U", amount: 100800, paid_amount: 42000, currency: "USD", fx_rate: 84 })],
    }, { "INV-U": "9 Nov 2025 – 8 Nov 2026" }), undefined);
    show(item({ ...SUB, id: "U", quote_id: "Q-U" }));
    const nested = history().getAllByTestId("renewal-drawer-payment");
    expect(nested).toHaveLength(1);
    expect(nested[0].textContent).toContain("$500");
    expect(nested[0].textContent).toContain("Paid on the invoice — no receipt in the app");
    expect(screen.getByTestId("history-last-paid").textContent).toBe("$500 · on the invoice, no receipt");
    pick(tab(/^Payments/));
    expect(history().getByTestId("renewal-drawer-payment").textContent).toContain("for INV-U · 9 Nov 2025 – 8 Nov 2026");
  });

  it("nothing yet → plain empty words per tab, strip says none", () => {
    withData(undefined, undefined);
    show();
    expect(history().getByText("No quotes, invoices or payments yet.")).toBeTruthy();
    expect(screen.getByTestId("history-last-paid").textContent).toBe("No payment yet");
    pick(tab(/^Payments/));
    expect(history().getByText("No payment recorded in the app for this subscription.")).toBeTruthy();
  });

  it("loading and error states", () => {
    drawerQuery.mockReturnValue({ data: undefined, isLoading: true, isError: false, isSuccess: false });
    show();
    expect(history().getByLabelText("Loading history")).toBeTruthy();
    cleanup();
    drawerQuery.mockReturnValue({ data: undefined, isLoading: false, isError: true, isSuccess: false });
    show();
    expect(history().getByText("Couldn't load the history — close and open again.")).toBeTruthy();
  });

  it("wiring: historyTabs gets the subscription's own quote (instalment payments are never counted twice)", () => {
    const src = readFileSync("src/app/(app)/renewals/renewal-drawer.tsx", "utf8");
    expect(src).toMatch(/const subQuoteId = sub\?\.quote_id \?\? null;/);
    expect(src).toMatch(/historyTabs\(docs, paid, \{ subQuoteId, todayIst, tds \}\)/);
    expect(src).not.toMatch(/drawerPaymentRows\(/);
  });
});
