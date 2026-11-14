/**
 * R-2740 — the Renewals row drawer (Pardeep 13 Nov + audit §5.4 + user audit 14 Nov job 2: "Is
 * customer ne pichhla term pay kiya?"): every quote + invoice of the subscription with status and
 * period, every payment with method and the invoice it paid, follow-ups, and each flag explained.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { lastDocsBySubscription, attachDocDetails, detailQuoteIds, shownInvoiceIds, type DocInvoice, type DocQuote, type LastDocsInput } from "./last-docs";
import { lastPaidBySubscription, HISTORY_SIZE, type LastPaidInput } from "./last-paid";
import {
  DRAWER_PAGE, drawerSubFromSearch, withDrawerSub, drawerDocRows, drawerPage, drawerPaymentRows,
  drawerFollowupRows, drawerFlagRows, remindersWords, currentTermWords, termLengthWords, FLAG_EXPLAIN,
} from "./drawer";
import type { RenewalFollowupRow } from "./followup";

const SUB = "c2740000-0000-4000-8000-0000000000a1";
const TODAY = "2026-11-14";

const q = (over: Partial<DocQuote> & { id: string }): DocQuote => ({
  status: "accepted", payment_status: "invoiced", created_at: "2025-10-01T05:00:00Z", created_date: "2025-10-01",
  expires_date: null, invoice_id: null, renewal_subscription_id: null, add_seats_subscription_id: null,
  subscription_billing_id: null, superseded_by: null, amount: 11800, currency: "INR", exchange_rate: 1, ...over,
});
const inv = (over: Partial<DocInvoice> & { id: string }): DocInvoice => ({
  quote_id: null, invoice_date: "2025-10-01", status: "pending", amount: 11800, paid_amount: 0, currency: "INR",
  created_at: "2025-10-01T05:00:00Z", due_date: null, ...over,
});
const input = (over: Partial<LastDocsInput>): LastDocsInput => ({
  subs: [{ id: SUB, quote_id: "Q-A", renewal_quote_id: null, start_date: "2025-10-01" }],
  quotes: [], billings: [], invoices: [], ...over,
});

describe("R-2740 all documents of a subscription", () => {
  it("{ all } lists EVERY linked quote (draft, revised-away, cancelled too) and every issued invoice, newest first", () => {
    const d = lastDocsBySubscription(input({
      quotes: [
        q({ id: "Q-A", invoice_id: "INV-1" }),
        q({ id: "Q-B", renewal_subscription_id: SUB, status: "sent", payment_status: "none", superseded_by: "Q-C", created_at: "2026-09-01T05:00:00Z", created_date: "2026-09-01" }),
        q({ id: "Q-C", renewal_subscription_id: SUB, status: "sent", payment_status: "none", created_at: "2026-09-05T05:00:00Z", created_date: "2026-09-05" }),
        q({ id: "Q-D", renewal_subscription_id: SUB, status: "draft", payment_status: "none", created_at: "2026-11-01T05:00:00Z", created_date: "2026-11-01" }),
        q({ id: "Q-E", renewal_subscription_id: SUB, status: "cancelled", payment_status: "none", created_at: "2026-08-01T05:00:00Z", created_date: "2026-08-01" }),
      ],
      invoices: [
        inv({ id: "INV-1", quote_id: "Q-A", status: "paid", paid_amount: 11800 }),
        inv({ id: "INV-0", quote_id: "Q-A", status: "void", invoice_date: "2025-09-30" }),
        inv({ id: "INV-DRAFT", quote_id: "Q-A", status: "draft", invoice_date: "2026-11-02" }),
      ],
    }), { all: true }).get(SUB)!;
    expect(d.allQuotes!.map((x) => x.id)).toEqual(["Q-D", "Q-C", "Q-B", "Q-E", "Q-A"]);
    expect(d.allInvoices!.map((x) => x.id)).toEqual(["INV-1", "INV-0"]);   // a draft invoice was never issued
    /* the row's own picks are unchanged */
    expect(d.quote?.id).toBe("Q-C");
    expect(d.invoice?.id).toBe("INV-1");
  });

  it("a revised-away quote whose link moved to its revision (R-2368) is still listed, down the chain R1 → R2 → R3", () => {
    const d = lastDocsBySubscription(input({
      quotes: [
        q({ id: "Q-R3", renewal_subscription_id: SUB, status: "sent", payment_status: "none", created_at: "2026-09-09T05:00:00Z" }),
        q({ id: "Q-R2", status: "sent", payment_status: "none", superseded_by: "Q-R3", created_at: "2026-09-05T05:00:00Z" }),
        q({ id: "Q-R1", status: "sent", payment_status: "none", superseded_by: "Q-R2", created_at: "2026-09-01T05:00:00Z" }),
        q({ id: "Q-OTHER", status: "sent", payment_status: "none", superseded_by: "Q-NOT-OURS" }),
      ],
    }), { all: true }).get(SUB)!;
    expect(d.allQuotes!.map((x) => x.id)).toEqual(["Q-R3", "Q-R2", "Q-R1"]);
    expect(d.quote?.id).toBe("Q-R3");
  });

  it("the drawer read follows revisions only with { all } (the page's read stays as it was)", () => {
    const data = readFileSync(new URL("./last-docs-data.ts", import.meta.url), "utf8");
    expect(data).toMatch(/if \(opts\.all\) \{[\s\S]*?\.in\("superseded_by", run\)/);
  });

  it("without { all } the lists are not built (the page's batched read stays as it was)", () => {
    const d = lastDocsBySubscription(input({ quotes: [q({ id: "Q-A" })] })).get(SUB)!;
    expect(d.allQuotes).toBeUndefined();
    expect(d.allInvoices).toBeUndefined();
  });

  it("doc rows: invoice status words from the row's rules, quotes Draft / Sent / Revised / Cancelled, cancelled invoice greyed, $ for USD", () => {
    const d = lastDocsBySubscription(input({
      quotes: [
        q({ id: "Q-A", invoice_id: "INV-1", currency: "USD", exchange_rate: 85, amount: 85000 }),
        q({ id: "Q-B", renewal_subscription_id: SUB, status: "sent", payment_status: "none", superseded_by: "Q-C", created_date: "2026-09-01", created_at: "2026-09-01T05:00:00Z" }),
        q({ id: "Q-C", renewal_subscription_id: SUB, status: "sent", payment_status: "none", created_date: "2026-09-05", created_at: "2026-09-05T05:00:00Z", expires_date: "2026-12-31" }),
        q({ id: "Q-D", renewal_subscription_id: SUB, status: "draft", payment_status: "none", created_date: "2026-11-01", created_at: "2026-11-01T05:00:00Z" }),
      ],
      invoices: [
        inv({ id: "INV-1", quote_id: "Q-A", status: "paid", paid_amount: 85000, amount: 85000, currency: "USD", fx_rate: 85 }),
        inv({ id: "INV-9", quote_id: "Q-A", status: "void", invoice_date: "2025-12-01" }),
      ],
    }), { all: true });
    const rows = drawerDocRows(attachDocDetails(d, null).get(SUB), TODAY);
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(by["INV-1"]).toMatchObject({ kind: "invoice", status: "Paid", tone: "ok", amount: "$1,000" });
    expect(by["INV-9"]).toMatchObject({ status: "Cancelled", tone: "muted" });
    expect(by["Q-A"].amount).toBe("$1,000");
    expect(by["Q-B"]).toMatchObject({ status: "Revised — replaced by Q-C", tone: "muted", replacedBy: "Q-C" });
    expect(by["Q-C"].status).toBe("Sent");
    expect(by["Q-D"]).toMatchObject({ status: "Draft", tone: "muted" });
    /* newest first by date */
    expect(rows.map((r) => r.id)).toEqual(["Q-D", "Q-C", "Q-B", "INV-9", "INV-1", "Q-A"]);
  });

  it("a billed part's proforma + invoice carry the part's stored period", () => {
    const d = lastDocsBySubscription(input({
      billings: [{ id: "B-1", subscription_id: SUB, invoice_id: "INV-P", term_start: "2026-10-01", period_index: 1, period_start: "2026-11-01", period_end: "2026-12-01" }],
      quotes: [q({ id: "Q-P", subscription_billing_id: "B-1", invoice_id: "INV-P", created_date: "2026-11-01", created_at: "2026-11-01T05:00:00Z" })],
      invoices: [inv({ id: "INV-P", quote_id: "Q-P", invoice_date: "2026-11-01" })],
    }), { all: true });
    const rows = drawerDocRows(attachDocDetails(d, null).get(SUB), TODAY);
    expect(rows.find((r) => r.id === "Q-P")?.period).toBe("Nov 2026");
    expect(rows.find((r) => r.id === "INV-P")?.period).toBe("Nov 2026");
  });

  it("detail + note reads include the drawer's whole-quote documents (periods, credit notes)", () => {
    const d = lastDocsBySubscription(input({
      quotes: [q({ id: "Q-A", invoice_id: "INV-1" }), q({ id: "Q-OLD", renewal_subscription_id: SUB, status: "sent", payment_status: "none" })],
      invoices: [inv({ id: "INV-1", quote_id: "Q-A" }), inv({ id: "INV-OLD", quote_id: "Q-OLD", invoice_date: "2024-01-01" })],
    }), { all: true });
    expect(detailQuoteIds(d)).toEqual(expect.arrayContaining(["Q-A", "Q-OLD"]));
    expect(shownInvoiceIds(d)).toEqual(expect.arrayContaining(["INV-1", "INV-OLD"]));
  });

  it("0 documents → no rows (the drawer says 'No quotes or invoices yet')", () => {
    const d = lastDocsBySubscription(input({ subs: [{ id: SUB, quote_id: null, renewal_quote_id: null, start_date: null }] }), { all: true }).get(SUB);
    expect(drawerDocRows(d, TODAY)).toEqual([]);
    expect(drawerDocRows(undefined, TODAY)).toEqual([]);
  });

  it("200+ documents → the first DRAWER_PAGE, then Show all", () => {
    const many = Array.from({ length: 205 }, (_, i) => i);
    expect(DRAWER_PAGE).toBe(20);
    expect(drawerPage(many, false)).toEqual({ shown: many.slice(0, 20), hidden: 185 });
    expect(drawerPage(many, true).shown).toHaveLength(205);
    expect(drawerPage(many.slice(0, 20), false).hidden).toBe(0);
  });
});

