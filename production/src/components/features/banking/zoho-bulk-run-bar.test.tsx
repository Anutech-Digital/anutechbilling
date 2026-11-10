// @vitest-environment jsdom
/**
 * R-2535 — the run bar: the preview says "N clean pairs … M need a look"; nothing is booked until
 * the confirm step; "Undo this run" also asks first and shows only when the run holds lines.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ZohoBulkRunBar, ZohoRefusedList } from "./zoho-bulk-run-bar";

const base = {
  preview: { clean: 6, cleanTotal: 70800, needLook: 4 },
  selected: { count: 2, total: 23600 },
  progress: null, disabled: false, booking: false, onDownload: null,
  runId: null as string | null, bookedInRun: 0, undoing: false,
};

describe("R-2535 ZohoBulkRunBar", () => {
  it("shows the preview and books only after the confirm step", () => {
    const onBook = vi.fn();
    render(<ZohoBulkRunBar {...base} onBook={onBook} onUndo={() => {}} />);
    expect(screen.getByText(/6 clean pairs \(paired by UTR, nothing to check\) · 4 need a look · 2 ticked/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Book all clean (6)" }));
    expect(onBook).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toMatch(/Book 6 lines · ₹70,800\?/);
    fireEvent.click(screen.getByRole("button", { name: "Book 6" }));
    expect(onBook).toHaveBeenCalledWith("clean");
  });

  it("Undo this run appears only for a run that holds lines, and asks first", () => {
    const onUndo = vi.fn();
    const { rerender } = render(<ZohoBulkRunBar {...base} onBook={() => {}} onUndo={onUndo} />);
    expect(screen.queryByRole("button", { name: "Undo this run" })).toBeNull();
    rerender(<ZohoBulkRunBar {...base} runId="r1" bookedInRun={3} onBook={() => {}} onUndo={onUndo} />);
    fireEvent.click(screen.getByRole("button", { name: "Undo this run" }));
    expect(onUndo).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toMatch(/The 3 lines go back to unmatched/);
    fireEvent.click(screen.getAllByRole("button", { name: "Undo this run" })[0]);
    expect(onUndo).toHaveBeenCalledTimes(1);
  });

  it("lists the lines the server would not book, with why", () => {
    render(<ZohoRefusedList rows={[{ txnId: "a", txnDate: "2025-04-10", credit: 2360, reason: "In a locked month (books lock) — not booked." }]} />);
    expect(screen.getByText(/1 line was not booked/)).toBeTruthy();
    expect(screen.getByText(/locked month/)).toBeTruthy();
  });
});
