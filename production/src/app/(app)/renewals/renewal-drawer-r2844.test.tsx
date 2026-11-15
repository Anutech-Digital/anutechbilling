// @vitest-environment jsdom
/* R-2844 (Renewals history H9) — the drawer's History gets a fifth tab, Timeline: quotes (and when the app
   emailed them), invoices raised, payments, follow-ups logged and renewal reminders on ONE list, newest first
   (drawer-history.ts historyTimeline). Same rows as their own tabs / the Follow-ups section; keyboard tabs. */
import { describe, it, expect, vi, afterEach } from "vitest";
import * as React from "react";
import { render, cleanup, screen, within, fireEvent, waitFor, act } from "@testing-library/react";
import { lastDocsBySubscription, attachDocDetails, type DocInvoice, type DocQuote, type LastDocs } from "./last-docs";
import { lastPaidBySubscription, type LastPaid, type LastPaidInput } from "./last-paid";
import type { ReminderLog } from "./reminder-log";
import type { RenewalFollowupRow } from "./followup";

type Q = { data: { docs: LastDocs | undefined; paid: LastPaid | undefined; reminders: ReminderLog | null } | undefined; isLoading: boolean; isError: boolean; isSuccess: boolean };
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
  status: "accepted", payment_status: "invoiced", created_at: "2026-11-01T05:00:00Z", created_date: "2026-11-01",
  expires_date: null, invoice_id: null, renewal_subscription_id: null, add_seats_subscription_id: null,
  subscription_billing_id: null, superseded_by: null, amount: 11800, currency: "INR", exchange_rate: 1, ...over,
});
const inv = (over: Partial<DocInvoice> & { id: string }): DocInvoice => ({
  quote_id: null, invoice_date: "2026-11-05", status: "paid", amount: 11800, paid_amount: 11800, currency: "INR",
  created_at: "2026-11-05T05:00:00Z", due_date: null, ...over,
});
const dsub = { id: "S9", quote_id: "Q-9", renewal_quote_id: null, start_date: "2025-11-20" };
const docs: LastDocs = attachDocDetails(
  lastDocsBySubscription({ subs: [dsub], quotes: [q({ id: "Q-9", invoice_id: "INV-9" })], billings: [], invoices: [inv({ id: "INV-9", quote_id: "Q-9" })] }, { all: true }),
  { quotes: [], notes: new Map() },
).get("S9")!;
type Pay = LastPaidInput["payments"][number];
const paid = lastPaidBySubscription({
  subs: [dsub],
  payments: [{ id: "PAY-9", amount: 11800, method: "upi", status: "received", received_at: "2026-11-10T05:00:00Z", refunded_at: null, quote_id: "Q-9", invoice_id: "INV-9", reference: "UTR778899" } as Pay],
  linkedQuotes: [{ id: "Q-9", renewal_subscription_id: null, add_seats_subscription_id: null, invoice_id: "INV-9" }],
  billings: [], invoices: [{ id: "INV-9", quote_id: "Q-9" }],
}, { historySize: Infinity }).get("S9");
const reminders: ReminderLog = {
  email: [{ id: "E-1", cadence_step: "reminder_1", recipient_email: "a@b.in", status: "sent", sent_at: "2026-11-06T04:00:00Z" }],
  whatsapp: [],
};
const followupRows: RenewalFollowupRow[] = [{
  id: "F-1", customer_id: "c-1", subscription_id: "S9", kind: "call", note: "Will pay Monday", outcome: null,
  promised_amount: 11800, promised_on: "2026-11-10", next_follow_up_on: null, assigned_to: null, created_at: "2026-11-08T09:00:00Z",
}];

