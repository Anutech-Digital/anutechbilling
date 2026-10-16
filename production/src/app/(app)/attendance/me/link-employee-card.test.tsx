// @vitest-environment jsdom
/**
 * R-1414 — /attendance/me must never show a blank "Select your profile" dropdown, and every
 * "not linked" card must say what to do next using only places that exist today (§24).
 * R-1436 (open): there is no screen yet where the owner links someone else's login to an
 * employee — so the low-role card must not send people to "Team → Employees".
 */
import * as React from "react";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";

const state = vi.hoisted(() => ({
  role: "owner" as string | null,
  email: "owner@acme.in",
  rows: [] as { id: string; name: string }[],
  choicesEnabled: null as boolean | null,
}));
const openHelpReport = vi.hoisted(() => vi.fn());

vi.mock("@/lib/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({ data: { role: state.role, authEmail: state.email }, isLoading: false }),
}));
vi.mock("@/lib/queries/my-attendance", () => ({
  useMyEmployeeLinkChoices: (enabled: boolean) => {
    state.choicesEnabled = enabled;
    return { data: enabled ? state.rows : undefined, isLoading: false, error: null };
  },
  useSetMyEmployee: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/components/shared/ai-help", () => ({ openHelpReport }));

import { LinkEmployeeCard } from "./link-employee-card";

beforeEach(() => {
  state.role = "owner";
  state.email = "owner@acme.in";
  state.rows = [];
  state.choicesEnabled = null;
  openHelpReport.mockClear();
});
afterEach(cleanup);

describe("R-1414 LinkEmployeeCard", () => {
  it("owner with nothing to link: empty state with why + Open Employees, no dropdown", () => {
    render(<LinkEmployeeCard />);
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getByText(/No employee profile is free to link to your login/)).toBeTruthy();
    // why: the same rule set_my_employee / my_employee_link_choices enforce, with their e-mail
    expect(screen.getByText(/owner@acme\.in/)).toBeTruthy();
    const link = screen.getByRole("link", { name: "Open Employees" });
    expect(link.getAttribute("href")).toBe("/accounting/employees");
  });

  it("owner with free profiles: the dropdown lists them", () => {
    state.rows = [{ id: "e1", name: "Asha Verma" }, { id: "e2", name: "Ravi Kumar" }];
    render(<LinkEmployeeCard />);
    expect(screen.getByText("Select your profile")).toBeTruthy();
    fireEvent.click(screen.getByRole("combobox"));
    expect(screen.getAllByText("Asha Verma").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Ravi Kumar").length).toBeGreaterThan(0);
    expect(screen.queryByText(/No employee profile is free/)).toBeNull();
  });

  it.each(["sales", "support", "delivery", "billing"])(
    "%s login: no list request, no dropdown, a next step that exists today",
    (role) => {
      state.role = role;
      render(<LinkEmployeeCard />);
      expect(state.choicesEnabled).toBe(false);
      expect(screen.queryByRole("combobox")).toBeNull();
      expect(screen.getByText("Profile not linked")).toBeTruthy();
      // R-1436: no "Team → Employees" link screen exists yet — never point there.
      expect(document.body.textContent ?? "").not.toMatch(/Team → Employees/);
      fireEvent.click(screen.getByRole("button", { name: "Report a problem" }));
      expect(openHelpReport).toHaveBeenCalledTimes(1);
    },
  );
});
