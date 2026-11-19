// @vitest-environment jsdom
/* R-2931 — the month grid: each task sits on its due day; pressing a day picks it; a task
   dropped on another day asks for the move. */
import * as React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { MonthGrid, MAX_CHIPS } from "./month-grid";
import { tasksByDay } from "./calendar-grid";

afterEach(() => cleanup());

const now = new Date("2026-11-18T06:30:00Z"); // 18 Nov 12:00 IST
const t = (id: string, title: string, due_at: string, status: "pending" | "done" = "pending") =>
  ({ id, title, due_at, status });

const tasks = [
  t("a", "Call Amit", "2026-11-18T09:30:00Z"),
  t("b", "Send quote to Ravi", "2026-11-20T05:00:00Z"),
  t("c", "Old follow-up", "2026-11-10T05:00:00Z"),
  t("d", "Paid invoice check", "2026-11-12T05:00:00Z", "done"),
];

function setup(extra: typeof tasks = []) {
  const onSelectDay = vi.fn();
  const onMoveTask = vi.fn();
  render(
    <MonthGrid month="2026-11" byDay={tasksByDay([...tasks, ...extra])} selectedDay="2026-11-18" now={now}
      onSelectDay={onSelectDay} onMoveTask={onMoveTask} />,
  );
  return { onSelectDay, onMoveTask };
}
const cell = (day: string) => screen.getByTestId(`day-${day}`);
const toneOf = (day: string, title: string) =>
  within(cell(day)).getByText(title).closest("[data-tone]")!.getAttribute("data-tone");

describe("R-2931 MonthGrid", () => {
  it("shows each task's name on its due day, coloured by state", () => {
    setup();
    expect(within(cell("2026-11-18")).getByText("Call Amit")).toBeTruthy();
    expect(within(cell("2026-11-20")).getByText("Send quote to Ravi")).toBeTruthy();
    expect(within(cell("2026-11-19")).queryByText("Call Amit")).toBeNull();
    expect(toneOf("2026-11-10", "Old follow-up")).toBe("overdue");
    expect(toneOf("2026-11-12", "Paid invoice check")).toBe("done");
    expect(toneOf("2026-11-18", "Call Amit")).toBe("today");
    expect(toneOf("2026-11-20", "Send quote to Ravi")).toBe("upcoming");
  });

  it("pressing a day picks it; the picked day and today are marked", () => {
    const { onSelectDay } = setup();
    fireEvent.click(screen.getByRole("button", { name: "20 Nov 2026, 1 task" }));
    expect(onSelectDay).toHaveBeenCalledWith("2026-11-20");
    const today = screen.getByRole("button", { name: "18 Nov 2026, today, 1 task" });
    expect(today.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "19 Nov 2026, no tasks" }).getAttribute("aria-pressed")).toBe("false");
    // a click anywhere in the cell (on a task name too) picks the day
    fireEvent.click(within(cell("2026-11-10")).getByText("Old follow-up"));
    expect(onSelectDay).toHaveBeenLastCalledWith("2026-11-10");
  });

  it("a crowded day shows the first few and counts the rest", () => {
    setup(Array.from({ length: 5 }, (_, i) => t(`x${i}`, `Extra ${i}`, `2026-11-25T0${i}:00:00Z`)));
    const day = cell("2026-11-25");
    expect(within(day).getAllByTestId("task-chip")).toHaveLength(MAX_CHIPS);
    expect(within(day).getByText(`+${5 - MAX_CHIPS} more`)).toBeTruthy();
  });

  it("dropping an open task on another day asks for the move; a done task cannot be dragged", () => {
    const { onMoveTask } = setup();
    const chip = within(cell("2026-11-18")).getByText("Call Amit").closest("[data-tone]") as HTMLElement;
    expect(chip.getAttribute("draggable")).toBe("true");
    const store: Record<string, string> = {};
    const dataTransfer = { setData: (k: string, v: string) => { store[k] = v; }, getData: (k: string) => store[k] ?? "", effectAllowed: "", dropEffect: "" };
    fireEvent.dragStart(chip, { dataTransfer });
    fireEvent.dragOver(cell("2026-11-21"), { dataTransfer });
    fireEvent.drop(cell("2026-11-21"), { dataTransfer });
    expect(onMoveTask).toHaveBeenCalledWith("a", "2026-11-21");
    const done = within(cell("2026-11-12")).getByText("Paid invoice check").closest("[data-tone]") as HTMLElement;
    expect(done.getAttribute("draggable")).toBe("false");
  });
});
