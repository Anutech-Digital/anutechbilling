// @vitest-environment jsdom
/* R-1851 — Settings → Company → Share capital: only for a Pvt Ltd and the register roles;
   card example authorised ₹10L, FV ₹10, 50,000 + 50,000 shares → paid-up ₹10,00,000, 50% each;
   1,10,000 shares is refused beside the field and nothing is saved. */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const state = vi.hoisted(() => ({
  type: "pvt_ltd" as string | null,
  role: "owner",
  data: { capital: null, holders: [] } as { capital: { authorised_capital: number; face_value: number } | null; holders: Record<string, unknown>[] },
  saveHolder: vi.fn(),
  saveCapital: vi.fn(),
}));
vi.mock("@/lib/compliance/profile", () => ({
  useComplianceProfile: () => ({ isSuccess: true, data: { businessType: state.type, gstFiling: null, columnsMissing: false } }),
}));
vi.mock("@/lib/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ data: { role: state.role, tenantId: "t1" } }) }));
vi.mock("@/components/providers/confirm-provider", () => ({ useConfirm: () => async () => false }));
vi.mock("@/lib/queries/share-capital", () => ({
  useShareCapital: () => ({ data: state.data, isLoading: false, error: null, refetch: vi.fn() }),
  useSaveShareCapital: () => ({ mutate: state.saveCapital, isPending: false }),
  useSaveShareholder: () => ({ mutateAsync: state.saveHolder, isPending: false }),
  useDeleteShareholder: () => ({ mutate: vi.fn() }),
}));
vi.mock("next/link", () => ({ default: ({ href, children, ...p }: { href: string; children: React.ReactNode }) => <a href={href} {...p}>{children}</a> }));

import { ShareCapitalCard } from "./share-capital-card";

const CAP = { authorised_capital: 1000000, face_value: 10 };
const H = (id: string, name: string, shares: number) => ({ id, name, pan: null, shares, allotted_on: "2024-04-01" });

beforeEach(() => {
  state.type = "pvt_ltd"; state.role = "owner";
  state.data = { capital: null, holders: [] };
  state.saveHolder.mockReset(); state.saveCapital.mockReset();
});
afterEach(cleanup);

describe("ShareCapitalCard", () => {
  it("only for a Pvt Ltd / empty type and the register roles", () => {
    expect(render(<ShareCapitalCard />).container.textContent).toMatch(/Share capital/);
    cleanup();
    state.type = null;
    expect(render(<ShareCapitalCard />).container.textContent).toMatch(/Share capital/);
    cleanup();
    state.type = "proprietor";
    expect(render(<ShareCapitalCard />).container.textContent).toBe("");
    cleanup();
    state.type = "pvt_ltd"; state.role = "sales";
    expect(render(<ShareCapitalCard />).container.textContent).toBe("");
  });

  it("no capital yet: asks for authorised capital + face value first, saves them", () => {
    render(<ShareCapitalCard />);
    expect(screen.getByText(/Save the authorised capital and face value first/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add shareholder" })).toBeNull();
    fireEvent.change(screen.getByLabelText(/Authorised capital/), { target: { value: "1000000" } });
    fireEvent.click(screen.getByRole("button", { name: "Save capital" }));
    expect(state.saveCapital).toHaveBeenCalledWith({ authorised_capital: 1000000, face_value: 10 });
  });

  it("card example: 50,000 + 50,000 shares → paid-up ₹10,00,000, 50% each", () => {
    state.data = { capital: CAP, holders: [H("a", "Asha Verma", 50000), H("b", "Bimal Rao", 50000)] };
    render(<ShareCapitalCard />);
    expect(screen.getByText("1,00,000")).toBeTruthy();
    expect(screen.getAllByText("₹10,00,000").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/50,000 shares · 50% · ₹5,00,000/)).toHaveLength(2);
    expect(screen.getByText(/Shown on the/).textContent).toMatch(/Share capital ₹10,00,000/);
  });

  it("1,10,000 shares is refused beside the field and nothing is saved", async () => {
    state.data = { capital: CAP, holders: [H("a", "Asha Verma", 50000)] };
    render(<ShareCapitalCard />);
    fireEvent.click(screen.getByRole("button", { name: "Add shareholder" }));
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: "Bimal Rao" } });
    fireEvent.change(screen.getByLabelText(/Number of shares/), { target: { value: "60000" } });
    const buttons = screen.getAllByRole("button", { name: "Add shareholder" });
    fireEvent.click(buttons[buttons.length - 1]);
    expect(await screen.findByText(/more than the authorised capital of ₹10,00,000/)).toBeTruthy();
    expect(state.saveHolder).not.toHaveBeenCalled();
  });
});
