// @vitest-environment jsdom
/* R-1852 — Employees → profile → "Director of the company?": Pvt Ltd + register roles only;
   picking a director links the employee (set_director_employee); a director paid as another
   employee is not offered; "Not a director" unlinks. */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const state = vi.hoisted(() => ({
  type: "pvt_ltd" as string | null,
  role: "owner",
  directors: [] as Record<string, unknown>[],
  mutate: vi.fn(),
}));
vi.mock("@/lib/compliance/profile", () => ({ useComplianceProfile: () => ({ isSuccess: true, data: { businessType: state.type } }) }));
vi.mock("@/lib/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ data: { role: state.role, tenantId: "t1" } }) }));
vi.mock("@/lib/dates/ist", () => ({ istToday: () => "2026-10-25" }));
vi.mock("@/lib/queries/company-directors", () => ({
  useCompanyDirectors: () => ({ data: state.directors }),
  useSetDirectorEmployee: () => ({ mutate: state.mutate, isPending: false }),
}));
vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));

import { EmployeeDirectorLink } from "./employee-director-link";

const A = { id: "d1", name: "Asha Verma", din: "01234567", designation: "managing_director", ceased_on: null, employee_id: null };
const B = { id: "d2", name: "Bimal Rao", din: "07654321", designation: "director", ceased_on: null, employee_id: "other-emp" };
const C = { id: "d3", name: "Chitra Old", din: "05555555", designation: "director", ceased_on: "2026-09-30", employee_id: null };

beforeEach(() => { state.type = "pvt_ltd"; state.role = "owner"; state.directors = [A, B, C]; state.mutate.mockReset(); });
afterEach(cleanup);

describe("EmployeeDirectorLink", () => {
  it("offers current directors not paid as another employee; picking one links this employee", () => {
    render(<EmployeeDirectorLink employeeId="e1" />);
    const select = screen.getByLabelText("Director of the company?") as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(["Not a director", "Asha Verma — Managing Director (DIN 01234567)"]);
    fireEvent.change(select, { target: { value: "d1" } });
    expect(state.mutate).toHaveBeenCalledWith({ directorId: "d1", employeeId: "e1", previousDirectorId: null });
  });

  it("a linked employee shows the director and can be unlinked", () => {
    state.directors = [{ ...A, employee_id: "e1" }, B];
    render(<EmployeeDirectorLink employeeId="e1" />);
    expect((screen.getByLabelText("Director of the company?") as HTMLSelectElement).value).toBe("d1");
    expect(screen.getByText(/Director's Remuneration, apart from Salaries/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Director of the company?"), { target: { value: "" } });
    expect(state.mutate).toHaveBeenCalledWith({ directorId: "d1", employeeId: null });
  });

  it("hidden for a proprietor / partnership and for sales", () => {
    state.type = "proprietor";
    expect(render(<EmployeeDirectorLink employeeId="e1" />).container.innerHTML).toBe("");
    cleanup();
    state.type = "pvt_ltd"; state.role = "sales";
    expect(render(<EmployeeDirectorLink employeeId="e1" />).container.innerHTML).toBe("");
  });

  it("no directors yet → the way to add them", () => {
    state.directors = [];
    render(<EmployeeDirectorLink employeeId="e1" />);
    expect(screen.getByRole("link", { name: /Add them in Settings → Company/ }).getAttribute("href")).toBe("/settings/company");
  });
});
