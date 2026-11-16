// @vitest-environment jsdom
/* R-2854 (coordinator's Chrome human test on staging, 16 Nov 2026 — a 1920 window; Pardeep: "layout ki kami
   poori karo, user ko confusion na ho"): Renewals rows were 119–161px tall — Status / Last bill fixed at 92px
   while Customer / Product stretched to 518px; "₹63,855/mo" broke as "…/m" + "o"; "INV-A378-…" was cut; an
   icon-only warning pill; "Paid" three times on one row. Added by Pardeep the same day: every row shows THIS
   renewal's quote under Product & period ("Quote Q-… · Sent 3 Oct · ₹3,823" / "No renewal quote yet") and the
   Last bill column no longer names a quote. From R-2857: "1 seat", no doubled seats, no "₹92.0K".
   jsdom has no layout — the real px are measured by e2e/cards/R-2854.spec.ts. */
import { describe, it, expect, afterEach, vi } from "vitest";
import * as React from "react";
import { render, cleanup, screen } from "@testing-library/react";

vi.mock("next/link", () => ({ default: ({ href, children, ...p }: { href: string; children: React.ReactNode }) => <a href={href} {...p}>{children}</a> }));

import {
  QUEUE_FLEX_MIN_PX, QUEUE_TABLE_BUDGET_PX, QUEUE_TABLE_COLS, QUEUE_TABLE_MIN_VIEWPORT_PX, queueColCss, queueColPx, queueTableBoxPx, renewalAmount,
} from "./queue";
import { AmountTableCell, LastInvoiceCell, ProductCell, lastBillLines, seatsWords } from "./row-cells";
import { NO_RENEWAL_QUOTE, QUOTE_LINE_MONEY_FROM_PX, QUOTE_LINE_WORD_FROM_PX, RenewalQuoteLine, rowQuoteWords, rowRenewalQuote } from "./row-quote";
import { StageFlagIcon, StageFlagLine, flagWords } from "./stage-flag";
import { lastDocsBySubscription, type DocBilling, type DocQuote, type LastDocs, type LastDocsInput, type LastInvoice, type RowQuote } from "./last-docs";
import { seatsAfterPlan } from "./plan-seats";
import type { LastPaid } from "./last-paid";
import type { PaidLineWithReceipt } from "./last-paid-data";

afterEach(cleanup);

const TODAY = "2026-11-16";
const col = (key: string) => QUEUE_TABLE_COLS.find((c) => c.key === key)!;

