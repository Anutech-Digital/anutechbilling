/**
 * R-2728 (Pardeep, 13 Nov 2026 — Pratik's daily /renewals): each row shows the last quote SENT
 * and the last invoice (clickable); a row whose renewal quote was sent — or whose renewal part
 * bill was raised by "Bill next part" — stays, with status "Renewal quote sent" and how many days
 * the quote is still valid (IST).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  lastDocsBySubscription, quoteExpiryText, renewalDueText, quoteStateLabel, invoiceStatusWords, daysBetweenIst,
  type LastDocsInput, type DocQuote, type DocBilling, type DocInvoice,
} from "./last-docs";
import { renewalRowStatus, STATUS_FILTER_LABEL, filterQueue, NO_FILTERS, QUEUE_TABLE_COLS, QUEUE_TABLE_BUDGET_PX } from "./queue";
import { tileMatches, monthOf } from "./tiles";
import { istToday } from "@/lib/dates/ist";

const SUB = "c2728000-0000-4000-8000-0000000000a1";
const SUB2 = "22222222-2222-2222-2222-222222222222";

const q = (over: Partial<DocQuote> & { id: string }): DocQuote => ({
  status: "sent", payment_status: "none", created_at: "2026-11-01T05:00:00Z", created_date: "2026-11-01",
  expires_date: null, invoice_id: null, renewal_subscription_id: null, add_seats_subscription_id: null,
  subscription_billing_id: null, superseded_by: null, ...over,
});
const inv = (over: Partial<DocInvoice> & { id: string }): DocInvoice => ({
  quote_id: null, invoice_date: "2026-11-01", status: "pending", amount: 11800, paid_amount: 0, currency: "INR", created_at: "2026-11-01T05:00:00Z", ...over,
});
const bill = (over: Partial<DocBilling> & { id: string }): DocBilling => ({
  subscription_id: SUB, invoice_id: null, term_start: "2026-12-07", period_index: 1, ...over,
});
const input = (over: Partial<LastDocsInput>): LastDocsInput => ({
  subs: [{ id: SUB, quote_id: "Q-ORIG", renewal_quote_id: null, start_date: "2025-12-07" }],
  quotes: [], billings: [], invoices: [], ...over,
});

describe("R-2728 last quote sent + last invoice per subscription", () => {
  it("picks the newest SENT quote among the original, renewal, add-seats and part quotes — drafts, cancelled and superseded left out", () => {
    const m = lastDocsBySubscription(input({
      subs: [{ id: SUB, quote_id: "Q-ORIG", renewal_quote_id: "Q-REN", start_date: "2025-12-07" }],
      quotes: [
        q({ id: "Q-ORIG", status: "accepted", payment_status: "received", created_at: "2025-12-01T05:00:00Z", created_date: "2025-12-01" }),
        q({ id: "Q-REN", status: "sent", created_at: "2026-11-05T05:00:00Z", created_date: "2026-11-05", expires_date: "2026-12-05", renewal_subscription_id: SUB }),
        q({ id: "Q-DRAFT", status: "draft", created_at: "2026-11-09T05:00:00Z", renewal_subscription_id: SUB }),
        q({ id: "Q-CANC", status: "cancelled", created_at: "2026-11-10T05:00:00Z", renewal_subscription_id: SUB }),
        q({ id: "Q-OLD-R1", status: "sent", created_at: "2026-11-11T05:00:00Z", renewal_subscription_id: SUB, superseded_by: "Q-REN" }),
      ],
    }));
    expect(m.get(SUB)?.quote).toMatchObject({ id: "Q-REN", date: "2026-11-05", status: "sent" });
  });

  it("a part proforma raised by Bill next part counts (linked through subscription_billings)", () => {
    const m = lastDocsBySubscription(input({
      quotes: [
        q({ id: "Q-ORIG", status: "accepted", payment_status: "received", created_at: "2025-12-01T05:00:00Z" }),
        q({ id: "PI-1", status: "sent", payment_status: "awaiting", created_at: "2026-11-12T05:00:00Z", created_date: "2026-11-12", subscription_billing_id: "b1" }),
      ],
      billings: [bill({ id: "b1" })],
    }));
    expect(m.get(SUB)?.quote?.id).toBe("PI-1");
  });

  /* R-2737: a void invoice is no longer left out when it is the NEWEST (it shows "Cancelled",
     last-docs-r2737.test.ts) — an older void one still never hides a newer live one. */
  it("the newest invoice (quote's invoice or the part's billing invoice), an older void one left out; paid / part paid / unpaid", () => {
    const m = lastDocsBySubscription(input({
      quotes: [q({ id: "Q-ORIG", status: "accepted", payment_status: "invoiced", invoice_id: "INV-1" })],
      billings: [bill({ id: "b1", invoice_id: "INV-3" })],
      invoices: [
        inv({ id: "INV-1", quote_id: "Q-ORIG", invoice_date: "2025-12-02", status: "paid", paid_amount: 11800 }),
        inv({ id: "INV-3", invoice_date: "2026-06-07", status: "pending", amount: 5900, paid_amount: 2000 }),
        inv({ id: "INV-VOID", quote_id: "Q-ORIG", invoice_date: "2026-05-01", status: "void" }),
        inv({ id: "INV-DRAFT", quote_id: "Q-ORIG", invoice_date: "2026-10-02", status: "draft" }),
      ],
    }));
    const i = m.get(SUB)?.invoice;
    expect(i).toMatchObject({ id: "INV-3", date: "2026-06-07" });
    expect(invoiceStatusWords(i!, "2026-11-13").text).toBe("Part paid · ₹3,900 due");
    expect(invoiceStatusWords({ ...i!, status: "paid", paidAmount: 5900 }, "2026-11-13").text).toBe("Paid");
    expect(invoiceStatusWords({ ...i!, paidAmount: 0 }, "2026-11-13").text).toBe("Unpaid · ₹5,900");
  });

  it("nothing linked → null, never another subscription's documents", () => {
    const m = lastDocsBySubscription(input({
      subs: [
        { id: SUB, quote_id: null, renewal_quote_id: null, start_date: null },
        { id: SUB2, quote_id: "Q-2", renewal_quote_id: null, start_date: null },
      ],
      quotes: [q({ id: "Q-2" })],
    }));
    expect(m.get(SUB)).toMatchObject({ quote: null, invoice: null, sent: null });
    expect(m.get(SUB2)?.quote?.id).toBe("Q-2");
  });
});

