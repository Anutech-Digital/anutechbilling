// @vitest-environment jsdom
//
// R-1846: Add expense → a proprietor books "Director's Remuneration" / "owner salary" → a caution
// and ONE click records drawings (R-1839's RPC) and closes the form — no expense is created.
// Pvt Ltd / an empty type → nothing shown.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import * as React from "react";
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";

const recordSpy = vi.fn(async (_v: Record<string, unknown>) => "mov-1");
const state: { type: string | null; partners: Record<string, unknown>[] } = { type: "proprietor", partners: [] };

vi.mock("@/lib/compliance/profile", () => ({ useComplianceProfile: () => ({ data: { businessType: state.type } }) }));
vi.mock("@/lib/queries/partners", () => ({ useFirmPartners: () => ({ data: state.partners, isLoading: false }) }));
vi.mock("@/lib/queries/owner-equity", () => ({ useRecordOwnerEquity: () => ({ mutateAsync: recordSpy, isPending: false }) }));

import { OwnerPayCautionBox } from "./owner-pay-caution";

function Box(p: Partial<React.ComponentProps<typeof OwnerPayCautionBox>> = {}) {
  return (
    <OwnerPayCautionBox category="Director's Remuneration" payee="" text="" amount={25000} method="bank_transfer"
      bankAccountId="bank-1" pettyCashAccountId="cash-1" date="2026-10-20" today="2026-10-25" onRecorded={vi.fn()} {...p} />
  );
}

beforeEach(() => { recordSpy.mockClear(); state.type = "proprietor"; state.partners = []; });
afterEach(cleanup);

describe("R-1846 OwnerPayCautionBox", () => {
  it("proprietor + Director's Remuneration → caution; one click records drawings and closes the form", async () => {
    const onRecorded = vi.fn();
    render(<Box onRecorded={onRecorded} />);
    expect(screen.getByText(/proprietor's own salary is not an expense/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Record as drawings instead" }));
    await waitFor(() => expect(onRecorded).toHaveBeenCalled());
    expect(recordSpy).toHaveBeenCalledWith({ kind: "drawings", date: "2026-10-20", amount: 25000, accountId: "bank-1", partner: null, note: null });
  });

  it("cash → the petty cash account", async () => {
    render(<Box method="cash" />);
    fireEvent.click(screen.getByRole("button", { name: "Record as drawings instead" }));
    await waitFor(() => expect(recordSpy).toHaveBeenCalled());
    expect(recordSpy.mock.calls[0][0]).toMatchObject({ accountId: "cash-1" });
  });

  it("no account picked → a message, nothing recorded, form stays open", () => {
    const onRecorded = vi.fn();
    render(<Box bankAccountId="" onRecorded={onRecorded} />);
    fireEvent.click(screen.getByRole("button", { name: "Record as drawings instead" }));
    expect(screen.getByRole("alert").textContent).toMatch(/From which account/);
    expect(recordSpy).not.toHaveBeenCalled();
    expect(onRecorded).not.toHaveBeenCalled();
  });

  it("Pvt Ltd and an empty type → nothing shown", () => {
    state.type = "pvt_ltd";
    const { container, rerender } = render(<Box text="owner salary" />);
    expect(container.innerHTML).toBe("");
    state.type = null;
    rerender(<Box text="owner salary" />);
    expect(container.innerHTML).toBe("");
  });

  it("partnership: paid to a register partner → drawings go to that partner", async () => {
    state.type = "partnership";
    state.partners = [{ id: "p1", name: "Ravi Kumar", joined_on: null, left_on: null }];
    render(<Box category="Professional Services" payee="Ravi Kumar" />);
    expect(screen.getAllByText(/deed/i).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Record as drawings instead" }));
    await waitFor(() => expect(recordSpy).toHaveBeenCalled());
    expect(recordSpy.mock.calls[0][0]).toMatchObject({ partner: "Ravi Kumar", note: "Ravi Kumar" });
  });

  it("partnership + Director's Remuneration, no partner named → asks for the partner first", () => {
    state.type = "partnership";
    state.partners = [{ id: "p1", name: "Ravi Kumar", joined_on: null, left_on: null }, { id: "p2", name: "Sita Devi", joined_on: null, left_on: null }];
    render(<Box />);
    fireEvent.click(screen.getByRole("button", { name: "Record as drawings instead" }));
    expect(screen.getByRole("alert").textContent).toMatch(/Pick the partner/);
    expect(recordSpy).not.toHaveBeenCalled();
  });
});