describe("R-2854 — column widths grow with the window", () => {
  const fixedAt = (vw: number) => QUEUE_TABLE_COLS.reduce((s, c) => s + (queueColPx(c, vw) ?? 0), 0);

  it("only Product & period is flexible; at a 1260 window the 968px budget still holds (no sideways scroll on a 1280 laptop)", () => {
    expect(QUEUE_TABLE_COLS.filter((c) => c.width == null).map((c) => c.key)).toEqual(["product"]);
    expect(QUEUE_TABLE_BUDGET_PX).toBeLessThanOrEqual(968);
    expect(queueTableBoxPx(QUEUE_TABLE_MIN_VIEWPORT_PX)).toBe(QUEUE_TABLE_BUDGET_PX);
    expect(fixedAt(QUEUE_TABLE_MIN_VIEWPORT_PX) + QUEUE_FLEX_MIN_PX).toBeLessThanOrEqual(QUEUE_TABLE_BUDGET_PX);
  });

  it("at every window from 1260 to 2560 the fixed columns leave Product at least its minimum", () => {
    for (let vw = QUEUE_TABLE_MIN_VIEWPORT_PX; vw <= 2560; vw += 20) {
      expect(queueTableBoxPx(vw) - fixedAt(vw), `window ${vw}`).toBeGreaterThanOrEqual(QUEUE_FLEX_MIN_PX);
    }
  });

  it("a 1280 laptop: a full invoice number and '₹63,855/mo' fit their columns (16 mono chars ≈ 115px + 12px padding; ~80px + 12)", () => {
    expect(queueColPx(col("invoice"), 1260)!).toBeGreaterThanOrEqual(127);
    /* Status: "Hold at Google — unpaid" in two lines needs ~100px of text + 12px padding */
    expect(queueColPx(col("status"), 1260)!).toBeGreaterThanOrEqual(112);
    expect(queueColPx(col("amount"), 1260)!).toBeGreaterThanOrEqual(96);
  });

  it("a 1920 window: Status and Last bill are no longer 92px — one-line chips, the invoice number + period on one line", () => {
    expect(queueColPx(col("status"), 1920)).toBe(200);
    expect(queueColPx(col("invoice"), 1920)).toBe(260);
    expect(queueColPx(col("amount"), 1920)).toBe(128);
    /* Customer is capped, so Product (with the quote line) gets the rest: at least the quote line's ~290px */
    expect(queueColPx(col("customer"), 2560)).toBe(320);
    expect(queueTableBoxPx(1920) - fixedAt(1920)).toBeGreaterThanOrEqual(290);
  });

  it("the CSS is a clamp on the window width that draws the same line as queueColPx; fixed columns stay px", () => {
    expect(queueColCss(col("select"))).toBe("28px");
    expect(queueColCss(col("actions"))).toBe("184px");
    expect(queueColCss(col("product"))).toBeUndefined();
    const css = queueColCss(col("status"))!;
    const m = /^clamp\((\d+)px, calc\((\d+)px \+ \(100vw - (\d+)px\) \* ([\d.]+)\), (\d+)px\)$/.exec(css);
    expect(m, css).not.toBeNull();
    const at = (vw: number) => Math.min(Number(m![5]), Math.max(Number(m![1]), Number(m![2]) + (vw - Number(m![3])) * Number(m![4])));
    for (const vw of [1200, 1260, 1280, 1440, 1600, 1920, 2400]) expect(Math.abs(at(vw) - queueColPx(col("status"), vw)!)).toBeLessThan(0.5);
  });
});

describe("R-2854 — Amount: one line, never broken mid-word; the quote's total is not repeated", () => {
  it("'₹63,855/mo' is two nowrap pieces (the figure, the '/mo') — the figure can never split", () => {
    render(<AmountTableCell text="₹63,855/mo" gst="+ GST" />);
    const p = screen.getByTestId("renewal-row-amount");
    expect(p.textContent).toBe("₹63,855/mo");
    const pieces = [...p.querySelectorAll("span")];
    expect(pieces.map((s) => s.textContent)).toEqual(["₹63,855", "/mo"]);
    for (const s of pieces) expect(s.className).toContain("whitespace-nowrap");
    expect(p.className).not.toMatch(/break-words|truncate/);
    expect(document.querySelector('[data-cell="amount"]')!.textContent).toBe("₹63,855/mo+ GST");
  });

  it("from R-2857: the short quote figure is the full Indian format — '₹92,040', never '₹92.0K'", () => {
    const a = renewalAmount(
      { mrr: 6500, term_months: 12, term_amount: 78_000, billing_cycle: "yearly", renewal_quote_id: "Q-A1" },
      { id: "Q-A1", amount: 92_040, status: "sent", payment_status: "none" });
    expect(a.quoteShort).toBe("quote ₹92,040");
    expect(a.quoteShort).not.toMatch(/K/);
  });
});

describe("R-2854 (from R-2857) — seats on the Product line", () => {
  it("'1 seat' for one; nothing when the plan name already says its seats", () => {
    expect(seatsWords("Business Starter", 1)).toBe("1 seat");
    expect(seatsWords("Business Starter", 5)).toBe("5 seats");
    expect(seatsWords("Business Starter (1 seats)", 1)).toBeNull();
    /* the same rule as the card and the drawer (plan-seats.ts, R-2857) */
    expect(seatsWords).toBe(seatsAfterPlan);
    expect(seatsWords("Workspace 25 Seats pack", 25)).toBeNull();
    expect(seatsWords("Business Starter", null)).toBeNull();
  });
  it("the row prints 'Business Starter (1 seats) · Google' — not '… (1 seats) · 1 seats'", () => {
    render(<ProductCell plan="Business Starter (1 seats)" seats={1} vendor="google" term={null} termShort={null} frequency={null} />);
    expect(document.querySelector('[data-cell="product"]')!.textContent).toBe("Business Starter (1 seats) · Google");
  });
});