describe("R-2740 payments", () => {
  const base = (payments: LastPaidInput["payments"]): LastPaidInput => ({
    subs: [{ id: SUB, quote_id: "Q-A", renewal_quote_id: null }],
    linkedQuotes: [{ id: "Q-A", renewal_subscription_id: null, add_seats_subscription_id: null, invoice_id: "INV-1" }],
    billings: [], invoices: [{ id: "INV-1", quote_id: "Q-A" }], payments,
  });
  const pay = (id: string, at: string, over: Partial<LastPaidInput["payments"][number]> = {}) => ({
    id, amount: 1000, method: "upi", status: "received", received_at: at, refunded_at: null, quote_id: "Q-A", invoice_id: null, ...over,
  });

  it("the drawer gets EVERY payment (the row keeps its last 3); refunds never count", () => {
    const ps = [pay("p1", "2026-01-01"), pay("p2", "2026-02-01"), pay("p3", "2026-03-01"), pay("p4", "2026-04-01"), pay("p5", "2026-05-01", { status: "refunded" })];
    expect(lastPaidBySubscription(base(ps)).get(SUB)!.history).toHaveLength(HISTORY_SIZE);
    const all = lastPaidBySubscription(base(ps), { historySize: Infinity }).get(SUB)!;
    expect(all.history.map((h) => h.paymentId)).toEqual(["p4", "p3", "p2", "p1"]);
  });

  it("each payment: date · amount · method · the invoice it paid (a quote payment names the quote's invoice)", () => {
    const rows = drawerPaymentRows(lastPaidBySubscription(base([pay("p1", "2026-04-01T10:00:00Z", { method: "bank_transfer", amount: 23010 })]), { historySize: Infinity }).get(SUB));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ amount: "₹23,010", doc: "INV-1", docKind: "invoice" });
    expect(rows[0].method).toMatch(/bank/i);
    expect(drawerPaymentRows(undefined)).toEqual([]);
  });
});

