// @vitest-environment jsdom
/**
 * R-2380 — "Merge into…" on an employee. Owner's case (2 Nov 2026): "Prashant Kumar" is a
 * duplicate of "Prashant" and holds salary Jul ₹5,000 + Aug ₹14,000. The dialog pre-picks
 * Prashant (same first name), shows what moves from the dry run, and calls merge_employees once.
 * A month where both have a salary blocks the merge until "Keep both" is ticked.
 */
import * as React from "react";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";

const mutate = vi.hoisted(() => vi.fn());
const preview = vi.hoisted(() => ({ current: null as unknown }));
const previewArgs = vi.hoisted(() => [] as unknown[][]);
vi.mock("@/lib/queries/payroll", () => ({
  useMergeEmployees: () => ({ mutate, isPending: false }),
  useMergeEmployeesPreview: (keepId: string | null, dupId: string) => {
    previewArgs.push([keepId, dupId]);
    return keepId ? { data: preview.current, isLoading: false, isError: false } : { data: undefined, isLoading: false, isError: false };
  },
}));

import { MergeEmployeeDialog, guessKeep, monthLabel } from "./merge-employee-dialog";

const prashant = { id: "e-p", name: "Prashant", designation: "Office Boy", is_active: true };
const prashantKumar = { id: "e-pk", name: "Prashant Kumar", designation: "Duplicate of Prashant", is_active: false };
const asha = { id: "e-a", name: "Asha", designation: "Accountant", is_active: true };
const all = [prashant, prashantKumar, asha];

const base = {
  keep: { id: "e-p", name: "Prashant" }, dup: { id: "e-pk", name: "Prashant Kumar" },
  clashes: [] as { period: string; keep_net: number; dup_net: number; keep_gross: number; dup_gross: number }[],
  moved: { salary: 2, attendance: 0, leave: 1, login: 0 }, left: { salary: 0, attendance: 0 },
  renamed: { advances: 1 }, fields: ["phone"], dry_run: true,
};

beforeEach(() => { mutate.mockClear(); previewArgs.length = 0; preview.current = base; });
afterEach(cleanup);

describe("R-2380 MergeEmployeeDialog", () => {
  it("pre-picks the employee with the same first name and shows what moves", () => {
    render(<MergeEmployeeDialog employee={prashantKumar} employees={all} onClose={() => {}} />);
    expect((screen.getByLabelText(/^Employee to keep/) as HTMLSelectElement).value).toBe("e-p");
    expect(previewArgs.at(-1)).toEqual(["e-p", "e-pk"]);
    expect(screen.getByText(/2 salary records, 1 leave entry, 1 advance \/ loan/)).toBeTruthy();
    expect(screen.getByText(/Fills empty on Prashant: phone/)).toBeTruthy();
    // the duplicate itself is not offered as the one to keep
    expect(screen.queryByRole("option", { name: /Prashant Kumar/ })).toBeNull();
  });

  it("Merge calls the RPC hook once with keep / duplicate / keepBoth=false", () => {
    const onClose = vi.fn();
    render(<MergeEmployeeDialog employee={prashantKumar} employees={all} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Merge into Prashant" }));
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0][0]).toEqual({ keepId: "e-p", dupId: "e-pk", keepBoth: false });
  });

  it("no guess → nothing picked and Merge disabled", () => {
    render(<MergeEmployeeDialog employee={asha} employees={[asha, prashant]} onClose={() => {}} />);
    expect((screen.getByLabelText(/^Employee to keep/) as HTMLSelectElement).value).toBe("");
    expect((screen.getByRole("button", { name: "Merge" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("same-month salary on both blocks the merge until Keep both is ticked", () => {
    preview.current = { ...base, clashes: [{ period: "2026-07", keep_net: 20000, dup_net: 5000, keep_gross: 20000, dup_gross: 5000 }] };
    render(<MergeEmployeeDialog employee={prashantKumar} employees={all} onClose={() => {}} />);
    expect(screen.getByText(/Both have a salary for Jul 2026 \(₹5,000 here, ₹20,000 on Prashant\)/)).toBeTruthy();
    const btn = screen.getByRole("button", { name: "Merge into Prashant" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: /Keep both — they are different payments/ }));
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    expect(mutate.mock.calls[0][0]).toEqual({ keepId: "e-p", dupId: "e-pk", keepBoth: true });
  });

  it("helpers: month label and first-name guess", () => {
    expect(monthLabel("2026-08")).toBe("Aug 2026");
    expect(guessKeep(prashantKumar, [prashant, asha])).toBe("e-p");
    expect(guessKeep(prashantKumar, [prashant, { ...asha, name: "Prashant S" }])).toBeNull();
  });
});