describe("R-2854 — Status: every flag in words, one flag line", () => {
  it("no icon-only pill: each flag has words", () => {
    for (const key of ["atRisk", "vendorHold", "priorTermUnpaid", "promiseBroken", "followUpDue", "renewalHeld"] as const) {
      cleanup();
      render(<StageFlagIcon flag={{ key, reason: "why" }} />);
      const el = document.querySelector(`[data-flag="${key}"]`)!;
      expect(el.textContent!.trim().length, key).toBeGreaterThan(3);
      expect(el.querySelector("svg")).toBeTruthy();
    }
    expect(flagWords({ key: "vendorHold", reason: "x", words: "Hold at Google — unpaid" })).toBe("Hold at Google — unpaid");
  });

  it("one line: the most pressing flag in words (the hold before 'At risk'), the rest as '+N' with their reasons", () => {
    render(<StageFlagLine flags={[
      { key: "atRisk", reason: "At risk: overdue" },
      { key: "vendorHold", reason: "Payment due — do not renew at the vendor yet", words: "Hold at Google — unpaid" },
      { key: "followUpDue", reason: "Follow-up due 12 Nov 2026" },
    ]} />);
    const line = screen.getByTestId("stage-flags");
    expect(line.querySelectorAll("[data-flag]")).toHaveLength(1);
    expect(line.querySelector("[data-flag]")!.textContent).toBe("Hold at Google — unpaid");
    const more = screen.getByTestId("stage-flags-more");
    expect(more.textContent).toBe("+2");
    expect(more.getAttribute("title")).toBe("Follow-up due 12 Nov 2026; At risk: overdue");
    expect(more.getAttribute("aria-label")).toBe("2 more: Follow-up due 12 Nov 2026; At risk: overdue");
  });

  it("the card layout (no hover on a phone) names every flag in words, no '+N'", () => {
    render(<StageFlagLine all flags={[
      { key: "atRisk", reason: "At risk: overdue" },
      { key: "vendorHold", reason: "Payment due — do not renew at the vendor yet", words: "Hold at Google — unpaid" },
    ]} />);
    expect([...screen.getByTestId("stage-flags").querySelectorAll("[data-flag]")].map((e) => e.textContent)).toEqual(["Hold at Google — unpaid", "At risk"]);
    expect(screen.queryByTestId("stage-flags-more")).toBeNull();
  });

  it("a single flag has no '+N'; no flags → nothing", () => {
    const { container } = render(<StageFlagLine flags={[{ key: "atRisk", reason: "At risk" }]} />);
    expect(screen.queryByTestId("stage-flags-more")).toBeNull();
    expect(container.textContent).toBe("At risk");
    cleanup();
    expect(render(<StageFlagLine flags={[]} />).container.innerHTML).toBe("");
  });
});

// ─── Last bill ──────────────────────────────────────────────────────────────

const inv = (over: Partial<LastInvoice> = {}): LastInvoice => ({
  id: "INV-A378-27-0046", date: "2026-10-01", status: "paid", amount: 3823, paidAmount: 3823, currency: "INR",
  dueDate: "2026-10-15", netPayable: null, adjustedAdvances: null, writtenOffAt: null, fxRate: null,
  sourceQuoteId: "Q-1", part: null, period: "Oct 2026", notes: undefined, ...over,
} as LastInvoice);
const docsOf = (invoices: LastInvoice[], over: Partial<LastDocs> = {}): LastDocs => ({ quote: null, invoice: invoices[0] ?? null, invoices, sent: null, ...over });
const payLine = (over: Partial<PaidLineWithReceipt> = {}): PaidLineWithReceipt => ({
  paymentId: "p-1", amount: 3823, method: "upi", receivedAt: "2026-10-03T06:30:00Z", invoiceId: "INV-A378-27-0046", quoteId: "Q-1", covers: 1, ...over,
});
const paidOf = (l: PaidLineWithReceipt): LastPaid => ({ last: l, history: [l] });
const cell = { loading: false, failed: false, canInvoices: true, todayIst: TODAY };
const lastBill = () => document.querySelector('[data-cell="invoice"]')!;

