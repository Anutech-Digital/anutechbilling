// @vitest-environment jsdom
/* R-2866 (Pardeep 16 Nov 2026, staging screenshot — Ravi Shankar, Q-A378-27-0124): "quotation ka pop up window
   khulna chahiye" — the Renewals row's quote number opened /quotes/<id> and the user lost the list. Now a click
   opens a quote pop-up over Renewals; added the same day: hovering (or keyboard-focusing) the number lists EVERY
   product line of that quote with its subscription period — "Google Workspace Business Starter · 473 seats ·
   1 Oct–31 Oct 2026", a Bill together quote one line per subscription, at most 6 then "+N more". */
import { describe, it, expect, afterEach, vi } from "vitest";
import * as React from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, cleanup, screen, fireEvent, within, waitFor } from "@testing-library/react";

const st = vi.hoisted(() => ({
  quote: undefined as Record<string, unknown> | null | undefined,
  payments: undefined as Array<Record<string, unknown>> | undefined,
  partFacts: undefined as Map<string, unknown> | undefined,
  partDue: null as { dueOn: string | null; mailStep: string | null } | null,
  parties: undefined as unknown,
  linesRefs: [] as unknown[],
  lines: undefined as Map<string, unknown> | undefined,
  linesPlaceholder: false,
  linesError: false,
  payDialog: [] as Array<{ quoteId: string | null; open: boolean }>,
  copied: [] as string[],
}));
vi.mock("next/link", () => ({ default: ({ href, children, ...p }: { href: string; children: React.ReactNode }) => <a href={href} {...p}>{children}</a> }));
vi.mock("@/lib/queries/quotes", () => ({ useQuote: (id: string | undefined) => ({ data: id ? st.quote : undefined, isLoading: false, isError: false }) }));
vi.mock("@/lib/queries/payments", async (orig) => ({ ...(await orig<typeof import("@/lib/queries/payments")>()), usePaymentsByQuote: () => ({ data: st.payments }) }));
vi.mock("@/lib/queries/quote-copy-parties", () => ({ useQuoteCopyParties: () => ({ data: st.parties }) }));
vi.mock("@/lib/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ data: { role: "owner", tenantStateCode: "07", tenantGstin: null } }) }));
vi.mock("@/lib/quotes/quote-kind-facts", () => ({ usePartFacts: () => ({ data: st.partFacts }) }));
vi.mock("@/lib/billing/use-part-due", () => ({ usePartDueOn: () => ({ data: st.partDue }) }));
vi.mock("@/app/(app)/payments/record-quote-payment", () => ({
  RecordQuotePaymentDialog: (p: { quoteId: string | null; open: boolean }) => { st.payDialog.push({ quoteId: p.quoteId, open: p.open }); return p.open ? <div data-testid="record-payment-dialog">{p.quoteId}</div> : null; },
}));
vi.mock("@/components/features/quotes/failed-send-toast", () => ({ copyCustomerLink: (link: string) => { st.copied.push(link); } }));
vi.mock("./quote-peek-data", () => ({ useRowQuoteLines: (refs: unknown[]) => { st.linesRefs = refs; return { data: st.lines, isPlaceholderData: st.linesPlaceholder, isError: st.linesError }; } }));

import { HOVER_MAX_LINES, dayRange, hoverLines, peekLineDetail, peekLineText, peekLines, peekNeeds, peekPeriod, peekTotals, type PeekBilling, type PeekLine, type PeekQuoteRow, type PeekSub } from "./quote-peek";
import { RenewalQuoteLine } from "./row-quote";
import { DRAFT_LINK_NOTE, LINES_FAILED_TEXT, QuotePeekDialog, useRowQuotePeek } from "./quote-peek-dialog";
import type { LastDocs, RowQuote } from "./last-docs";

afterEach(() => { cleanup(); st.quote = undefined; st.payments = undefined; st.partFacts = undefined; st.partDue = null; st.parties = undefined; st.lines = undefined; st.linesPlaceholder = false; st.linesError = false; st.payDialog = []; st.copied = []; });

const TODAY = "2026-11-16";
const QID = "Q-A378-27-0124";
const STARTER = "Google Workspace Business Starter";

const pq = (over: Partial<PeekQuoteRow> = {}): PeekQuoteRow => ({
  id: QID, line_items: [], is_renewal: null, is_extension: null, is_add_seats: null, is_one_off: null, extension_months: null,
  renewal_term_date: null, created_date: "2026-10-30", domain: null, subscription_billing_id: null, renewal_subscription_id: null, ...over,
});
const billing = (id: string, sub: string, start: string, end: string): PeekBilling => ({ id, subscription_id: sub, period_start: start, period_end: end });
const none = new Map<string, never>();

describe("R-2866 — a quote's product lines with their periods (quote-peek.ts)", () => {
  it("the owner's example: a monthly part proforma → 'Google Workspace Business Starter · 473 seats · 1 Oct–31 Oct 2026'", () => {
    const q = pq({ subscription_billing_id: "B1", line_items: [{ name: STARTER, qty: 473, commitment: "annual_monthly", billing_id: "B1" }] });
    const lines = peekLines(q, new Map([["B1", billing("B1", "S1", "2026-10-01", "2026-11-01")]]), none);
    expect(lines.map(peekLineText)).toEqual([`${STARTER} · 473 seats · 1 Oct–31 Oct 2026`]);
    expect(peekPeriod(lines)).toBe("1 Oct–31 Oct 2026");
  });

  it("review: a REAL part request line (R-2423 name, one_time + per_seat) says its seats and period ONCE — nothing is added after the name", () => {
    const named = `${STARTER} · ravi.in · 473 seats · 1 Oct–31 Oct 2026 (part 1 of 12)`;
    const q = pq({ subscription_billing_id: "B1", line_items: [{ name: named, qty: 473, rate: 5, per_seat: true, one_time: true, period_start: "2026-10-01", period_end: "2026-10-31", billing_id: "B1" }] });
    const lines = peekLines(q, new Map([["B1", billing("B1", "S1", "2026-10-01", "2026-11-01")]]), new Map<string, PeekSub>([["S1", { id: "S1", domain: "ravi.in" }]]));
    expect(lines.map(peekLineText)).toEqual([named]);
    expect(peekLineDetail(lines[0])).toBe("₹5 a seat");                // the domain, seats and period are all in the name; R-2922 adds only the rate a seat
    expect(peekLineDetail({ ...lines[0], seatRate: null })).toBeNull();   // no rate stored → nothing is added after the name
    expect(peekPeriod(lines)).toBe("1 Oct–31 Oct 2026");               // the pop-up's overall period still knows it
    /* an older part request (short name): per_seat's qty IS the seats, the part's period is added */
    const old = pq({ subscription_billing_id: "B1", line_items: [{ name: STARTER, qty: 473, per_seat: true, one_time: true }] });
    const oldLines = peekLines(old, new Map([["B1", billing("B1", "S1", "2026-10-01", "2026-11-01")]]), new Map<string, PeekSub>([["S1", { id: "S1", domain: "ravi.in" }]]));
    expect(oldLines.map(peekLineText)).toEqual([`${STARTER} · 473 seats · 1 Oct–31 Oct 2026`]);
    expect(peekLineDetail(oldLines[0])).toBe("473 seats · ravi.in · 1 Oct–31 Oct 2026");
    /* a lump-sum part line (not per seat, qty 1) is not "1 seat" */
    const lump = pq({ subscription_billing_id: "B1", line_items: [{ name: STARTER, qty: 1, per_seat: false, one_time: true }] });
    expect(peekLines(lump, new Map([["B1", billing("B1", "S1", "2026-10-01", "2026-11-01")]]), none).map(peekLineText)).toEqual([`${STARTER} · 1 Oct–31 Oct 2026`]);
  });

  it("review: a plan name that already carries a seat count gets no second one (R-2857's rule)", () => {
    const sub: PeekSub = { id: "S1", start_date: "2025-11-01", term_months: 12 };
    const q = pq({ is_renewal: true, extension_months: 12, renewal_term_date: "2026-11-01", renewal_subscription_id: "S1", line_items: [{ name: `${STARTER} (5 seats)`, qty: 5, commitment: "annual_yearly" }] });
    expect(peekLines(q, none, none, sub).map(peekLineText)).toEqual([`${STARTER} (5 seats) · 1 Nov 2026–31 Oct 2027`]);
  });

  it("a Bill together proforma: one line per subscription, each with ITS part's period (a line without billing_id = the lead part)", () => {
    const q = pq({ subscription_billing_id: "BA", line_items: [
      { name: "Google Workspace Business Standard", qty: 12, commitment: "annual_monthly" },
      { name: STARTER, qty: 1, commitment: "annual_monthly", billing_id: "BB" },
    ] });
    const lines = peekLines(q, new Map([["BA", billing("BA", "SA", "2026-10-01", "2026-11-01")], ["BB", billing("BB", "SB", "2026-10-15", "2026-11-15")]]),
      new Map<string, PeekSub>([["SB", { id: "SB", domain: "beta.in" }]]));
    expect(lines.map(peekLineText)).toEqual([
      "Google Workspace Business Standard · 12 seats · 1 Oct–31 Oct 2026",
      `${STARTER} · 1 seat · 15 Oct–14 Nov 2026`,
    ]);
    expect(lines[1].domain).toBe("beta.in");
    expect(peekPeriod(lines)).toBe("1 Oct–14 Nov 2026");
  });

  it("a renewal quote: the quote paper's own period (lineServicePeriod) — the next term starts ON the renewal date of an app-made subscription", () => {
    const q = pq({ is_renewal: true, extension_months: 12, renewal_term_date: "2026-11-01", line_items: [{ name: STARTER, qty: 5, commitment: "annual_yearly" }] });
    const sub: PeekSub = { id: "S1", start_date: "2025-11-01", term_months: 12 };
    expect(peekLines(q, none, none, sub).map(peekLineText)).toEqual([`${STARTER} · 5 seats · 1 Nov 2026–31 Oct 2027`]);
    /* the quote names its subscription → the read's row wins over the row's own */
    expect(peekLines({ ...q, renewal_subscription_id: "S1" }, none, new Map([["S1", sub]])).map((l) => l.period)).toEqual(["1 Nov 2026–31 Oct 2027"]);
  });

  it("a together RENEWAL quote: each line its own subscription's term", () => {
    const q = pq({ is_renewal: true, extension_months: 12, line_items: [
      { name: "Plan A", qty: 3, commitment: "annual_yearly", subscription_id: "SA", renewal_term_date: "2026-11-01" },
      { name: "Plan B", qty: 2, commitment: "annual_yearly", subscription_id: "SB", renewal_term_date: "2026-12-10" },
    ] });
    const subs = new Map<string, PeekSub>([["SA", { id: "SA", start_date: "2025-11-01", term_months: 12 }], ["SB", { id: "SB", start_date: "2025-12-10", term_months: 12 }]]);
    expect(peekLines(q, none, subs).map(peekLineText)).toEqual(["Plan A · 3 seats · 1 Nov 2026–31 Oct 2027", "Plan B · 2 seats · 10 Dec 2026–9 Dec 2027"]);
  });

  it("never a guessed period: a one-time line, a renewal with no term date and a part that was not read show none", () => {
    expect(peekLineText(peekLines(pq({ line_items: [{ name: "Migration", qty: 1, one_time: true }] }), none, none)[0])).toBe("Migration");
    expect(peekLines(pq({ is_renewal: true, extension_months: 12, line_items: [{ name: STARTER, qty: 2, commitment: "annual_yearly" }] }), none, none)[0].period).toBeNull();
    expect(peekLines(pq({ subscription_billing_id: "B9", line_items: [{ name: STARTER, qty: 2, commitment: "annual_monthly", start_date: "2026-01-01" }] }), none, none)[0].period).toBeNull();
    /* odd stored lines never throw */
    for (const li of [null, "x", [null, 3, {}]]) expect(() => peekLines(pq({ line_items: li as never }), none, none)).not.toThrow();
    expect(peekLines(pq({ line_items: [{}] }), none, none)[0].name).toBe("Item");
  });

  it("at most 6 lines, then '+N more'; the day range adds the first year only across a year end", () => {
    const many = Array.from({ length: 9 }, (_, n): PeekLine => ({ name: `Plan ${n + 1}`, seats: "1 seat", period: null, from: null, to: null, domain: null }));
    expect(HOVER_MAX_LINES).toBe(6);
    expect(hoverLines(many)).toEqual({ shown: ["Plan 1 · 1 seat", "Plan 2 · 1 seat", "Plan 3 · 1 seat", "Plan 4 · 1 seat", "Plan 5 · 1 seat", "Plan 6 · 1 seat"], more: 3 });
    expect(hoverLines(many.slice(0, 6)).more).toBe(0);
    expect(dayRange("2026-10-01", "2026-10-31")).toBe("1 Oct–31 Oct 2026");
    expect(dayRange("2026-11-01", "2027-10-31")).toBe("1 Nov 2026–31 Oct 2027");
  });

  it("the second round of the read asks only for the parts and subscriptions the lines name", () => {
    expect(peekNeeds([
      pq({ subscription_billing_id: "BA", line_items: [{ billing_id: "BB" }, { billing_id: "BA" }, null] }),
      pq({ id: "Q2", renewal_subscription_id: "S9", line_items: [{ subscription_id: "S2" }] }),
      pq({ id: "Q3", line_items: "bad" }),
    ])).toEqual({ billingIds: ["BA", "BB"], subIds: ["S2", "S9"] });
  });

  it("totals come from the quote's stored figures: the stored amount is the total incl. GST", () => {
    expect(peekTotals({ subtotal: 1000, discount_pct: 10, tax_rate: 18, amount: 1062 })).toEqual({ subtotal: 1000, discount: 100, taxable: 900, gst: 162, gstRate: 18, total: 1062 });
    expect(peekTotals({ subtotal: 1000, discount_pct: 0, tax_rate: 18, amount: null })).toMatchObject({ gst: 180, total: 1180 });
    expect(peekTotals({ subtotal: 500, discount_pct: 0, tax_rate: 0, amount: 500 })).toMatchObject({ gst: 0, total: 500 });
    /* review: the quote page's GST rule (quoteDisplayTax) — a stored total that is not taxable + GST shows the WORKED GST, the mismatch stays visible */
    expect(peekTotals({ subtotal: 1000, discount_pct: 0, tax_rate: 18, amount: 1300 })).toMatchObject({ gst: 180, total: 1300 });
    expect(peekTotals({ subtotal: 1000, discount_pct: 0, tax_rate: 0, amount: 1050 })).toMatchObject({ gst: 0, total: 1050 });
    expect(peekTotals({ subtotal: 1000, discount_pct: 0, tax_rate: 18, amount: 1181 })).toMatchObject({ gst: 181, total: 1181 });   // ₹1 rounding = the stored figure
  });
});

const rq = (over: Partial<RowQuote> = {}): RowQuote => ({ id: QID, date: "2026-10-30", status: "sent", payment_status: "awaiting", expires_date: null, invoice_id: null, amount: 3823, currency: "INR", fxRate: null, ...over });
const docs: LastDocs = { quote: null, invoice: null, invoices: [], sent: null, renewalQuoteId: QID, linkedQuotes: [rq()] };
const base = { docs, stage: { quoteId: null }, loading: false, failed: false, canQuotes: true, todayIst: TODAY };
const pl = (name: string, seats: string | null, period: string | null): PeekLine => ({ name, seats, period, from: null, to: null, domain: null });
/* Radix draws the tooltip's words twice (the bubble + a hidden copy for screen readers) — read the first */
const hoverCard = () => screen.getAllByTestId("renewal-row-quote-hover")[0];

describe("R-2866 — the row's quote number: hover card + click opens the pop-up (row-quote.tsx)", () => {
  it("keyboard focus on the number shows the app tooltip with the quote's ONE line and its period (not a title attribute)", () => {
    render(<RenewalQuoteLine {...base} lines={() => [pl(STARTER, "473 seats", "1 Oct–31 Oct 2026")]} onPeek={() => {}} />);
    const link = screen.getByRole("link", { name: `Quote ${QID}` });
    expect(screen.queryByTestId("renewal-row-quote-hover")).toBeNull();
    fireEvent.focus(link);
    expect(screen.getByRole("tooltip")).toBeTruthy();
    const card = hoverCard();
    expect(within(card).getAllByTestId("renewal-row-quote-hover-line").map((l) => l.textContent)).toEqual([`${STARTER} · 473 seats · 1 Oct–31 Oct 2026`]);
    expect(card.textContent).toContain(`Quote ${QID} · Sent · dated 30 Oct · ₹3,823 incl. GST`);
    expect(within(card).queryByTestId("renewal-row-quote-hover-more")).toBeNull();
    /* the number itself carries no native title (an empty one stops the line's title showing as a second bubble) */
    expect(link.getAttribute("title")).toBe("");
    expect(link.getAttribute("aria-haspopup")).toBe("dialog");
  });

  it("a Bill together quote: one line per subscription", () => {
    render(<RenewalQuoteLine {...base} lines={() => [pl("Google Workspace Business Standard", "12 seats", "1 Oct–31 Oct 2026"), pl(STARTER, "1 seat", "15 Oct–14 Nov 2026")]} onPeek={() => {}} />);
    fireEvent.focus(screen.getByRole("link", { name: `Quote ${QID}` }));
    expect(within(hoverCard()).getAllByTestId("renewal-row-quote-hover-line").map((l) => l.textContent)).toEqual([
      "Google Workspace Business Standard · 12 seats · 1 Oct–31 Oct 2026",
      `${STARTER} · 1 seat · 15 Oct–14 Nov 2026`,
    ]);
  });

  it("more than 6 lines: 6 shown, then '+N more'", () => {
    render(<RenewalQuoteLine {...base} lines={() => Array.from({ length: 8 }, (_, n) => pl(`Plan ${n + 1}`, "2 seats", "Oct 2026"))} onPeek={() => {}} />);
    fireEvent.focus(screen.getByRole("link", { name: `Quote ${QID}` }));
    expect(within(hoverCard()).getAllByTestId("renewal-row-quote-hover-line")).toHaveLength(6);
    expect(within(hoverCard()).getByTestId("renewal-row-quote-hover-more").textContent).toBe("+2 more");
  });

  it("lines not read yet → 'Loading products…'; read with none → says so (never an empty box)", () => {
    const { unmount } = render(<RenewalQuoteLine {...base} lines={() => undefined} onPeek={() => {}} />);
    fireEvent.focus(screen.getByRole("link", { name: `Quote ${QID}` }));
    expect(hoverCard().textContent).toContain("Loading products…");
    unmount();
    render(<RenewalQuoteLine {...base} lines={() => []} onPeek={() => {}} />);
    fireEvent.focus(screen.getByRole("link", { name: `Quote ${QID}` }));
    expect(hoverCard().textContent).toContain("No product lines on this quote");
  });

  it("review: the lines read FAILED → the hover says so (never 'Loading products…' for ever)", () => {
    render(<RenewalQuoteLine {...base} lines={() => undefined} linesFailed onPeek={() => {}} />);
    fireEvent.focus(screen.getByRole("link", { name: `Quote ${QID}` }));
    expect(hoverCard().textContent).toContain("Products couldn't load — reload the page");
    expect(hoverCard().textContent).not.toContain("Loading products");
  });

  it("a plain click opens the pop-up and does NOT leave the page; Ctrl / middle click keep the link (new tab)", () => {
    const onPeek = vi.fn();
    render(<RenewalQuoteLine {...base} lines={() => []} onPeek={onPeek} />);
    const link = screen.getByRole("link", { name: `Quote ${QID}` });
    expect(link.getAttribute("href")).toBe(`/quotes/${QID}`);
    expect(fireEvent.click(link)).toBe(false);            // default prevented → no navigation
    expect(onPeek).toHaveBeenCalledWith(QID);
    expect(fireEvent.click(link, { ctrlKey: true })).toBe(true);
    expect(fireEvent.click(link, { button: 1 })).toBe(true);
    expect(onPeek).toHaveBeenCalledTimes(1);
  });

  it("a role that cannot open quotes: plain number — no link, no pop-up, no tooltip", () => {
    render(<RenewalQuoteLine {...base} canQuotes={false} lines={() => []} onPeek={() => {}} />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByTestId("renewal-row-quote").textContent).toContain(QID);
  });
});

const fullQuote = (over: Record<string, unknown> = {}) => ({
  id: QID, customer_name: "Ravi Shankar", status: "sent", payment_status: "awaiting", expires_date: "2026-11-20", invoice_id: null, superseded_by: null,
  created_date: "2026-10-30", subtotal: 3240, discount_pct: 0, tax_rate: 18, amount: 3823, currency: "INR", exchange_rate: null,
  is_renewal: true, is_add_seats: false, is_extension: false, is_one_off: false, extension_months: 12, renewal_subscription_id: "S1",
  subscription_billing_id: null, line_items: [{ name: STARTER, qty: 473, commitment: "annual_monthly" }],
  customer_id: "C1", lead_id: null, public_token: "tok 1", approval_status: null, approval_tier: null, approval_requested_by: null, approved_by: null,
  approved_discount_bps: null, approved_margin_bps: null, approval_rejection_reason: null, ...over,
});
const LINES = [pl(STARTER, "473 seats", "1 Oct–31 Oct 2026")].map((l) => ({ ...l, from: "2026-10-01", to: "2026-10-31" }));

describe("R-2866 — the quote pop-up (quote-peek-dialog.tsx)", () => {
  it("shows number, customer, type, status + valid till, period, lines, totals incl. GST and 'no payment yet'", () => {
    st.quote = fullQuote(); st.payments = [];
    render(<QuotePeekDialog quoteId={QID} onClose={() => {}} lines={LINES} todayIst={TODAY} />);
    const dlg = screen.getByRole("dialog", { name: `Quote ${QID}` });
    expect(dlg.textContent).toContain("Ravi Shankar");
    expect(screen.getByTestId("quote-peek-type").textContent).toBe("Renewal");
    expect(screen.getByTestId("quote-peek-status").textContent).toBe("Sent · Valid till 20 Nov 2026");
    expect(screen.getByTestId("quote-peek-period").textContent).toBe("1 Oct–31 Oct 2026");
    expect(screen.getAllByTestId("quote-peek-line")).toHaveLength(1);
    expect(screen.getByTestId("quote-peek-lines").textContent).toContain(`${STARTER} · 473 seats · 1 Oct–31 Oct 2026`);
    expect(screen.getByTestId("quote-peek-gst").textContent).toBe("₹583");
    expect(screen.getByTestId("quote-peek-total").textContent).toBe("₹3,823");
    expect(screen.getByTestId("quote-peek-no-payments")).toBeTruthy();
    expect(screen.getByTestId("quote-peek-received").textContent).toBe("Received ₹0 of ₹3,823 · ₹3,823 still due");
  });

  it("R-2922: a line reads like a renewal quotation's — seats × the rate a seat under the product (exact ₹; a foreign quote in its own currency)", () => {
    st.quote = fullQuote(); st.payments = [];
    const { unmount } = render(<QuotePeekDialog quoteId={QID} onClose={() => {}} lines={[{ ...LINES[0], seatRate: 103.5 }]} todayIst={TODAY} />);
    expect(screen.getByTestId("quote-peek-line-detail").textContent).toBe("473 seats × ₹103.50 · 1 Oct–31 Oct 2026");
    unmount();
    st.quote = fullQuote({ currency: "USD", exchange_rate: 90 });
    render(<QuotePeekDialog quoteId={QID} onClose={() => {}} lines={[{ ...LINES[0], seatRate: 450 }]} todayIst={TODAY} />);
    expect(screen.getByTestId("quote-peek-line-detail").textContent).toBe("473 seats × $5 · 1 Oct–31 Oct 2026");
  });

  it("a part proforma: 'Renewal · Part 1 of 1 · Oct 2026' and its pay-by date; payments so far are listed", () => {
    st.quote = fullQuote({ subscription_billing_id: "B1", is_renewal: false, renewal_subscription_id: null, payment_status: "partial" });
    st.partFacts = new Map([["B1", { facts: { periodIndex: 1, periodStart: "2026-10-01", periodEnd: "2026-11-01", termStart: "2026-10-01", subStartDate: "2025-10-01", firstTermStart: null, subQuoteId: null, billingCycle: "monthly", termMonths: 1 } }]]);
    st.partDue = { dueOn: "2026-10-05", mailStep: null };
    st.payments = [{ id: "P1", amount: 1000, status: "received", method: "upi", received_at: "2026-11-02T10:00:00Z" }, { id: "P2", amount: 500, status: "refunded", method: "upi", received_at: "2026-11-03T10:00:00Z" }];
    render(<QuotePeekDialog quoteId={QID} onClose={() => {}} lines={LINES} todayIst={TODAY} />);
    expect(screen.getByTestId("quote-peek-type").textContent).toBe("Renewal · Part 1 of 1 · Oct 2026");
    expect(screen.getByTestId("quote-peek-status").textContent).toBe("Part paid · Pay by 5 Oct 2026");
    expect(screen.getByTestId("quote-peek-payments").children).toHaveLength(1);        // the refunded one is not money in
    expect(screen.getByTestId("quote-peek-payments").textContent).toContain("₹1,000");
    expect(screen.getByTestId("quote-peek-received").textContent).toBe("Received ₹1,000 of ₹3,823 · ₹2,823 still due");
  });

  it("Open full quote goes to the quote's page; Send on WhatsApp opens the quote page's own WhatsApp step (nothing is sent here)", () => {
    st.quote = fullQuote(); st.payments = [];
    render(<QuotePeekDialog quoteId={QID} onClose={() => {}} lines={LINES} todayIst={TODAY} />);
    expect(screen.getByRole("link", { name: "Open full quote" }).getAttribute("href")).toBe(`/quotes/${QID}`);
    expect(screen.getByRole("link", { name: "Send on WhatsApp" }).getAttribute("href")).toBe(`/quotes/${QID}?send=whatsapp`);
  });

  it("Copy customer link copies the accept link of a SENT quote; a draft's is off (its link opens nothing — no silent 'mark sent' here)", () => {
    st.quote = fullQuote(); st.payments = [];
    const { unmount } = render(<QuotePeekDialog quoteId={QID} onClose={() => {}} lines={LINES} todayIst={TODAY} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy customer link" }));
    expect(st.copied).toEqual([`${window.location.origin}/quote/${QID}/accept?t=tok%201`]);
    unmount();
    st.quote = fullQuote({ status: "draft" });
    render(<QuotePeekDialog quoteId={QID} onClose={() => {}} lines={LINES} todayIst={TODAY} />);
    const copy = screen.getByRole("button", { name: "Copy customer link" }) as HTMLButtonElement;
    expect(copy.disabled).toBe(true);
    fireEvent.click(copy);
    expect(st.copied).toHaveLength(1);
  });

  it("a quote waiting for approval: both customer copies are locked, with the gate's own reason", () => {
    st.quote = fullQuote({ approval_status: "pending", approval_tier: "owner" }); st.payments = [];
    render(<QuotePeekDialog quoteId={QID} onClose={() => {}} lines={LINES} todayIst={TODAY} />);
    expect((screen.getByRole("button", { name: "Copy customer link" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Send on WhatsApp" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("link", { name: "Send on WhatsApp" })).toBeNull();
  });

  it("review: a locked customer copy says WHY in words (not only a disabled button's title); a draft says where to send it", () => {
    st.quote = fullQuote({ approval_status: "pending", approval_tier: "owner" }); st.payments = [];
    const { unmount } = render(<QuotePeekDialog quoteId={QID} onClose={() => {}} lines={LINES} todayIst={TODAY} />);
    expect(screen.getByTestId("quote-peek-share-note").textContent).toContain("Customer link and WhatsApp are locked — this quote needs approval first");
    unmount();
    st.quote = fullQuote({ status: "draft" });
    const second = render(<QuotePeekDialog quoteId={QID} onClose={() => {}} lines={LINES} todayIst={TODAY} />);
    /* a draft: either the gate still wants its approval, or (approved) the link opens nothing yet — said in words both ways */
    expect(screen.getByTestId("quote-peek-share-note").textContent).toMatch(new RegExp(`^(${DRAFT_LINK_NOTE.replace(/[.]/g, "\.")}|Customer link and WhatsApp are locked — .+)$`));
    second.unmount();
    st.quote = fullQuote();
    render(<QuotePeekDialog quoteId={QID} onClose={() => {}} lines={LINES} todayIst={TODAY} />);
    expect(screen.queryByTestId("quote-peek-share-note")).toBeNull();                 // nothing locked → no note
  });

  it("review: a below-cost quote waiting for the owner offers NO Record payment (the server refuses that money — the quote page's gate)", () => {
    st.quote = fullQuote({ below_cost: true, approval_status: "pending", approval_tier: "owner" }); st.payments = [];
    render(<QuotePeekDialog quoteId={QID} onClose={() => {}} lines={LINES} todayIst={TODAY} />);
    expect(screen.queryByTestId("quote-peek-record-payment")).toBeNull();
    expect(screen.getByRole("link", { name: "Open full quote" })).toBeTruthy();
  });

  it("review: a quote past its validity reads 'Expired' and offers no customer link / WhatsApp (closed for sending, as on the quote page)", () => {
    st.quote = fullQuote({ expires_date: "2026-11-10" }); st.payments = [];
    render(<QuotePeekDialog quoteId={QID} onClose={() => {}} lines={LINES} todayIst={TODAY} />);
    expect(screen.getByTestId("quote-peek-status").textContent).toBe("Expired · Valid till 10 Nov 2026");
    expect(screen.queryByRole("button", { name: "Copy customer link" })).toBeNull();
    expect(screen.queryByText("Send on WhatsApp")).toBeNull();
  });

  it("review: an unpaid part request past its pay-by date is never 'Expired' — the quote page's words (R-2846)", () => {
    st.quote = fullQuote({ subscription_billing_id: "B1", is_renewal: false, renewal_subscription_id: null, expires_date: "2026-11-10" }); st.payments = [];
    st.partDue = { dueOn: "2026-10-05", mailStep: null };
    const { unmount } = render(<QuotePeekDialog quoteId={QID} onClose={() => {}} lines={LINES} todayIst={TODAY} />);
    expect(screen.getByTestId("quote-peek-status").textContent).toBe("Pay-by date passed — still payable · Pay by 5 Oct 2026");
    expect(screen.getByTestId("quote-peek-record-payment")).toBeTruthy();             // still payable
    unmount();
    st.quote = fullQuote({ cancelled_at: "2026-11-01T00:00:00Z" });
    render(<QuotePeekDialog quoteId={QID} onClose={() => {}} lines={LINES} todayIst={TODAY} />);
    expect(screen.getByTestId("quote-peek-status").textContent).toContain("Cancelled");
  });

  it("review: the lines read failed → the pop-up says so in words (no skeleton for ever)", () => {
    st.quote = fullQuote(); st.payments = [];
    render(<QuotePeekDialog quoteId={QID} onClose={() => {}} lines={undefined} linesFailed todayIst={TODAY} />);
    expect(screen.getByTestId("quote-peek-lines-failed").textContent).toBe(LINES_FAILED_TEXT);
    expect(screen.getByTestId("quote-peek-total").textContent).toBe("₹3,823");        // the quote's own facts still show
  });

  it("Record payment opens the SAME record-payment dialog for this quote and closes the pop-up (one layer)", () => {
    st.quote = fullQuote(); st.payments = [];
    const onClose = vi.fn();
    render(<QuotePeekDialog quoteId={QID} onClose={onClose} lines={LINES} todayIst={TODAY} />);
    expect(screen.queryByTestId("record-payment-dialog")).toBeNull();
    fireEvent.click(screen.getByTestId("quote-peek-record-payment"));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("record-payment-dialog").textContent).toBe(QID);
  });

  it("a paid / closed quote offers no Record payment and no send — only Open full quote", () => {
    st.quote = fullQuote({ status: "accepted", payment_status: "received" }); st.payments = [{ id: "P1", amount: 3823, status: "received", method: "upi", received_at: "2026-11-02T10:00:00Z" }];
    render(<QuotePeekDialog quoteId={QID} onClose={() => {}} lines={LINES} todayIst={TODAY} />);
    expect(screen.queryByTestId("quote-peek-record-payment")).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy customer link" })).toBeNull();
    expect(screen.queryByText("Send on WhatsApp")).toBeNull();
    expect(screen.getByTestId("quote-peek-received").textContent).toBe("Received ₹3,823 of ₹3,823 · nothing due");
    expect(screen.getByRole("link", { name: "Open full quote" })).toBeTruthy();
  });

  it("closed (no quote id) renders no dialog; Esc closes an open one", () => {
    st.quote = fullQuote(); st.payments = [];
    const onClose = vi.fn();
    const { rerender } = render(<QuotePeekDialog quoteId={null} onClose={onClose} lines={undefined} todayIst={TODAY} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    rerender(<QuotePeekDialog quoteId={QID} onClose={onClose} lines={LINES} todayIst={TODAY} />);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});

describe("R-2866 — the list's wiring: ONE lines read for the rows on screen (useRowQuotePeek)", () => {
  const rows = [
    { sub: { id: "S1", domain: "a.in", start_date: "2025-10-01", term_months: 12 }, docs, stage: { quoteId: null } },
    { sub: { id: "S2" }, docs: { quote: null, invoice: null, invoices: [], sent: null } as LastDocs, stage: { quoteId: null } },   // no quote → not read
    { sub: { id: "S3" }, docs: undefined, stage: { quoteId: "Q-STAGE" } },
  ];
  function Probe({ enabled }: { enabled: boolean }) {
    const peek = useRowQuotePeek(rows, enabled);
    return <><button onClick={() => peek.open?.(QID)}>open</button><span data-testid="lines">{JSON.stringify(peek.linesOf(QID) ?? "loading")}</span><span data-testid="failed">{String(peek.failed)}</span>{peek.dialog}</>;
  }

  it("asks for every shown row's quote in one call, with the row's subscription; opens the pop-up for the clicked quote", () => {
    st.quote = fullQuote(); st.payments = [];
    render(<Probe enabled />);
    expect(st.linesRefs).toEqual([
      { quoteId: QID, sub: { id: "S1", domain: "a.in", start_date: "2025-10-01", term_months: 12 } },
      { quoteId: "Q-STAGE", sub: { id: "S3", domain: null, start_date: null, term_months: null } },
    ]);
    expect(screen.getByTestId("lines").textContent).toBe('"loading"');
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByText("open"));
    expect(screen.getByRole("dialog", { name: `Quote ${QID}` })).toBeTruthy();
  });

  it("R-2874: closing the pop-up (Esc) puts focus back on the number that opened it — a keyboard user keeps their place (Radix returns focus only to a DialogTrigger)", async () => {
    st.quote = fullQuote(); st.payments = [];
    render(<Probe enabled />);
    const opener = screen.getByText("open");
    opener.focus();
    fireEvent.click(opener);
    expect(screen.getByRole("dialog", { name: `Quote ${QID}` })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it("read done but the quote is not in the answer → no lines (never 'Loading…' for ever); a role without quotes reads nothing", () => {
    st.lines = new Map();
    const { unmount } = render(<Probe enabled />);
    expect(screen.getByTestId("lines").textContent).toBe("[]");
    unmount();
    render(<Probe enabled={false} />);
    expect(st.linesRefs).toEqual([]);
    fireEvent.click(screen.getByText("open"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("review: rows changed ('Show 50 more') and the LAST answer is still on screen → a quote it does not hold is still loading, never a false 'no lines'", () => {
    st.lines = new Map([["Q-OLD", []]]); st.linesPlaceholder = true;
    const { unmount } = render(<Probe enabled />);
    expect(screen.getByTestId("lines").textContent).toBe('"loading"');
    unmount();
    st.lines = new Map([[QID, [{ name: "Plan A", seats: null, period: null, from: null, to: null, domain: null }]]]);   // a quote the last answer DOES hold keeps its lines
    render(<Probe enabled />);
    expect(screen.getByTestId("lines").textContent).toContain("Plan A");
  });

  it("review: the read failed → 'failed' is passed on (hover + pop-up say it)", () => {
    st.linesError = true; st.quote = fullQuote(); st.payments = [];
    render(<Probe enabled />);
    expect(screen.getByTestId("failed").textContent).toBe("true");
    fireEvent.click(screen.getByText("open"));
    expect(screen.getByTestId("quote-peek-lines-failed")).toBeTruthy();
  });

  it("the read is batched by id, never per row: quotes, then their parts and subscriptions together (quote-peek-data.ts)", () => {
    const src = readFileSync(join(__dirname, "quote-peek-data.ts"), "utf8");
    expect(src.match(/fetchAllRowsIn</g)).toHaveLength(3);
    expect(src).toMatch(/queryKey: \["quotes", "renewal-row-quote-lines", key\]/);
    expect(src).not.toMatch(/\.eq\("id"/);
    const page = readFileSync(join(__dirname, "page.tsx"), "utf8");
    expect(page.match(/useRowQuotePeek\(/g)).toHaveLength(1);
    expect(page).toMatch(/lines=\{quotePeek\.linesOf\} onPeek=\{quotePeek\.open\}/);
  });
});
