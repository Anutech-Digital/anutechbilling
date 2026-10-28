// @vitest-environment jsdom
/* R-2047 — owner's record (24 Oct, SCN Bharat Apps, 194J): gross ₹1,00,000, TDS ₹11,800, rate 10%,
   invoice GST ₹18,000. The detail and the list row show the amber note; the detail also shows
   Effective 11.80% beside Rate and the copyable next step. A correct row shows nothing extra. */
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ data: null }) }));
vi.mock("@/components/providers/confirm-provider", () => ({ useConfirm: () => vi.fn(), useAskText: () => vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("@/lib/queries/tds-receivable", () => {
  const m = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false });
  return {
    TDS_STATUS_LABEL: { pending_cert: "Pending certificate" },
    TDS_STATUS_DESCRIPTION: { pending_cert: "TDS deducted — chase customer for Form 16A" },
    uploadForm16a: vi.fn(), getForm16aSignedUrl: vi.fn(),
    useMarkCertReceived: m, useMarkVerified26AS: m, useMarkClaimed: m, useMarkDisputed: m,
    useWriteOffTds: m, useDeleteTdsReceivable: m,
  };
});

import { tdsEntryMismatch } from "@/lib/accounting/tds-mismatch";
import { TdsMismatchNote } from "./tds-mismatch-note";
import { TdsDetailDialog } from "./tds-detail-dialog";
import type { TdsReceivable } from "@/lib/queries/tds-receivable";

afterEach(cleanup);

const tax = { "INV-F588-27-0027": { taxable_value: 100_000, tax_amount: 18_000, tax_rate: 18 } };
const scn = {
  id: "TDS-379C4D4600", tenant_id: "t", invoice_id: "INV-F588-27-0027", payment_id: null, customer_id: null,
  customer_name: "SCN Bharat Apps", customer_tan: null, section: "194J", rate_pct: 10, gross_amount: 100_000,
  tds_amount: 11_800, net_paid: 106_200, fiscal_year: "FY2627", payment_received_date: "2026-10-24",
  status: "pending_cert", form_16a_url: null, form_16a_received_date: null, appears_in_26as: false,
  appears_in_26as_date: null, claimed_in_itr: false, claimed_in_itr_date: null, notes: null,
  created_at: "2026-10-24T00:00:00Z", updated_at: "2026-10-24T00:00:00Z",
} as unknown as TdsReceivable;
const NOTE = "Deducted ₹11,800 = 10% of ₹1,18,000 (incl. GST). On ₹1,00,000 it should be ₹10,000 — customer deducted ₹1,800 extra on GST.";

describe("R-2047 TDS mismatch note", () => {
  it("list row: the note only (no next step, one fact per row)", () => {
    render(<TdsMismatchNote mismatch={tdsEntryMismatch(scn, tax)!} />);
    expect(screen.getByTestId("tds-mismatch-note").textContent).toContain(NOTE);
    expect(screen.queryByText(/Ask the customer/)).toBeNull();
  });

  it("detail: note, Effective 11.80% beside Rate, copyable next step", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<TdsDetailDialog open onOpenChange={() => {}} tds={scn} mismatch={tdsEntryMismatch(scn, tax)} />);
    expect(screen.getByTestId("tds-mismatch-note").textContent).toContain(NOTE);
    expect(screen.getByTestId("tds-effective-rate").textContent).toBe("Effective 11.80%");
    expect(screen.getByText("Ask the customer to deduct on the amount before GST next time")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(writeText).toHaveBeenCalledWith("Ask the customer to deduct on the amount before GST next time");
  });

  it("detail of a correctly deducted entry: nothing extra", () => {
    const ok = { ...scn, tds_amount: 10_000 } as TdsReceivable;
    render(<TdsDetailDialog open onOpenChange={() => {}} tds={ok} mismatch={tdsEntryMismatch(ok, tax)} />);
    expect(screen.queryByTestId("tds-mismatch-note")).toBeNull();
    expect(screen.queryByTestId("tds-effective-rate")).toBeNull();
  });
});