describe("R-2854 — Last bill: number never cut, 'Paid' once, no quote", () => {
  it("lastBillLines: Paid + a payment → the payment line alone; owed + nothing received → the state alone; else both", () => {
    expect(lastBillLines({ text: "Paid" }, { kind: "paid", text: "Paid ₹3,823 · 3 Oct" })).toEqual({ state: false, paid: true });
    expect(lastBillLines({ text: "Paid" }, { kind: "no-receipt", text: "Paid on invoice, no receipt" })).toEqual({ state: false, paid: true });
    expect(lastBillLines({ text: "Unpaid · ₹3,823" }, { kind: "none", text: "No payment yet" })).toEqual({ state: true, paid: false });
    expect(lastBillLines({ text: "Part paid · ₹700 due" }, { kind: "no-receipt", text: "Part paid on invoice, no receipt" })).toEqual({ state: true, paid: true });
    expect(lastBillLines({ text: "Unpaid · ₹3,823" }, { kind: "no-receipt", text: "Earlier bill paid, no receipt" })).toEqual({ state: true, paid: true });
    expect(lastBillLines({ text: "Cancelled" }, { kind: "paid", text: "Paid ₹3,823 · 3 Oct" })).toEqual({ state: true, paid: true });
    expect(lastBillLines({ text: "Paid" }, null)).toEqual({ state: true, paid: false });
  });

  it("AROKA: a Paid invoice with its receipt reads 'INV-… · Oct 2026' then 'Paid ₹3,823 · 3 Oct' — 'Paid' once", () => {
    render(<LastInvoiceCell {...cell} docs={docsOf([inv()])} paid={{ paid: paidOf(payLine()), loading: false, failed: false }} />);
    expect(lastBill().textContent).toBe("INV-A378-27-0046· Oct 2026Paid ₹3,823 · 3 Oct");
    expect(lastBill().textContent!.match(/Paid/g)).toHaveLength(1);
    expect(screen.queryByTestId("renewal-last-invoice-status")).toBeNull();
  });

  it("the invoice number is whole: nowrap, never shrinks, no truncate; it links to the invoice", () => {
    render(<LastInvoiceCell {...cell} docs={docsOf([inv()])} />);
    const no = screen.getByTestId("renewal-last-invoice-no");
    expect(no.textContent).toBe("INV-A378-27-0046");
    expect(no.className).toContain("whitespace-nowrap");
    expect(no.className).toContain("shrink-0");
    expect(no.className).not.toMatch(/truncate/);
    expect(no.tagName).toBe("A");
    /* without the Last paid read the invoice's own state shows */
    expect(screen.getByTestId("renewal-last-invoice-status").textContent).toBe("Paid");
  });

  it("an unpaid invoice with nothing received: its state, and no 'No payment yet' under it", () => {
    render(<LastInvoiceCell {...cell} docs={docsOf([inv({ status: "pending", paidAmount: 0, dueDate: "2026-12-01" })])} paid={{ paid: undefined, loading: false, failed: false }} />);
    expect(screen.getByTestId("renewal-last-invoice-status").textContent).toBe("Unpaid · ₹3,823");
    expect(screen.queryByTestId("renewal-row-last-paid")).toBeNull();
  });

  it("while Last paid loads, the invoice state stays and the payment line holds ('…')", () => {
    render(<LastInvoiceCell {...cell} docs={docsOf([inv()])} paid={{ paid: undefined, loading: true, failed: false }} />);
    expect(screen.getByTestId("renewal-last-invoice-status").textContent).toBe("Paid");
    expect(screen.getByTestId("renewal-row-last-paid").textContent).toBe("…");
  });

  it("no quote in Last bill — not beside an invoice (R-2841's note) and not on a row with no invoice", () => {
    const q = { id: "Q-ADD-1", date: "2026-11-10", status: "accepted", payment_status: "none", expires_date: null, invoice_id: null, part: null, period: null };
    render(<LastInvoiceCell {...cell} docs={docsOf([inv()], { quote: q })} paid={{ paid: undefined, loading: false, failed: false }} />);
    expect(lastBill().textContent).not.toMatch(/Q-ADD-1|Quote|quote/);
    cleanup();
    render(<LastInvoiceCell {...cell} docs={docsOf([], { quote: q })} paid={{ paid: undefined, loading: false, failed: false }} />);
    expect(lastBill().textContent).toBe("No invoice yetNo payment yet");
  });

  it("History sits in the same wrapping row as the cell's last line", () => {
    render(<LastInvoiceCell {...cell} docs={docsOf([inv()])} paid={{ paid: paidOf(payLine()), loading: false, failed: false }} historyButton={<button>History</button>} />);
    const paid = screen.getByTestId("renewal-row-last-paid");
    expect(paid.parentElement!.className).toContain("flex-wrap");
    expect(paid.parentElement!.textContent).toBe("Paid ₹3,823 · 3 Oct" + "History");
    cleanup();
    render(<LastInvoiceCell {...cell} docs={undefined} loading historyButton={<button>History</button>} />);
    expect(screen.getByRole("button", { name: "History" })).toBeTruthy();
  });
});

