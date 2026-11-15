/**
 * R-2844 (Renewals history H9 — audit RENEWALS-AUDIT/audit-2026-11-15-history.md H9): the drawer's
 * Timeline — ONE list, newest first, of everything that happened on the renewal: quotes (their row says
 * Sent / Accepted …), invoices raised, payments (R-2836 lines, R-2843 receipt/UTR/TDS kept), follow-ups
 * logged (calls, promises) and renewal reminders emailed / WhatsApp'd (R-2762 log). Pure merge of rows the
 * drawer already has — no new read.
 */
import { describe, it, expect } from "vitest";
import { lastDocsBySubscription, attachDocDetails, type DocInvoice, type DocQuote, type LastDocs, type LastDocsInput } from "./last-docs";
import { lastPaidBySubscription, type LastPaidInput } from "./last-paid";
import { drawerFollowupRows, NO_RECEIPT_METHOD } from "./drawer";
import { drawerReminderRows } from "./reminder-log";
import { historyTabs, historyTimeline, type TimelineItem } from "./drawer-history";
import type { RenewalFollowupRow } from "./followup";

const TODAY = "2026-11-15";
const q = (over: Partial<DocQuote> & { id: string }): DocQuote => ({
  status: "accepted", payment_status: "invoiced", created_at: "2025-10-01T05:00:00Z", created_date: "2025-10-01",
  expires_date: null, invoice_id: null, renewal_subscription_id: null, add_seats_subscription_id: null,
  subscription_billing_id: null, superseded_by: null, amount: 11800, currency: "INR", exchange_rate: 1, ...over,
});
const inv = (over: Partial<DocInvoice> & { id: string }): DocInvoice => ({
  quote_id: null, invoice_date: "2025-10-01", status: "pending", amount: 11800, paid_amount: 0, currency: "INR",
  created_at: "2025-10-01T05:00:00Z", due_date: null, ...over,
});
type Sub = LastDocsInput["subs"][number];
const docsOf = (sub: Sub, over: Partial<LastDocsInput>): LastDocs => {
  const m = lastDocsBySubscription({ subs: [sub], quotes: [], billings: [], invoices: [], ...over }, { all: true });
  return attachDocDetails(m, { quotes: [], notes: new Map() }).get(sub.id)!;
};
type Pay = LastPaidInput["payments"][number];
const pay = (over: Partial<Pay> & { id: string }): Pay => ({
  amount: 11800, method: "upi", status: "received", received_at: "2026-11-10T05:00:00Z",
  refunded_at: null, quote_id: null, invoice_id: null, ...over,
});
const fu = (over: Partial<RenewalFollowupRow> & { id: string; created_at: string }): RenewalFollowupRow => ({
  customer_id: "c-1", subscription_id: "S9", kind: "call", note: null, outcome: null, promised_amount: null,
  promised_on: null, next_follow_up_on: null, assigned_to: null, ...over,
});

const sub: Sub = { id: "S9", quote_id: "Q-9", renewal_quote_id: null, start_date: "2025-11-20" };
const docs = docsOf(sub, {
  quotes: [q({ id: "Q-9", invoice_id: "INV-9", created_at: "2026-11-01T05:00:00Z", created_date: "2026-11-01" })],
  invoices: [inv({ id: "INV-9", quote_id: "Q-9", invoice_date: "2026-11-05", created_at: "2026-11-05T05:00:00Z", paid_amount: 11800, status: "paid" })],
});
const paid = lastPaidBySubscription({
  subs: [sub],
  payments: [pay({ id: "PAY-9", invoice_id: "INV-9", quote_id: "Q-9", received_at: "2026-11-10T05:00:00Z", reference: "UTR778899" } as Partial<Pay> & { id: string })],
  linkedQuotes: [{ id: "Q-9", renewal_subscription_id: null, add_seats_subscription_id: null, invoice_id: "INV-9" }],
  billings: [], invoices: [{ id: "INV-9", quote_id: "Q-9" }],
}, { historySize: Infinity }).get(sub.id);
const tabs = historyTabs(docs, paid, { subQuoteId: sub.quote_id, todayIst: TODAY });
const followups = drawerFollowupRows([
  fu({ id: "F-1", created_at: "2026-11-08T09:00:00Z", kind: "call", note: "Will pay Monday", promised_on: "2026-11-10", promised_amount: 11800 }),
], () => null);
const reminders = drawerReminderRows({
  email: [{ id: "E-1", cadence_step: "reminder_1", recipient_email: "a@b.in", status: "sent", sent_at: "2026-11-06T04:00:00Z" }],
  whatsapp: [{ id: "W-1", kind: "renewal_reminder", step: "reminder_2", phone: "+91 98100 00000", status: "delivered", sent_at: "2026-11-09T04:00:00Z", created_at: "2026-11-09T04:00:00Z" }],
});

