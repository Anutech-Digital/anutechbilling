// @vitest-environment jsdom
/**
 * R-2402 — the "Reconcile from Zoho" review table: one row per line with the plan; rows with a
 * problem start UNTICKED and say why; ready rows start ticked; a booked row cannot be ticked again;
 * ₹ in Indian format. Plus the Zoho pacing (under 100 calls a minute).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, within, cleanup } from "@testing-library/react";
import * as React from "react";
import { ZohoBulkTable } from "./zoho-bulk-table";
import { planRow, type PlanContext, type PlanRow } from "@/lib/integrations/zoho-books/bulk-reconcile-plan";
import type { ZohoMatchLine, ZohoPaymentMatch } from "@/lib/integrations/zoho-books/payment-match";
import { paceWaitMs, ZOHO_CALLS_PER_MIN } from "@/lib/integrations/zoho-books/zoho-pace";
import type { BookedRow } from "./zoho-bulk-book";

afterEach(() => cleanup());

const ctx: PlanContext = {
  customers: [{ id: "c-zuna", name: "Zuna Private Limited", gstin: null, state_code: "06", country: "India", domain: "zuna.one" }],
  subscriptions: [{ id: "s-zuna", customer_id: "c-zuna", plan: "Workspace", domain: "zuna.one", seats: 10, status: "active", start_date: "2026-05-23", renewal_date: "2027-05-23" }],
  catalog: [], payers: [], ownNames: [],
};
const zl = (over: Partial<ZohoMatchLine>): ZohoMatchLine => ({
  invoiceNumber: "INV/26-27/1134", name: "Workspace", sku: null, qty: 12, rate: 1000, itemTotal: null,
  start: "2026-05-23", end: "2027-05-22", months: 12, domain: "zuna.one", ...over,
});
function m(lines: ZohoMatchLine[], amount?: number): ZohoPaymentMatch {
  const amt = amount ?? Math.round(lines.reduce((s, l) => s + l.qty * (l.rate ?? 0), 0) * 1.18);
  return {
    by: "utr", payment: { zohoId: "p", number: "8687", date: "2026-10-29", amount: amt, reference: "", customerZohoId: "z", customerName: "Zuna Private Limited" },
    customer: { zohoId: "z", name: "Zuna Private Limited", gstin: null },
    invoices: [{ zohoId: "i", number: "INV/26-27/1134", date: null, amountApplied: amt, total: amt, lines }], moreInvoices: [],
  };
}
const line = (id: string, credit: number) => ({ id, txnDate: "2026-10-29", credit, description: "IMPS-1-ZUNA PRIVATE LIMITED-x", reference: null });

function Harness({ rows, booked = new Map() }: { rows: PlanRow[]; booked?: Map<string, BookedRow> }) {
  const [over, setOver] = React.useState(new Map<string, boolean>());
  const ticked = new Set(rows.filter((r) => r.book && (over.get(r.txnId) ?? r.ticked)).map((r) => r.txnId));
  return (
    <ZohoBulkTable rows={rows} ticked={ticked} booked={booked}
      onToggle={(id, on) => setOver((o) => new Map(o).set(id, on))}
      onToggleAll={(on) => setOver(new Map(rows.map((r) => [r.txnId, on])))} />
  );
}

describe("R-2402 review table", () => {
  const ready = planRow(line("t-ok", 14160), m([zl({})]), null, ctx);
  const short = planRow(line("t-bad", 10000), m([zl({})], 10000), null, ctx);

  it("a ready row starts ticked; a problem row starts unticked and says why", () => {
    render(<Harness rows={[ready, short]} />);
    const ok = screen.getByTestId("zoho-row-t-ok");
    const bad = screen.getByTestId("zoho-row-t-bad");
    expect((within(ok).getByRole("checkbox") as HTMLInputElement).checked).toBe(true);
    expect((within(bad).getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
    expect(within(bad).getByTestId("zoho-check-t-bad").textContent).toContain("Amount differs: the sale comes to ₹14,160, the bank line is ₹10,000.");
    expect(within(ok).getByTestId("zoho-check-t-ok").textContent).toContain("Ready");
  });

  it("shows the plan: the existing subscription (no new one), the seat difference, ₹ in Indian format", () => {
    render(<Harness rows={[ready]} />);
    const ok = screen.getByTestId("zoho-row-t-ok");
    expect(ok.textContent).toContain("₹14,160");
    expect(ok.textContent).toContain("Has Workspace (zuna.one) — no new subscription");
    expect(ok.textContent).toContain("Seats differ: app 10, Zoho 12");
    expect(ok.textContent).toContain("Payment 8687");
    expect(ok.textContent).toContain("INV/26-27/1134");
  });

  it("a person can untick a ready row and tick a problem row", () => {
    render(<Harness rows={[ready, short]} />);
    const okBox = within(screen.getByTestId("zoho-row-t-ok")).getByRole("checkbox");
    fireEvent.click(okBox);
    expect((okBox as HTMLInputElement).checked).toBe(false);
    const badBox = within(screen.getByTestId("zoho-row-t-bad")).getByRole("checkbox");
    fireEvent.click(badBox);
    expect((badBox as HTMLInputElement).checked).toBe(true);
  });

  it("a booked row cannot be ticked again and says it was booked", () => {
    const booked = new Map<string, BookedRow>([["t-ok", {
      txnId: "t-ok", txnDate: "2026-10-29", credit: 14160, outcome: "booked", customerName: "Zuna", customerCreated: false,
      quoteId: "Q-1", invoiceId: "INV-1", subscriptions: [], todo: [], text: "Booked and reconciled.",
    }]]);
    render(<Harness rows={[ready]} booked={booked} />);
    const box = within(screen.getByTestId("zoho-row-t-ok")).getByRole("checkbox");
    expect((box as HTMLInputElement).disabled).toBe(true);
    expect((box as HTMLInputElement).checked).toBe(false);
    expect(screen.getByTestId("zoho-check-t-ok").textContent).toBe("Booked and reconciled.");
  });
});

describe("R-2402 Zoho pacing", () => {
  it("goes at once while the last minute has room; else waits until the oldest page leaves the window", () => {
    const now = 1_000_000;
    expect(paceWaitMs([{ at: now - 10_000, calls: 30 }], now, 30)).toBe(0);
    expect(paceWaitMs([{ at: now - 50_000, calls: 40 }, { at: now - 10_000, calls: 30 }], now, 30)).toBe(10_000);
    expect(paceWaitMs([{ at: now - 70_000, calls: 80 }], now, 30)).toBe(0);
    expect(ZOHO_CALLS_PER_MIN).toBeLessThan(100);
  });
  it("never more than the budget in any minute over a long run", () => {
    const hist: { at: number; calls: number }[] = [];
    let t = 0;
    for (let i = 0; i < 40; i++) {
      t += paceWaitMs(hist, t, 30);
      hist.push({ at: t, calls: 30 });
      const inWindow = hist.filter((h) => t - h.at < 60_000).reduce((s, h) => s + h.calls, 0);
      expect(inWindow).toBeLessThanOrEqual(ZOHO_CALLS_PER_MIN);
      t += 1_000;
    }
    void vi;
  });
});