describe("R-2740 terms, follow-ups, flags", () => {
  it("current term = the term now running; term length in words", () => {
    expect(currentTermWords({ renewal_date: "2026-11-30", term_months: 12, start_date: "2024-12-01" })).toBe("1 Dec 2025 – 30 Nov 2026");
    expect(currentTermWords({ renewal_date: null })).toBeNull();
    expect(termLengthWords(12)).toBe("12 months");
    expect(termLengthWords(1)).toBe("1 month");
    expect(termLengthWords(36)).toBe("3 years");
  });

  it("follow-ups newest first: who · how · note · promise · next date; confirmed in words", () => {
    const r = (over: Partial<RenewalFollowupRow> & { id: string; created_at: string }): RenewalFollowupRow => ({
      customer_id: "C", subscription_id: SUB, kind: "call", note: null, outcome: null, promised_amount: null,
      promised_on: null, next_follow_up_on: null, assigned_to: null, ...over,
    });
    const rows = drawerFollowupRows([
      r({ id: "f1", created_at: "2026-11-01T05:00:00Z", note: "Asked for quote", assigned_to: "u1" }),
      r({ id: "f2", created_at: "2026-11-10T05:00:00Z", kind: "whatsapp", promised_on: "2026-11-12", promised_amount: 5000, next_follow_up_on: "2026-11-13", outcome: "renewal_confirmed", assigned_to: "u-gone" }),
    ], (id) => (id === "u1" ? "Pratik" : null));
    expect(rows.map((x) => x.id)).toEqual(["f2", "f1"]);
    expect(rows[0]).toMatchObject({ kind: "Whatsapp", who: "a colleague", outcome: "Customer confirmed the renewal" });
    expect(rows[0].promise).toMatch(/^Promised 12 Nov 2026 · ₹5,000$/);
    expect(rows[0].next).toBe("Next follow-up 13 Nov 2026");
    expect(rows[1]).toMatchObject({ who: "Pratik", note: "Asked for quote", promise: null });
  });

  it("reminders from the subscription row", () => {
    expect(remindersWords({ reminder_count: 0 })).toBe("No reminder sent yet");
    expect(remindersWords({ reminder_count: 3, last_reminder_sent_at_v2: "2026-11-02T05:00:00Z" })).toBe("3 reminders sent · last 2 Nov 2026");
    expect(remindersWords({ reminder_count: 1 })).toBe("1 reminder sent");
  });

  it("every stage flag has a title and ONE plain line; the reason (the chip's tooltip) stays with it", () => {
    for (const k of Object.keys(FLAG_EXPLAIN) as (keyof typeof FLAG_EXPLAIN)[]) {
      expect(FLAG_EXPLAIN[k].explain).not.toMatch(/\n/);
      expect(FLAG_EXPLAIN[k].explain.length).toBeGreaterThan(20);
    }
    const rows = drawerFlagRows(
      [{ key: "atRisk", reason: "At risk: Renewal 11d overdue" }, { key: "priorTermUnpaid", reason: "Previous term ₹98 still unpaid" }],
      { priorDueGap: "Balance on the subscription — no unpaid invoice linked to it", nonRenewing: { reason: "Moving to Zoho", saidOn: "2026-11-01" }, renewedAnyway: true },
    );
    expect(rows.map((r) => r.key)).toEqual(["atRisk", "priorTermUnpaid", "renewedAnyway", "nonRenewing"]);
    expect(rows[1].reason).toBe("Previous term ₹98 still unpaid · Balance on the subscription — no unpaid invoice linked to it");
    expect(rows[3].reason).toBe("Moving to Zoho · said on 1 Nov 2026");
    expect(drawerFlagRows([])).toEqual([]);
  });
});