const shape = (t: readonly TimelineItem[]) => t.map((i) => i.key);

describe("R-2844 drawer Timeline: one list, newest first", () => {
  it("a renewal with a reminder, a call and a payment shows all three (and the documents) in date order", () => {
    const t = historyTimeline(tabs, { followups, reminders });
    expect(shape(t)).toEqual([
      "payment:PAY-9",          // 10 Nov
      "reminder:whatsapp:W-1", // 9 Nov
      "followup:F-1",          // 8 Nov
      "reminder:email:E-1",    // 6 Nov
      "invoice:INV-9",              // 5 Nov (raised)
      "quote:Q-9",                  // 1 Nov
    ]);
  });

  it("reuses the rows the drawer already shows: payment keeps 'for <invoice>', its UTR; follow-up keeps the promise", () => {
    const t = historyTimeline(tabs, { followups, reminders });
    const p = t.find((i) => i.kind === "payment");
    expect(p?.kind === "payment" && p.line).toMatchObject({ id: "PAY-9", amount: "₹11,800", reference: "UTR778899", forWords: expect.stringContaining("for INV-9") });
    const f = t.find((i) => i.kind === "followup");
    expect(f?.kind === "followup" && f.row.promise).toBe("Promised 10 Nov 2026 · ₹11,800");
    const r = t.find((i) => i.kind === "reminder" && i.row.channel === "WhatsApp");
    expect(r?.kind === "reminder" && r.row.status).toBe("Delivered");
  });

  it("an invoice on the Timeline does not repeat its payments under it (each payment is its own line)", () => {
    const t = historyTimeline(tabs, { followups, reminders });
    const i = t.find((x) => x.kind === "doc" && x.row.kind === "invoice");
    expect(i?.kind === "doc" && i.row.kind === "invoice" && i.row.payments).toEqual([]);
    expect(t.filter((x) => x.kind === "payment")).toHaveLength(tabs.payments.length);
  });

  it("same IST day: a time beats a date-only document; a payment at 01:30 IST belongs to that IST day", () => {
    /* 20:00 UTC on 4 Nov = 01:30 IST on 5 Nov — after the invoice dated 5 Nov, not before it */
    const late = lastPaidBySubscription({
      subs: [sub],
      payments: [pay({ id: "PAY-L", invoice_id: "INV-9", quote_id: "Q-9", received_at: "2026-11-04T20:00:00Z" })],
      linkedQuotes: [{ id: "Q-9", renewal_subscription_id: null, add_seats_subscription_id: null, invoice_id: "INV-9" }],
      billings: [], invoices: [{ id: "INV-9", quote_id: "Q-9" }],
    }, { historySize: Infinity }).get(sub.id);
    const t = historyTimeline(historyTabs(docs, late, { subQuoteId: sub.quote_id, todayIst: TODAY }), {});
    expect(shape(t)).toEqual(["payment:PAY-L", "invoice:INV-9", "quote:Q-9"]);
  });

  it("money on the invoice with no receipt (R-2818) sits right above its invoice", () => {
    const t = historyTimeline(historyTabs(docs, undefined, { subQuoteId: sub.quote_id, todayIst: TODAY }), {});
    expect(shape(t)).toEqual(["payment:invoice-paid:INV-9", "invoice:INV-9", "quote:Q-9"]);
    const gap = t[0];
    expect(gap.kind === "payment" && gap.line).toMatchObject({ noReceipt: true, method: NO_RECEIPT_METHOD });
  });

  it("nothing yet → empty; follow-ups / reminders alone still make a Timeline", () => {
    const empty = historyTabs(undefined, undefined, { subQuoteId: null, todayIst: TODAY });
    expect(historyTimeline(empty, {})).toEqual([]);
    expect(shape(historyTimeline(empty, { followups, reminders }))).toEqual([
      "reminder:whatsapp:W-1", "followup:F-1", "reminder:email:E-1",
    ]);
  });
});
