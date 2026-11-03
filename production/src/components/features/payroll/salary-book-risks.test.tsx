// @vitest-environment jsdom
/** R-2428 — Reconcile → "Book as salary": refused after the last day; warned before joining until ticked. */
import * as React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";

const rows = vi.hoisted(() => ({ data: [] as Array<{ period: string; employee_id: string; notes: string | null }> }));
vi.mock("@/lib/queries/payroll", () => ({ useEmployeeSalaryHistory: () => ({ data: rows.data }) }));

import { SalaryBookRisks } from "./salary-book-risks";
import type { Employee } from "@/lib/queries/payroll";

const keshav = { id: "e-k", name: "Keshav Malik", joining_date: "2026-04-01", exit_date: null, is_active: true } as unknown as Employee;
afterEach(() => { cleanup(); rows.data = []; });

describe("R-2428 SalaryBookRisks", () => {
  it("after the last working day → refused", () => {
    const onChange = vi.fn();
    render(<SalaryBookRisks employee={{ ...keshav, exit_date: "2026-04-16" }} period="2026-06" onChange={onChange} />);
    expect(screen.getByText(/left on 16 Apr 2026 — no salary after Apr 2026/)).toBeTruthy();
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ block: expect.stringMatching(/left on/) }));
  });

  it("March for an April joiner → warned; ticking 'book anyway' clears it", () => {
    const onChange = vi.fn();
    render(<SalaryBookRisks employee={keshav} period="2026-03" onChange={onChange} />);
    expect(onChange).toHaveBeenLastCalledWith({ block: null, warnings: [expect.stringMatching(/before they joined/)] });
    fireEvent.click(screen.getByLabelText(/book it anyway/));
    expect(onChange).toHaveBeenLastCalledWith({ block: null, warnings: [] });
  });

  it("a month that already has a record → no check (the line links to it)", () => {
    rows.data = [{ period: "2026-06", employee_id: "e-k", notes: null }];
    const onChange = vi.fn();
    const { container } = render(<SalaryBookRisks employee={{ ...keshav, exit_date: "2026-04-16" }} period="2026-06" onChange={onChange} />);
    expect(container.textContent).toBe("");
    expect(onChange).toHaveBeenLastCalledWith({ block: null, warnings: [] });
  });
});