describe("R-2740 ?sub= deep link", () => {
  it("reads only an id; sets / clears it and keeps the other parameters", () => {
    expect(drawerSubFromSearch(`?tab=overdue&sub=${SUB}`)).toBe(SUB);
    expect(drawerSubFromSearch("?sub=<script>")).toBeNull();
    expect(drawerSubFromSearch("?tab=overdue")).toBeNull();
    expect(withDrawerSub("/renewals?tab=overdue", SUB)).toBe(`/renewals?tab=overdue&sub=${SUB}`);
    expect(withDrawerSub(`/renewals?tab=overdue&sub=${SUB}`, null)).toBe("/renewals?tab=overdue");
  });
});

describe("R-2740 wiring", () => {
  const read = (f: string) => readFileSync(new URL(f, import.meta.url), "utf8");
  it("the drawer reads once per open, through the rows' own batched readers (no per-document calls)", () => {
    const data = read("./drawer-data.ts");
    expect(data).toMatch(/readRenewalDocs\(\[ref!\], \{ all: true \}\)/);
    expect(data).toMatch(/readRenewalLastPaid\(\[ref!\], \{ historySize: Infinity \}\)/);
    expect(data).toMatch(/enabled: !!ref/);
    expect(data.match(/useQuery\(/g)).toHaveLength(1);
  });
  it("read-only: the drawer's only actions are the row's RenewalActions (+ ⋯) — no other mutation", () => {
    const ui = read("./renewal-drawer.tsx");
    expect(ui).toMatch(/<RenewalActions /);
    expect(ui).not.toMatch(/useMutation|\.insert\(|\.update\(|\.rpc\(/);
  });
  it("the page opens it from the product name (a button) and ?sub=", () => {
    const page = read("./page.tsx");
    expect(page).toMatch(/<RenewalDrawer\b/);
    expect(page).toMatch(/useRenewalDrawerSub\(\)/);
    expect(read("./renewal-drawer.tsx")).toMatch(/drawerSubFromSearch\(window\.location\.search\)/);
    expect(read("./row-cells.tsx")).toMatch(/data-testid="renewal-open-drawer"/);
  });
});
