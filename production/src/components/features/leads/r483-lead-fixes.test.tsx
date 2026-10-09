// @vitest-environment jsdom
// R-483: R-457 (bulk Won), R-459 (follow-up date in the drawer), R-444 (3) (Log call keeps the note).
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { planBulkStage, BULK_WON_REFUSAL } from "./bulk-stage";
import { leadDateFollowUp } from "./lead-detail-followups-tab";
import { CallLogDialog } from "./call-log-dialog";

afterEach(cleanup);

const lead = (id: string, stage: "new" | "contact" | "quote" | "won", extra: Partial<{ value: number; expected_close_date: string }> = {}) =>
  ({ id, stage, company: id, value: extra.value ?? null, expected_close_date: extra.expected_close_date ?? null });

describe("R-457 — bulk stage change", () => {
  it("Won is never applied in bulk, and says how a lead is won", () => {
    const p = planBulkStage([lead("Kumar Pharma", "contact"), lead("Mehta", "quote", { value: 1, expected_close_date: "2026-12-01" })], "won");
    expect(p.move).toHaveLength(0);
    expect(p.refused).toHaveLength(2);
    expect(p.reason?.title).toBe(BULK_WON_REFUSAL.title);
  });
  it("Lost and Contacted still move; a pre-quote lead can't jump to a deal stage", () => {
    expect(planBulkStage([lead("A", "new"), lead("B", "contact")], "lost").move).toHaveLength(2);
    const p = planBulkStage([lead("A", "new"), lead("B", "quote")], "demo");
    expect(p.move.map((l) => l.id)).toEqual(["B"]);
    expect(p.refused.map((l) => l.id)).toEqual(["A"]);
    expect(p.reason?.title).toMatch(/Send a quote first/);
  });
  it("leads already at the stage are skipped silently", () => {
    expect(planBulkStage([lead("A", "contact")], "contact")).toEqual({ move: [], refused: [], reason: null });
  });
});

describe("R-459 — the lead's follow-up date shows in the Follow-ups tab", () => {
  it("shows the date when no open task covers it", () => {
    expect(leadDateFollowUp("2026-10-10", [], "2026-10-09")).toEqual({ label: "10 Oct 2026", overdue: false });
    expect(leadDateFollowUp("2026-10-08", [], "2026-10-09")?.overdue).toBe(true);
  });
  it("hidden when a task is due that same IST day, or there is no date", () => {
    expect(leadDateFollowUp("2026-10-10", [{ due_at: "2026-10-10T04:30:00Z" }], "2026-10-09")).toBeNull();
    expect(leadDateFollowUp(null, [], "2026-10-09")).toBeNull();
  });
});

describe("R-444 (3) — Log call starts with the note already typed", () => {
  it("the popup opens with the drawer's note", () => {
    render(<CallLogDialog companyName="Gupta Traders" initialNote="Asked for 15 seats price" onClose={vi.fn()} onSave={vi.fn()} />);
    expect(screen.getByDisplayValue("Asked for 15 seats price")).toBeTruthy();
  });
});
