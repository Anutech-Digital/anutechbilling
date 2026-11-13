// @vitest-environment jsdom
/* R-2757 — Bill next part names an earlier unpaid part (Greentin Check 2095: Oct Q-F588-27-0059),
   the button says "Bill Nov anyway" and still bills; "Periods" reads "Months to bill". */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import * as React from "react";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BillNextPartDialog } from "./bill-next-part-dialog";
import type { BillNextPreview } from "@/lib/billing/proforma";

const PREVIEW: BillNextPreview = {
  cycle: "monthly", seats: 10, seatRate: 325, partTaxable: 3250, taxRate: 18,
  amounts: { taxable: 3250, tax: 585, gross: 3835 },
  periods: [{ start: "2026-11-01", end: "2026-11-30", existing: null }],
  firstStart: "2026-11-01",
  unpaidEarlier: [{ kind: "proforma", id: "Q-F588-27-0059", start: "2026-10-01", end: "2026-10-31", due: 3835, dueDate: "2026-10-01", daysOverdue: 44 }],
};

const fetchMock = vi.fn();
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function show(preview: BillNextPreview, onConfirm = vi.fn()) {
  fetchMock.mockImplementation(async () => new Response(JSON.stringify({ preview }), { status: 200 }));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <BillNextPartDialog sub={{ id: "sub-g", customer_name: "Greentin Check 2095", plan: "Google Workspace Business Starter" }}
        open onOpenChange={() => {}} onConfirm={onConfirm} busy={false} />
    </QueryClientProvider>,
  );
  return onConfirm;
}

describe("R-2757 BillNextPartDialog", () => {
  it("names the earlier unpaid part with a Record payment link; the button bills anyway", async () => {
    const onConfirm = show(PREVIEW);
    const note = await screen.findByTestId("bill-next-unpaid-earlier");
    expect(note.textContent).toContain("An earlier part is still unpaid");
    expect(note.textContent).toContain("Oct 2026 · Q-F588-27-0059 · ₹3,835 unpaid · overdue 44 days");
    expect(screen.getByRole("link", { name: "Record payment" }).getAttribute("href")).toBe("/quotes/Q-F588-27-0059?pay=1");
    expect(screen.getByLabelText(/Months to bill/)).toBeTruthy();
    const btn = screen.getByRole("button", { name: "Bill Nov anyway" });
    fireEvent.click(btn);
    expect(onConfirm).toHaveBeenCalledWith({ periods: 1, seats: null, seatRate: null });
  });

  it("nothing earlier unpaid → no note, 'Create proforma' as before", async () => {
    show({ ...PREVIEW, unpaidEarlier: [] });
    await screen.findByRole("button", { name: "Create proforma" });
    expect(screen.queryByTestId("bill-next-unpaid-earlier")).toBeNull();
  });

  it("an unpaid earlier invoice → 'Open it' to the invoice; quarterly says 'Quarters to bill'", async () => {
    show({
      ...PREVIEW, cycle: "quarterly",
      unpaidEarlier: [{ kind: "invoice", id: "INV-ET-2026-27-0099", start: "2026-07-12", end: "2026-10-11", due: 3000, dueDate: null, daysOverdue: 0 }],
    });
    const link = await screen.findByRole("link", { name: "Open it" });
    expect(link.getAttribute("href")).toContain("INV-ET-2026-27-0099");
    expect(screen.getByTestId("bill-next-unpaid-earlier").textContent).toContain("12 Jul–11 Oct 2026 · Invoice INV-ET-2026-27-0099 · ₹3,000 unpaid · not yet due");
    expect(screen.getByLabelText(/Quarters to bill/)).toBeTruthy();
  });
});
