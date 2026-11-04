// @vitest-environment jsdom
//
// R-2450 (G-NETWORK N2c) — the seller's invoice page and list show the customer's answer on the
// network copy (R-2434). Owner's path: Excel issues to Anutech (connected) → "Sent to Anutech on
// network — Pending"; Anutech accepts → "Accepted by customer"; rejects with a reason → the reason
// and "Issue a credit note and a fresh invoice". A customer not on the network → nothing shown.
import { describe, it, expect, vi, afterEach } from "vitest";
import * as React from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, cleanup, screen, within } from "@testing-library/react";
import type { NetworkSentDoc } from "@/lib/network/documents";

const credit = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[] }));
const debit = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[] }));
vi.mock("@/lib/queries/credit-notes", () => ({ useCreditNotesByInvoice: () => ({ data: credit.rows }) }));
vi.mock("@/lib/queries/debit-notes", () => ({ useDebitNotesByInvoice: () => ({ data: debit.rows }) }));

import { InvoiceNotesList } from "./invoice-detail";
import { NetworkChip, NetworkRowsContext, NetworkStatusLine } from "@/components/features/invoices/network-status";
import { networkStatusView } from "@/components/features/invoices/network-status-model";

afterEach(cleanup);

const sent = (over: Partial<NetworkSentDoc> = {}): NetworkSentDoc => ({
  id: "d-inv",
  kind: "invoice",
  sellerInvoiceId: "INV-1",
  sellerNoteId: null,
  docNumber: "INV-1",
  buyerName: "Anutech",
  buyerGstin: "07AAACR2450B1Z5",
  status: "pending",
  rejectReason: null,
  respondedAt: null,
  createdAt: "2026-11-04T01:00:00Z",
  ...over,
});

const noop = () => {};

describe("invoice page status line (R-2450)", () => {
  it("pending", () => {
    render(<NetworkStatusLine invoiceId="INV-1" rows={[sent()]} onRetry={noop} />);
    expect(screen.getByRole("status").textContent).toContain("Sent to Anutech on network — Pending");
  });

  it("accepted by customer, with the lock explained (no Void / edit — correct with a credit note)", () => {
    render(<NetworkStatusLine invoiceId="INV-1" rows={[sent({ status: "accepted", respondedAt: "2026-11-04T05:00:00Z" })]} onRetry={noop} />);
    const s = screen.getByRole("status").textContent ?? "";
    expect(s).toContain("Accepted by customer on 04 Nov 2026");
    expect(s).toContain("Correct it with a credit note.");
  });

  it("rejected by customer: reason + next step", () => {
    render(<NetworkStatusLine invoiceId="INV-1" rows={[sent({ status: "rejected", rejectReason: "Wrong quantity" })]} onRetry={noop} />);
    const s = screen.getByRole("status").textContent ?? "";
    expect(s).toContain("Rejected by customer: Wrong quantity");
    expect(s).toContain("Issue a credit note and a fresh invoice.");
  });

  it("cancelled", () => {
    render(<NetworkStatusLine invoiceId="INV-1" rows={[sent({ status: "cancelled" })]} onRetry={noop} />);
    expect(screen.getByRole("status").textContent).toContain("Sent to Anutech on network — Cancelled");
  });

  it("no badge for a customer that is not connected (no copy), nor while loading", () => {
    const { container } = render(<NetworkStatusLine invoiceId="INV-1" rows={[]} onRetry={noop} />);
    expect(container.textContent).toBe("");
    const { container: c2 } = render(<NetworkStatusLine invoiceId="INV-1" rows={undefined} onRetry={noop} />);
    expect(c2.textContent).toBe("");
  });

  it("a note's copy is not the invoice's status", () => {
    const { container } = render(
      <NetworkStatusLine invoiceId="INV-1" rows={[sent({ id: "cn", kind: "credit_note", sellerNoteId: "CN-1", status: "rejected", rejectReason: "x" })]} onRetry={noop} />,
    );
    expect(container.textContent).toBe("");
  });

  it("a read error says so in words, with a retry — never the raw text, never silent (§24)", () => {
    render(<NetworkStatusLine invoiceId="INV-1" rows={undefined} error={new Error('relation "network_documents" does not exist')} onRetry={noop} />);
    expect(document.body.textContent).not.toContain("network_documents");
    expect(document.body.textContent?.toLowerCase()).toContain("network answer");
  });
});

