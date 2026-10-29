// @vitest-environment jsdom
/* R-2025 (3)(6) — the receipt of money paid from someone else's account says who paid and for
   whom; the receipt (and the GST invoice) stays in the CUSTOMER's name. */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import * as React from "react";
import { render, cleanup, screen } from "@testing-library/react";

const state = vi.hoisted(() => ({ payer: null as null | { payer_name: string | null; payer_relation: string | null } }));
vi.mock("@/lib/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ data: { tenantLogoUrl: null } }) }));
vi.mock("@/lib/queries/tds-receivable", () => ({ useTdsForPayment: () => ({ data: 0 }) }));
vi.mock("@/lib/queries/customer-payers", () => ({ usePaymentPayer: () => ({ data: state.payer }) }));

import { ReceiptVoucherDialog } from "@/components/features/quotes/receipt-voucher-dialog";
import type { Payment } from "@/lib/supabase/database.types";

const payment = {
  id: "pay-1", quote_id: "Q-9", invoice_id: null, amount: 16709, credit_applied: 0, status: "received",
  method: "bank_transfer", reference: "INDBH23101090759", received_at: "2026-10-23T00:00:00Z", receipt_voucher_no: "RV-1", notes: null,
} as unknown as Payment;

afterEach(cleanup);
beforeEach(() => { state.payer = null; });

describe("R-2025 receipt voucher — paid on the customer's behalf", () => {
  it("'Received from SHREE NANDIK … (director) on behalf of Links Infotech'; the recipient stays Links", () => {
    state.payer = { payer_name: "SHREE NANDIK TECHNOLOGIES PRIVATE LIMITED", payer_relation: "director" };
    render(<ReceiptVoucherDialog open onOpenChange={() => {}} payment={payment} customerName="Links Infotech" tenantName="Orbit Software" quoteId="Q-9" />);
    expect(screen.getByText("Received from SHREE NANDIK TECHNOLOGIES PRIVATE LIMITED (director) on behalf of Links Infotech")).toBeTruthy();
    expect(screen.getByText("Links Infotech", { selector: "p.font-serif" })).toBeTruthy();
  });

  it("no payer → no extra line", () => {
    render(<ReceiptVoucherDialog open onOpenChange={() => {}} payment={payment} customerName="Links Infotech" tenantName="Orbit Software" quoteId="Q-9" />);
    expect(screen.queryByText(/on behalf of/)).toBeNull();
  });
});