describe("R-2728 'Renewal quote sent' — which rows", () => {
  it("the linked renewal quote sent / viewed / accepted and unpaid → sent (with its expiry); paid → not", () => {
    for (const status of ["sent", "viewed", "accepted"]) {
      const m = lastDocsBySubscription(input({
        subs: [{ id: SUB, quote_id: "Q-ORIG", renewal_quote_id: "Q-REN", start_date: "2025-12-07" }],
        quotes: [q({ id: "Q-REN", status, payment_status: "awaiting", expires_date: "2026-12-05", renewal_subscription_id: SUB })],
      }));
      expect(m.get(SUB)?.sent).toMatchObject({ quoteId: "Q-REN", kind: "renewal", expiresDate: "2026-12-05" });
    }
    for (const payment_status of ["received", "invoiced"]) {
      const m = lastDocsBySubscription(input({
        subs: [{ id: SUB, quote_id: "Q-ORIG", renewal_quote_id: "Q-REN", start_date: "2025-12-07" }],
        quotes: [q({ id: "Q-REN", status: "accepted", payment_status, renewal_subscription_id: SUB })],
      }));
      expect(m.get(SUB)?.sent).toBeNull();
    }
  });

  it("a DRAFT renewal quote is not sent (the row keeps 'not sent yet')", () => {
    const m = lastDocsBySubscription(input({
      subs: [{ id: SUB, quote_id: "Q-ORIG", renewal_quote_id: "Q-REN", start_date: "2025-12-07" }],
      quotes: [q({ id: "Q-REN", status: "draft", renewal_subscription_id: SUB })],
    }));
    expect(m.get(SUB)?.sent).toBeNull();
  });

  it("Bill next part: part 1 of the newest (not first) term, sent and unpaid → sent (due on its own date); a mid-term part or the first term's → not", () => {
    const base = { quotes: [q({ id: "PI-1", payment_status: "awaiting", subscription_billing_id: "b1" })] };
    const sent = lastDocsBySubscription(input({ ...base, billings: [bill({ id: "b0", term_start: "2025-12-07" }), bill({ id: "b1", term_start: "2026-12-07", due_on: "2026-12-14" })] }));
    expect(sent.get(SUB)?.sent).toMatchObject({ quoteId: "PI-1", kind: "part", expiresDate: null, dueDate: "2026-12-14" });
    /* period_index restarts at 1 each term (migration 20260817110000) — a few old rows start at 0: the term's lowest is part 1 */
    const zeroBased = lastDocsBySubscription(input({ ...base, billings: [bill({ id: "b1", period_index: 0 }), bill({ id: "b2", period_index: 1 })] }));
    expect(zeroBased.get(SUB)?.sent?.quoteId).toBe("PI-1");
    const midTerm = lastDocsBySubscription(input({ ...base, billings: [bill({ id: "b0" }), bill({ id: "b1", period_index: 2 })] }));
    expect(midTerm.get(SUB)?.sent).toBeNull();
    const firstTerm = lastDocsBySubscription(input({ ...base, billings: [bill({ id: "b1", term_start: "2025-12-07" })] }));
    expect(firstTerm.get(SUB)?.sent).toBeNull();
    const older = lastDocsBySubscription(input({ ...base, billings: [bill({ id: "b1", term_start: "2026-12-07" }), bill({ id: "b2", term_start: "2027-12-07" })] }));
    expect(older.get(SUB)?.sent).toBeNull();
    const paid = lastDocsBySubscription(input({ quotes: [q({ id: "PI-1", status: "accepted", payment_status: "received", subscription_billing_id: "b1" })], billings: [bill({ id: "b1" })] }));
    expect(paid.get(SUB)?.sent).toBeNull();
  });

  it("row status: 'Renewal quote sent' beats Overdue / Due / a stale or roll-made 'renewed', loses to stopped / won't renew / paid", () => {
    const TODAY = new Date("2026-11-13T06:30:00Z");
    const s = { renewal_date: "2026-11-01", term_months: 12, status: "active", renewal_state: "notice_sent" };
    const sent = { quoteId: "Q-REN", kind: "renewal" as const, expiresDate: null, status: "sent" };
    expect(renewalRowStatus(s, -12, { tenantGraceDays: 0, today: TODAY, quoteSent: sent })).toMatchObject({ key: "quote-sent", label: "Renewal quote sent" });
    /* Bill next part rolled the date + set 'renewed', the part is unpaid → still sent, not Renewed */
    const rolled = { ...s, renewal_date: "2027-12-07", renewal_state: "renewed", billing_cycle: "half_yearly", start_date: "2025-12-07" };
    expect(renewalRowStatus(rolled, 389, { tenantGraceDays: 0, today: TODAY, quoteSent: { ...sent, kind: "part" } }).key).toBe("quote-sent");
    expect(renewalRowStatus(rolled, 389, { tenantGraceDays: 0, today: TODAY }).key).toBe("renewed");
    expect(renewalRowStatus({ ...s, renewal_state: "suspended" }, -12, { tenantGraceDays: 0, today: TODAY, quoteSent: sent }).key).toBe("stopped");
    expect(renewalRowStatus({ ...s, auto_renew: false }, 5, { tenantGraceDays: 0, today: TODAY, quoteSent: sent }).key).toBe("non-renewing");
    expect(renewalRowStatus(s, -12, { tenantGraceDays: 0, today: TODAY, quoteSent: sent, renewalPaid: true }).key).toBe("renewed");
    /* review: a stale open renewal quote never undoes a settled Renewed (no Record payment twice) */
    const settled = { ...s, renewal_date: "2027-11-01", renewal_state: "renewed" };
    expect(renewalRowStatus(settled, 353, { tenantGraceDays: 0, today: TODAY, quoteSent: sent }).key).toBe("renewed");
    /* review: "N bills not raised" (danger) is not hidden by a renewal quote */
    const behind = { ...s, billing_cycle: "monthly", start_date: "2025-11-01", renewal_date: "2026-09-01", renewal_state: "notice_sent" };
    expect(renewalRowStatus(behind, -73, { tenantGraceDays: 0, today: TODAY, quoteSent: sent }).key).toBe("bills-not-raised");
    /* past the date with a grace: the grace line stays under "Renewal quote sent" */
    expect(renewalRowStatus(s, -2, { tenantGraceDays: 7, today: TODAY, quoteSent: sent }).note).toMatch(/In grace/);
  });

  it("the status filter has 'Renewal quote sent' and lists exactly those rows", () => {
    expect(STATUS_FILTER_LABEL["quote-sent"]).toBe("Renewal quote sent");
    const rows = [
      { id: "a", daysUntil: -3, amount: 1, plan: null, vendor: null, statusKey: "quote-sent" as const, atRisk: false, customer: "A" },
      { id: "b", daysUntil: -3, amount: 1, plan: null, vendor: null, statusKey: "overdue" as const, atRisk: false, customer: "B" },
    ];
    expect(filterQueue(rows, { ...NO_FILTERS, status: "quote-sent" }).map((r) => r.id)).toEqual(["a"]);
  });

  it("tiles: a sent row is counted once — in its own window, as money still due (not Renewed)", () => {
    const month = monthOf("2026-11-13");
    const r = { id: "a", tab: "d30" as const, statusKey: "quote-sent" as const, amount: 100, renewalDate: "2026-11-30" };
    const hits = (["overdue", "due30", "due60", "due90", "wontRenew"] as const).filter((k) => tileMatches(k, r, month));
    expect(hits).toEqual(["due30"]);
    expect(tileMatches("overdue", { ...r, tab: "overdue" }, month)).toBe(true);
    expect(tileMatches("due30", { ...r, tab: "overdue" }, month)).toBe(false);
  });
});