describe("credit / debit notes under the invoice show their own answer (R-2450)", () => {
  it("each note row reads its own copy; a note with no copy shows nothing", () => {
    credit.rows = [
      { id: "CN-1", reason_code: "seats_reduced", amount: 1180, credit_date: "2026-11-04" },
      { id: "CN-2", reason_code: "seats_reduced", amount: 590, credit_date: "2026-11-03" },
    ];
    debit.rows = [{ id: "DN-1", reason_code: "undercharge", amount: 100, debit_date: "2026-11-02" }];
    const rows = [
      sent({ status: "accepted" }),
      sent({ id: "c1", kind: "credit_note", sellerNoteId: "CN-1", docNumber: "CN-1", status: "rejected", rejectReason: "Not agreed" }),
      sent({ id: "d1", kind: "debit_note", sellerNoteId: "DN-1", docNumber: "DN-1", status: "pending" }),
    ];
    render(
      <NetworkRowsContext.Provider value={rows}>
        <InvoiceNotesList invoiceId="INV-1" />
      </NetworkRowsContext.Provider>,
    );
    const row = (id: string) => screen.getByText(id).closest("li") as HTMLElement;
    expect(within(row("CN-1")).getByText(/Rejected by customer: Not agreed/)).toBeTruthy();
    expect(row("CN-1").textContent).toContain("if this note is wrong, issue a fresh note");
    expect(row("DN-1").textContent).toContain("Sent to Anutech on network — Pending");
    expect(row("CN-2").textContent).not.toContain("on network");
  });

  it("outside the invoice page (no rows given) the notes list is as before", () => {
    credit.rows = [{ id: "CN-1", reason_code: "seats_reduced", amount: 1180, credit_date: "2026-11-04" }];
    debit.rows = [];
    render(<InvoiceNotesList invoiceId="INV-1" />);
    expect(screen.getByText("CN-1").closest("li")?.textContent).not.toContain("on network");
  });
});

describe("invoices list chip (R-2450)", () => {
  it("short word, full sentence on hover", () => {
    render(<NetworkChip view={networkStatusView(sent({ status: "rejected", rejectReason: "Wrong GSTIN" }))} />);
    const chip = screen.getByText("Network · Rejected");
    expect(chip.getAttribute("title")).toBe("Sent to Anutech on network — Rejected by customer: Wrong GSTIN");
  });

  it("is wired: the list reads one map for the page and shows the chip on the row and the phone card", () => {
    const src = readFileSync(join(__dirname, "page.tsx"), "utf8");
    expect(src).toContain("const networkChips = useNetworkChips(issuedIds);");
    expect(src).toContain("network={networkChips.get(inv.id)}");
    expect(src).toContain("<MobileInvoiceCard inv={inv} notes={noteTotals?.get(inv.id)} network={networkChips.get(inv.id)} />");
    expect(src.match(/<NetworkChip view=\{network\} \/>/g)?.length).toBe(2);
    // no new column: the table still has its seven columns (fits 1280 with Action visible)
    expect(src.match(/^\s*\{ id: "[a-z]+",\s+header:/gm)?.length).toBe(7);
  });

  it("is wired on the invoice page: one read, the line under the header, the notes through context", () => {
    const src = readFileSync(join(__dirname, "invoice-detail.tsx"), "utf8");
    expect(src).toContain('const network = useNetworkSentStatus(invoice.status === "draft" ? [] : [invoice.id]);');
    expect(src).toContain("<NetworkStatusLine");
    expect(src).toContain("<NetworkRowsContext.Provider value={network.data}>");
    expect(src).toContain("<NetworkNoteStatusFromPage noteId={n.id} />");
  });
});