// ─── The quote line under Product & period ──────────────────────────────────

const SUB = "c2854000-0000-4000-8000-0000000000a1";
const dq = (over: Partial<DocQuote> & { id: string }): DocQuote => ({
  status: "sent", payment_status: "none", created_at: "2026-10-03T05:00:00Z", created_date: "2026-10-03",
  expires_date: null, invoice_id: null, renewal_subscription_id: null, add_seats_subscription_id: null,
  subscription_billing_id: null, superseded_by: null, amount: 3823, currency: "INR", exchange_rate: 1, ...over,
});
const bill = (over: Partial<DocBilling> & { id: string }): DocBilling => ({ subscription_id: SUB, invoice_id: null, term_start: "2026-12-07", period_index: 1, ...over });
const input = (over: Partial<LastDocsInput>): LastDocsInput => ({
  subs: [{ id: SUB, quote_id: "Q-ORIG", renewal_quote_id: null, start_date: "2025-12-07" }], quotes: [], billings: [], invoices: [], ...over,
});
const rq = (over: Partial<RowQuote> = {}): RowQuote => ({
  id: "Q-A378-27-0845", date: "2026-10-03", status: "sent", payment_status: "none", expires_date: null, invoice_id: null, amount: 3823, currency: "INR", fxRate: null, ...over,
});
const line = { loading: false, failed: false, canQuotes: true, todayIst: TODAY };

