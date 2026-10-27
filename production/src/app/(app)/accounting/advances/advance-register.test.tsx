// @vitest-environment jsdom
/* R-1872 — the advance register: Ramesh (₹10,000 given, ₹6,500 bills, ₹3,500 returned) shows
   balance ₹0; Suresh's ₹900 out since 1 Sep is under "Open > 30 days"; CSV = the rows shown. */
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const downloadCSV = vi.fn();
vi.mock("@/lib/csv", () => ({ downloadCSV: (...a: unknown[]) => downloadCSV(...a) }));
vi.mock("@/lib/dates/ist", () => ({ istToday: () => "2026-10-24" }));

import { AdvanceRegister } from "./advance-register";

const advances = [
  { id: "a", employee_name: "Ramesh Kumar", status: "closed" as const, remaining_balance: 0, disbursed_date: "2026-10-01",
    disbursed_amount: 6500, total_spent: 6500, notes: "Office expenses\nSettled on 09 Oct 2026 · ₹3500 returned" },
  { id: "b", employee_name: "Suresh Pal", status: "active" as const, remaining_balance: 900, disbursed_date: "2026-09-01",
    disbursed_amount: 900, total_spent: 0, notes: null },
];

afterEach(cleanup);

describe("R-1872 advance register", () => {
  it("shows given / spent / returned / balance per employee", () => {
    render(<AdvanceRegister advances={advances} />);
    const ramesh = screen.getByRole("rowheader", { name: "Ramesh Kumar" }).closest("tr")!;
    expect(ramesh.textContent).toContain("₹10,000");
    expect(ramesh.textContent).toContain("₹6,500");
    expect(ramesh.textContent).toContain("₹3,500");
    expect(ramesh.textContent).toContain("₹0");
  });

  it("Open > 30 days keeps only Suresh (53 days); CSV exports what is shown", () => {
    render(<AdvanceRegister advances={advances} />);
    fireEvent.click(screen.getByRole("button", { name: "Open > 30 days (1)" }));
    expect(screen.queryByRole("rowheader", { name: "Ramesh Kumar" })).toBeNull();
    expect(screen.getByRole("rowheader", { name: "Suresh Pal" }).closest("tr")!.textContent).toContain("53");
    fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    expect(downloadCSV).toHaveBeenCalledWith("advance-register-2026-10-24.csv",
      ["Employee", "Given", "Spent (bills)", "Returned", "Balance", "Days outstanding", "Advances"],
      [["Suresh Pal", 900, 0, 0, 900, 53, 1]]);
  });
});
