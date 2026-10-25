// @vitest-environment jsdom
/* R-1850 — Settings → Company → Directors: only for a Pvt Ltd (empty type = Pvt Ltd) and the
   register roles; current directors show DSC days + KYC due; ceased ones are listed apart;
   a 7-digit DIN is refused beside the field and nothing is saved. */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const state = vi.hoisted(() => ({
  type: "pvt_ltd" as string | null,
  role: "owner",
  directors: [] as Record<string, unknown>[],
  save: vi.fn(),
}));
vi.mock("@/lib/compliance/profile", () => ({
  useComplianceProfile: () => ({ isSuccess: true, data: { businessType: state.type, gstFiling: null, columnsMissing: false } }),
}));
vi.mock("@/lib/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ data: { role: state.role, tenantId: "t1" } }) }));
vi.mock("@/lib/dates/ist", () => ({ istToday: () => "2026-10-25" }));
vi.mock("@/components/providers/confirm-provider", () => ({ useConfirm: () => async () => false }));
vi.mock("@/lib/queries/company-directors", () => ({
  useCompanyDirectors: () => ({ data: state.directors, isLoading: false, error: null, refetch: vi.fn() }),
  useSaveCompanyDirector: () => ({ mutateAsync: state.save, isPending: false }),
  useDeleteCompanyDirector: () => ({ mutate: vi.fn() }),
}));
vi.mock("next/link", () => ({ default: ({ href, children, ...p }: { href: string; children: React.ReactNode }) => <a href={href} {...p}>{children}</a> }));
const nav = vi.hoisted(() => ({ push: vi.fn(), info: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: nav.push }) }));
vi.mock("sonner", () => ({ toast: { info: nav.info, success: vi.fn(), error: vi.fn() } }));

import { DirectorsRegisterCard } from "./directors-register-card";

const A = {
  id: "d1", name: "Asha Verma", din: "01234567", pan: "ABCPV1234K", designation: "managing_director",
  appointed_on: "2024-04-01", ceased_on: null, dsc_expiry: "2026-11-14", last_kyc_year: 2025, email: "asha@example.in", phone: "9810012345",
};
const B = {
  id: "d2", name: "Bimal Rao", din: "07654321", pan: null, designation: "director",
  appointed_on: "2024-04-01", ceased_on: null, dsc_expiry: null, last_kyc_year: null, email: null, phone: null,
};
const C = { ...B, id: "d3", name: "Chitra Old", din: "05555555", ceased_on: "2026-09-30" };

beforeEach(() => {
  state.type = "pvt_ltd";
  state.role = "owner";
  state.directors = [];
  state.save.mockReset();
});
afterEach(cleanup);

describe("DirectorsRegisterCard", () => {
  it("is shown for a Pvt Ltd and for an empty type; hidden for a proprietor / partnership", () => {
    render(<DirectorsRegisterCard />);
    expect(screen.getByRole("heading", { name: "Directors" })).toBeTruthy();
    cleanup();
    state.type = null;
    render(<DirectorsRegisterCard />);
    expect(screen.getByRole("heading", { name: "Directors" })).toBeTruthy();
    cleanup();
    for (const t of ["proprietor", "partnership", "llp"]) {
      state.type = t;
      expect(render(<DirectorsRegisterCard />).container.textContent).toBe("");
      cleanup();
    }
  });

  it("is hidden from a sales login", () => {
    state.role = "sales";
    expect(render(<DirectorsRegisterCard />).container.textContent).toBe("");
  });

  it("shows DSC days and KYC due for current directors, and lists a ceased one apart", () => {
    state.directors = [A, B, C];
    render(<DirectorsRegisterCard />);
    expect(screen.getByText("DSC expires in 20 days")).toBeTruthy();
    expect(screen.getByText("KYC due 30 Jun 2028")).toBeTruthy();
    expect(screen.getByText("DSC expiry not added")).toBeTruthy();
    expect(screen.getByText(/KYC due 30 Jun 2028 \(add the last KYC year to be sure\)/)).toBeTruthy();
    expect(screen.getByText("Managing Director")).toBeTruthy();
    expect(screen.getByText("Former directors")).toBeTruthy();
    expect(screen.getByText(/Ceased/)).toBeTruthy();
  });

  it("a 7-digit DIN is refused beside the field and nothing is saved", async () => {
    render(<DirectorsRegisterCard />);
    fireEvent.click(screen.getByRole("button", { name: "Add director" }));
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: "Asha Verma" } });
    fireEvent.change(screen.getByLabelText(/^DIN/), { target: { value: "1234567" } });
    const buttons = screen.getAllByRole("button", { name: "Add director" });
    fireEvent.click(buttons[buttons.length - 1]);
    expect(await screen.findByText("DIN must be 8 digits.")).toBeTruthy();
    expect(state.save).not.toHaveBeenCalled();
  });

  it("a valid director is saved with the normalised values", async () => {
    state.save.mockResolvedValue("new-id");
    render(<DirectorsRegisterCard />);
    fireEvent.click(screen.getByRole("button", { name: "Add director" }));
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: " Asha Verma " } });
    fireEvent.change(screen.getByLabelText(/^DIN/), { target: { value: "01234567" } });
    fireEvent.change(screen.getByLabelText(/^PAN/), { target: { value: "abcpv1234k" } });
    fireEvent.change(screen.getByLabelText(/DSC expiry/), { target: { value: "2027-03-31" } });
    const buttons = screen.getAllByRole("button", { name: "Add director" });
    fireEvent.click(buttons[buttons.length - 1]);
    await vi.waitFor(() => expect(state.save).toHaveBeenCalled());
    expect(state.save.mock.calls[0][0]).toMatchObject({ id: null, name: "Asha Verma", din: "01234567", pan: "ABCPV1234K", dsc_expiry: "2027-03-31", designation: "director" });
    expect(nav.info).not.toHaveBeenCalled();
  });

  it("R-1857: a new email → 'file DIR-3 KYC Web by 24 Nov 2026' with a button to the ROC calendar", async () => {
    nav.info.mockReset();
    state.directors = [A];
    state.save.mockResolvedValue("d1");
    render(<DirectorsRegisterCard />);
    fireEvent.click(screen.getByRole("button", { name: "Edit Asha Verma" }));
    fireEvent.change(screen.getByLabelText(/Email/), { target: { value: "asha.verma@example.in" } });
    fireEvent.click(screen.getByRole("button", { name: "Save director" }));
    await vi.waitFor(() => expect(nav.info).toHaveBeenCalledTimes(1));
    const [msg, opts] = nav.info.mock.calls[0];
    expect(msg).toMatch(/Asha Verma's contact changed .* file DIR-3 KYC Web by 24 Nov 2026/);
    expect(opts.action.label).toBe("Open ROC calendar");
    opts.action.onClick();
    expect(nav.push).toHaveBeenCalledWith("/compliance/roc");
  });
});
