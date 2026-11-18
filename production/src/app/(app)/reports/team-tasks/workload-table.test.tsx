// @vitest-environment jsdom
/* R-2932 — the workload table: one row per person with Open / Overdue / Done this week, and a
   way into that person's tasks. */
import * as React from "react";
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import { WorkloadTable, TrendTable, tasksHref } from "./workload-table";

afterEach(() => cleanup());

const rows = [
  { id: "amit", name: "Amit Shah", open: 3, overdue: 2, doneThisWeek: 1 },
  { id: "bina", name: "bina", open: 0, overdue: 0, doneThisWeek: 4 },
  { id: null, name: "Unassigned", open: 2, overdue: 1, doneThisWeek: 0 },
];
const cellsOf = (id: string) => {
  const row = screen.getByTestId(`workload-${id}`);
  return ["open", "overdue", "done"].map((c) => row.querySelector(`[data-col="${c}"]`)!.textContent);
};

describe("R-2932 WorkloadTable", () => {
  it("shows open / overdue / done-this-week for every row", () => {
    render(<WorkloadTable rows={rows} />);
    for (const h of ["Team member", "Open", "Overdue", "Done this week"]) expect(screen.getByRole("columnheader", { name: h })).toBeTruthy();
    expect(cellsOf("amit")).toEqual(["3", "2", "1"]);
    expect(cellsOf("bina")).toEqual(["0", "0", "4"]);
    expect(cellsOf("unassigned")).toEqual(["2", "1", "0"]);
  });

  it("a person's name and View tasks open the Tasks list filtered to them; overdue opens their Overdue tab", () => {
    render(<WorkloadTable rows={rows} />);
    const amit = within(screen.getByTestId("workload-amit"));
    expect(amit.getByRole("link", { name: "Amit Shah" }).getAttribute("href")).toBe("/tasks?assignee=amit");
    expect(amit.getByRole("link", { name: "View Amit Shah's tasks" }).getAttribute("href")).toBe("/tasks?assignee=amit");
    expect(amit.getByRole("link", { name: /2 overdue/ }).getAttribute("href")).toBe("/tasks?assignee=amit&tab=overdue");
    expect(tasksHref("a b")).toBe("/tasks?assignee=a%20b");
  });

  it("the Unassigned row has no link (there is no such filter on Tasks)", () => {
    render(<WorkloadTable rows={rows} />);
    expect(within(screen.getByTestId("workload-unassigned")).queryAllByRole("link")).toHaveLength(0);
  });
});

describe("R-2932 TrendTable", () => {
  it("lists each week's completed and late counts", () => {
    render(<TrendTable weeks={[
      { start: "2026-11-09", end: "2026-11-15", label: "9 Nov", completed: 5, late: 2 },
      { start: "2026-11-16", end: "2026-11-22", label: "16 Nov", completed: 1, late: 0 },
    ]} />);
    const table = screen.getByTestId("team-trend-table");
    expect(within(table).getByRole("columnheader", { name: "9 Nov" })).toBeTruthy();
    const [completed, late] = within(table).getAllByRole("row").slice(1);
    expect(within(completed).getAllByRole("cell").map((c) => c.textContent)).toEqual(["5", "1"]);
    expect(within(late).getAllByRole("cell").map((c) => c.textContent)).toEqual(["2", "0"]);
  });
});
