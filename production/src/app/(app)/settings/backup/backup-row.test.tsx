// @vitest-environment jsdom
/**
 * R-1450 — /settings/backup: a restore point's details (name, date, size) and its
 * Restore / Download / Delete buttons sat too close together. The row now stacks on a
 * phone with a gap-4 between details and buttons, sits side by side from md: up with the
 * same gap-4, and every row button is 44px tall on a phone (h-11), compact from md:.
 */
import * as React from "react";
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";

import { BackupRow, BACKUP_ROW_BUTTON } from "./backup-row";

afterEach(() => cleanup());

function renderRow() {
  return render(
    <BackupRow label="Before restore" kind="manual" meta="16 Oct 2026, 10:00 am · 42 tables · 1.2 MB"
      actions={<>
        <button className={BACKUP_ROW_BUTTON}>Restore</button>
        <button className={BACKUP_ROW_BUTTON}>Download</button>
      </>} />,
  );
}

describe("BackupRow — R-1450 spacing", () => {
  it("shows the details and the actions", () => {
    renderRow();
    expect(screen.getByText("Before restore")).toBeTruthy();
    expect(screen.getByText("Manual")).toBeTruthy();
    expect(screen.getByText(/42 tables/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Restore" })).toBeTruthy();
  });

  it("separates details and buttons with gap-4 — stacked on a phone, side by side from md:", () => {
    renderRow();
    const row = screen.getByTestId("backup-row");
    const cls = row.className.split(/\s+/);
    expect(cls).toContain("flex-col");
    expect(cls).toContain("gap-4");
    expect(cls).toContain("md:flex-row");
    expect(cls).toContain("md:items-center");
    expect(cls).toContain("md:justify-between");
    // details block and actions block are the row's two children
    const actions = screen.getByTestId("backup-row-actions");
    expect(actions.parentElement).toBe(row);
    expect(actions.className.split(/\s+/)).toContain("gap-2");
  });

  it("row buttons are 44px tall on a phone and compact from md:", () => {
    const cls = BACKUP_ROW_BUTTON.split(/\s+/);
    expect(cls).toContain("h-11");
    expect(cls).toContain("md:h-8");
  });
});