describe("R-2728 expiry + due words (IST days)", () => {
  it("Expires in N days / today / Expired N days ago / No expiry set", () => {
    expect(quoteExpiryText("2026-11-23", "2026-11-13")).toBe("Expires in 10 days");
    expect(quoteExpiryText("2026-11-14", "2026-11-13")).toBe("Expires in 1 day");
    expect(quoteExpiryText("2026-11-13", "2026-11-13")).toBe("Expires today");
    expect(quoteExpiryText("2026-11-12", "2026-11-13")).toBe("Expired 1 day ago");
    expect(quoteExpiryText("2026-11-03", "2026-11-13")).toBe("Expired 10 days ago");
    expect(quoteExpiryText(null, "2026-11-13")).toBe("No expiry set");
  });

  it("IST boundary: 18:29 UTC is still the same IST day, 18:31 UTC is the next one", () => {
    const before = istToday(new Date("2026-11-13T18:29:00Z"));
    const after = istToday(new Date("2026-11-13T18:31:00Z"));
    expect(quoteExpiryText("2026-11-13", before)).toBe("Expires today");
    expect(quoteExpiryText("2026-11-13", after)).toBe("Expired 1 day ago");
  });

  it("due text = the status chip's own words", () => {
    expect(renewalDueText(-4)).toBe("Overdue 4d");
    expect(renewalDueText(0)).toBe("Due today");
    expect(renewalDueText(12)).toBe("Due in 12d");
  });

  it("quote state words", () => {
    expect(quoteStateLabel({ status: "sent", payment_status: "none", expires_date: null, invoice_id: null }, "2026-11-13")).toBe("Sent");
    expect(quoteStateLabel({ status: "viewed", payment_status: "none", expires_date: "2026-11-01", invoice_id: null }, "2026-11-13")).toBe("Expired");
    expect(quoteStateLabel({ status: "accepted", payment_status: "partial", expires_date: null, invoice_id: null }, "2026-11-13")).toBe("Part paid");
    expect(quoteStateLabel({ status: "accepted", payment_status: "received", expires_date: null, invoice_id: null }, "2026-11-13")).toBe("Paid");
    /* invoiced is not proof of payment (R-2404) — the invoice line says paid / unpaid */
    expect(quoteStateLabel({ status: "accepted", payment_status: "invoiced", expires_date: null, invoice_id: "INV-1" }, "2026-11-13")).toBe("Invoiced");
  });

  it("days between IST dates", () => {
    expect(daysBetweenIst("2026-11-13", "2026-11-08")).toBe(-5);
    expect(daysBetweenIst("2026-11-13", "2026-11-13")).toBe(0);
    expect(daysBetweenIst("2026-12-31", "2027-01-02")).toBe(2);
    expect(quoteStateLabel({ status: "accepted", payment_status: "none", expires_date: null, invoice_id: null }, "2026-11-13")).toBe("Accepted");
  });
});

describe("R-2728 wiring — one batched read, table still fits 1280", () => {
  const page = readFileSync("src/app/(app)/renewals/page.tsx", "utf8");
  const data = readFileSync("src/app/(app)/renewals/last-docs-data.ts", "utf8");
  it("the page reads last docs ONCE for the whole listed queue (no per-row read)", () => {
    expect((page.match(/useRenewalLastDocs\(/g) ?? []).length).toBe(1);
    expect(page).toContain("useRenewalLastDocs(listed)");
    expect(data).toContain("fetchAllRowsIn");
    expect(data).not.toMatch(/\.single\(\)|\.maybeSingle\(\)/);
  });
  it("column budget still ≤ 944px", () => {
    const fixed = QUEUE_TABLE_COLS.reduce((s, c) => s + (c.width ?? 0), 0);
    expect(fixed + 2 * 140).toBeLessThanOrEqual(QUEUE_TABLE_BUDGET_PX);
  });
});
