import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  creditNoteDeadline, isCreditNoteLate, creditNoteDeadlineWarning, countLateCreditNotes,
} from "./credit-note-deadline";

describe("R-335 credit note s.34 deadline", () => {
  it("is 30 Nov after the end of the invoice's financial year", () => {
    expect(creditNoteDeadline("2025-04-01")).toBe("2026-11-30"); // FY 2025-26 starts
    expect(creditNoteDeadline("2026-03-31")).toBe("2026-11-30"); // FY 2025-26 last day
    expect(creditNoteDeadline("2026-04-01")).toBe("2027-11-30"); // FY 2026-27
    expect(creditNoteDeadline("2025-02-15")).toBe("2025-11-30"); // FY 2024-25
  });

  it("warns only after the deadline, not on or before it", () => {
    expect(creditNoteDeadlineWarning("2025-02-15", "2025-11-29")).toBeNull();
    expect(creditNoteDeadlineWarning("2025-02-15", "2025-11-30")).toBeNull(); // last day still in time
    const w = creditNoteDeadlineWarning("2025-02-15", "2025-12-01");
    expect(w).toMatch(/s\.34/);
    expect(w).toMatch(/30 Nov 2025/);
    expect(w).toMatch(/annual return/);
    expect(w).toMatch(/CA/);
  });

  it("does not warn for a current-year invoice or a missing date", () => {
    expect(creditNoteDeadlineWarning("2026-09-01", "2026-10-07")).toBeNull();
    expect(creditNoteDeadlineWarning(null, "2030-01-01")).toBeNull();
    expect(isCreditNoteLate("2025-02-15", null)).toBe(false);
  });

  it("counts late credit notes", () => {
    expect(countLateCreditNotes([
      { invoiceDate: "2025-02-15", noteDate: "2025-12-01" }, // late
      { invoiceDate: "2025-02-15", noteDate: "2025-11-30" }, // in time
      { invoiceDate: "2026-05-01", noteDate: "2026-10-07" }, // in time
      { invoiceDate: null, noteDate: "2030-01-01" },          // unknown — not counted
    ])).toBe(1);
  });

  it("the issue dialog shows the warning but never blocks the issue (CA decides)", () => {
    const src = readFileSync(join(process.cwd(), "src/components/features/invoices/issue-credit-note-dialog.tsx"), "utf8");
    expect(src).toMatch(/creditNoteDeadlineWarning\(/);
    expect(src).toMatch(/istToday\(/);
    // The submit guard is only the amount check — no early return on the late warning.
    expect(src).not.toMatch(/if \(lateWarning[^)]*\)\s*\{?\s*(toast|return)/);
  });

  it("the GST report counts late credit notes", () => {
    const src = readFileSync(join(process.cwd(), "src/app/(app)/accounting/gst/page.tsx"), "utf8");
    expect(src).toMatch(/isCreditNoteLate\(/);
    expect(src).toMatch(/lateCreditNotes/);
  });
});