describe("R-2854 — this renewal's quote, from the same Last docs read (no query per row)", () => {
  it("the linked renewal quote is the row's quote in ANY state (a draft too); a revised-away quote is not listed", () => {
    const m = lastDocsBySubscription(input({
      subs: [{ id: SUB, quote_id: "Q-ORIG", renewal_quote_id: "Q-REN", start_date: "2025-12-07" }],
      quotes: [
        dq({ id: "Q-ORIG", status: "accepted", payment_status: "received", created_at: "2025-12-01T05:00:00Z", created_date: "2025-12-01" }),
        dq({ id: "Q-REN", status: "draft", renewal_subscription_id: SUB }),
        dq({ id: "Q-REN-OLD", status: "sent", renewal_subscription_id: SUB, superseded_by: "Q-REN" }),
      ],
    })).get(SUB)!;
    expect(m.renewalQuoteId).toBe("Q-REN");
    expect(m.linkedQuotes!.map((q) => q.id)).toEqual(["Q-REN", "Q-ORIG"]);
    expect(rowRenewalQuote(m, { quoteId: null })).toMatchObject({ id: "Q-REN", status: "draft", amount: 3823, known: true });
  });

  it("billed in parts: the renewal term's OPEN first-part proforma is the quote; a paid one from that term is not offered (it may be last year's)", () => {
    const open = lastDocsBySubscription(input({
      quotes: [dq({ id: "PI-2", status: "sent", payment_status: "awaiting", subscription_billing_id: "b1" })],
      billings: [bill({ id: "b1" })],
    })).get(SUB)!;
    expect(open.renewalQuoteId).toBe("PI-2");
    expect(rowRenewalQuote(open, null)).toMatchObject({ id: "PI-2", known: true });
    const m = lastDocsBySubscription(input({
      quotes: [
        dq({ id: "Q-ORIG", status: "accepted", payment_status: "received", created_at: "2025-12-01T05:00:00Z", created_date: "2025-12-01" }),
        dq({ id: "PI-1", status: "accepted", payment_status: "received", subscription_billing_id: "b1" }),
      ],
      billings: [bill({ id: "b1" })],
    })).get(SUB)!;
    expect(m.renewalQuoteId ?? null).toBeNull();
    expect(rowRenewalQuote(m, { quoteId: null })).toBeNull();
    /* …unless the row's stage names it (the row is waiting on that quote) */
    expect(rowQuoteWords(rowRenewalQuote(m, { quoteId: "PI-1" }) as RowQuote, TODAY).state).toBe("Paid");
  });

  it("no renewal quote and no renewal part → none (the original sale's quote is not this renewal's)", () => {
    const m = lastDocsBySubscription(input({ quotes: [dq({ id: "Q-ORIG", status: "accepted", payment_status: "received" })] })).get(SUB)!;
    expect(m.renewalQuoteId ?? null).toBeNull();
    expect(rowRenewalQuote(m, { quoteId: null })).toBeNull();
  });

  it("the quote the stage names wins (the part proforma the row waits on); a named quote the read did not return shows its number only", () => {
    const docs: LastDocs = { quote: null, invoice: null, invoices: [], sent: null, renewalQuoteId: "Q-REN", linkedQuotes: [rq({ id: "PI-9" }), rq({ id: "Q-REN" })] };
    expect(rowRenewalQuote(docs, { quoteId: "PI-9" })?.id).toBe("PI-9");
    expect(rowRenewalQuote(docs, { quoteId: "Q-GONE" })).toEqual({ id: "Q-GONE", known: false });
    expect(rowRenewalQuote(undefined, null)).toBeNull();
  });

  it("words: the quotes list's state, the quote's date (year only when not this year), its total incl. GST in its own currency", () => {
    expect(rowQuoteWords(rq(), TODAY)).toEqual({ state: "Sent", when: "3 Oct", money: "₹3,823" });
    expect(rowQuoteWords(rq({ date: "2025-12-28", status: "accepted" }), TODAY)).toMatchObject({ state: "Accepted", when: "28 Dec 25" });
    expect(rowQuoteWords(rq({ status: "draft" }), TODAY).state).toBe("Draft");
    expect(rowQuoteWords(rq({ status: "cancelled" }), TODAY).state).toBe("Cancelled");
    expect(rowQuoteWords(rq({ payment_status: "received", status: "accepted" }), TODAY).state).toBe("Paid");
    expect(rowQuoteWords(rq({ expires_date: "2026-11-01" }), TODAY).state).toBe("Expired");
    expect(rowQuoteWords(rq({ amount: 96000, currency: "USD", fxRate: 80 }), TODAY).money).toBe("$1,200");
    expect(rowQuoteWords(rq({ amount: null }), TODAY).money).toBeNull();
  });

  it("only 'Sent' reads with the date as one phrase; another state is followed by the quote's date after a dot", () => {
    const paid: LastDocs = { quote: null, invoice: null, invoices: [], sent: null, renewalQuoteId: "Q-P", linkedQuotes: [rq({ id: "Q-P", status: "accepted", payment_status: "received" })] };
    render(<RenewalQuoteLine {...line} docs={paid} stage={null} />);
    expect(screen.getByTestId("renewal-row-quote-state").textContent).toBe("· Paid · 3 Oct");
  });
});