const SUB = {
  id: "S9", tenant_id: "t-1", customer_id: "c-1", customer_name: "CT R2844 Traders", plan: "Google Workspace Business Standard",
  seats: 5, vendor: "google", item_id: null, term_months: 12, mrr: 1000, term_amount: null, renewal_date: "2026-12-01",
  start_date: "2025-12-01", status: "active", renewal_quote_id: null, quote_id: "Q-9", reminder_count: 1,
};
const item: DrawerItem = {
  sub: SUB as never, daysUntil: 17, stage: null, amount: renewalAmount(SUB as never, null), frequency: "Yearly", payHref: null, docs: undefined,
  followup: { ownerId: null, nextFollowUpOn: null, promisedOn: null, promisedAmount: null, promiseStatus: null, confirmed: false } as never,
};
const withData = (d: Q["data"]) => drawerQuery.mockReturnValue({ data: d, isLoading: false, isError: false, isSuccess: true });
const show = (rows: RenewalFollowupRow[] = followupRows) =>
  render(<RenewalDrawer item={item} open onClose={() => {}} names={undefined} followupRows={rows} strong={false} />);
const history = () => within(screen.getByTestId("renewal-drawer-history"));
const tab = (name: RegExp) => history().getByRole("tab", { name });
const pick = (el: HTMLElement) => { fireEvent.mouseDown(el, { button: 0 }); fireEvent.click(el); };

afterEach(() => { cleanup(); drawerQuery.mockReset(); });

describe("R-2844 drawer History: Timeline tab", () => {
  it("a fifth tab 'Timeline' with its count (documents + payments + follow-ups + reminders)", () => {
    withData({ docs, paid, reminders });
    show();
    expect(history().getAllByRole("tab").map((t) => t.textContent)).toEqual(["All3", "Quotes1", "Invoices1", "Payments1", "Timeline5"]);
  });

  it("the reminder, the call (with its promise) and the payment show in date order on one list, documents below", () => {
    withData({ docs, paid, reminders });
    show();
    pick(tab(/^Timeline/));
    expect(tab(/^Timeline/).getAttribute("aria-selected")).toBe("true");
    const items = history().getByRole("tabpanel").querySelectorAll("ul > li");
    const words = [...items].map((li) => li.textContent ?? "");
    expect(words).toHaveLength(5);
    expect(words[0]).toMatch(/^Payment10 Nov 2026 · UPI · for INV-9.*₹11,800/);
    expect(words[0]).toContain("Ref UTR778899");
    expect(words[1]).toMatch(/^Follow-up8 Nov 2026 · Call/);
    expect(words[1]).toContain("Promised 10 Nov 2026 · ₹11,800");
    expect(words[2]).toMatch(/^Reminder6 Nov 2026 · Email · .*Sent/);
    expect(words[3]).toMatch(/^InvoiceINV-9/);
    expect(words[4]).toMatch(/^QuoteQ-9/);
    /* the invoice does not repeat the payment under it on the Timeline */
    expect(within(items[3] as HTMLElement).queryAllByTestId("renewal-drawer-payment")).toHaveLength(0);
  });

  it("the Follow-ups section still lists the same reminder and follow-up (one row component, no tag there)", () => {
    withData({ docs, paid, reminders });
    show();
    const fu = within(screen.getByTestId("renewal-drawer-followups"));
    expect(fu.getAllByTestId("renewal-drawer-reminder")[0].textContent).toMatch(/^6 Nov 2026 · Email/);
    expect(fu.getAllByTestId("renewal-drawer-followup")[0].textContent).toMatch(/^8 Nov 2026 · Call/);
  });

  it("arrow keys reach Timeline from Payments (keyboard tabs as R-2838)", async () => {
    withData({ docs, paid, reminders });
    show();
    pick(tab(/^Payments/));
    act(() => tab(/^Payments/).focus());
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    /* Radix moves focus on the next tick, then selects the focused tab */
    await waitFor(() => expect(document.activeElement).toBe(tab(/^Timeline/)));
    await waitFor(() => expect(tab(/^Timeline/).getAttribute("aria-selected")).toBe("true"));
  });

  it("nothing on the renewal → 'Nothing has happened on this renewal yet.'", () => {
    withData({ docs: undefined, paid: undefined, reminders: { email: [], whatsapp: [] } });
    show([]);
    pick(tab(/^Timeline/));
    expect(history().getByRole("tabpanel").textContent).toContain("Nothing has happened on this renewal yet.");
  });
});