describe("R-2854 — RenewalQuoteLine (every row, under Product & period)", () => {
  const docs: LastDocs = { quote: null, invoice: null, invoices: [], sent: null, renewalQuoteId: "Q-A378-27-0845", linkedQuotes: [rq()] };

  it("a quote exists: 'Quote Q-A378-27-0845 · Sent 3 Oct · ₹3,823' — the number opens the quote and never breaks", () => {
    render(<RenewalQuoteLine {...line} docs={docs} stage={{ quoteId: null }} />);
    const el = screen.getByTestId("renewal-row-quote");
    expect(el.textContent).toBe("Quote Q-A378-27-0845· Sent 3 Oct· ₹3,823");
    expect(el.getAttribute("data-quote")).toBe("Q-A378-27-0845");
    const link = screen.getByRole("link", { name: "Quote Q-A378-27-0845" });
    expect(link.textContent).toBe("Q-A378-27-0845");
    expect(link.getAttribute("href")).toBe("/quotes/Q-A378-27-0845");
    for (const piece of [...el.children]) expect(piece.className).toContain("whitespace-nowrap");
    /* a 1280 laptop: the short form "Q-… · Sent 3 Oct" (one line) — the word "Quote" and the total show from a 1440 window */
    expect([QUOTE_LINE_WORD_FROM_PX, QUOTE_LINE_MONEY_FROM_PX]).toEqual([1440, 1680]);
    expect(el.querySelector("span > span")!.className).toBe(`hidden min-[${QUOTE_LINE_WORD_FROM_PX}px]:inline`);
    expect(screen.getByTestId("renewal-row-quote-money").className).toBe(`hidden whitespace-nowrap min-[${QUOTE_LINE_MONEY_FROM_PX}px]:inline`);
    expect(el.getAttribute("title")).toBe("Quote Q-A378-27-0845 · Sent · dated 3 Oct · ₹3,823 incl. GST");
    expect(el.className).not.toMatch(/truncate|line-clamp/);
  });

  it("none: 'No renewal quote yet', muted", () => {
    render(<RenewalQuoteLine {...line} docs={{ quote: null, invoice: null, invoices: [], sent: null }} stage={{ quoteId: null }} />);
    const el = screen.getByTestId("renewal-row-quote");
    expect(el.textContent).toBe(NO_RENEWAL_QUOTE);
    expect(el.textContent).toBe("No renewal quote yet");
    expect(el.className).toContain("text-ink-3");
    expect(el.getAttribute("data-quote")).toBe("none");
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("no quotes permission: the number without a link", () => {
    render(<RenewalQuoteLine {...line} canQuotes={false} docs={docs} stage={null} />);
    expect(screen.getByTestId("renewal-row-quote").textContent).toContain("Q-A378-27-0845");
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("still loading: it holds the line — never a false 'No renewal quote yet'; a failed read says so", () => {
    render(<RenewalQuoteLine {...line} loading docs={undefined} stage={null} />);
    expect(screen.getByTestId("renewal-row-quote").textContent).toBe("…");
    cleanup();
    render(<RenewalQuoteLine {...line} failed docs={undefined} stage={null} />);
    expect(screen.getByTestId("renewal-row-quote").textContent).toMatch(/couldn.t load/);
    expect(screen.queryByText(NO_RENEWAL_QUOTE)).toBeNull();
  });

  it("the Product cell prints it as its last line", () => {
    render(<ProductCell plan="Business Starter" seats={10} vendor="google" term={null} termShort="1 Dec 26 – 30 Nov 27" frequency={null}
      quoteLine={<RenewalQuoteLine {...line} docs={docs} stage={null} />} />);
    const cellEl = document.querySelector('[data-cell="product"]')!;
    expect(cellEl.lastElementChild).toBe(screen.getByTestId("renewal-row-quote"));
  });
});
