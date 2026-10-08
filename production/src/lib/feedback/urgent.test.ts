/**
 * R-397 — "⚡ Urgent" rules: who, which statuses, the label, queue order, and the
 * pre-migration fallback (no urgent_at key → not ready, button hidden).
 */
import { describe, it, expect } from "vitest";
import {
  mayMarkUrgent,
  urgentReady,
  isUrgent,
  canSetUrgent,
  showUrgentToggle,
  urgentPatch,
  urgentQueuePatch,
  urgentLabel,
  urgentFirst,
  urgentToast,
  urgentBody,
} from "./urgent";

describe("R-397 urgent rules", () => {
  it("only owner and manager may mark their own workspace's report", () => {
    expect(mayMarkUrgent("owner")).toBe(true);
    expect(mayMarkUrgent("manager")).toBe(true);
    for (const r of ["sales", "support", "billing", "delivery", "accountant", "", null, undefined]) {
      expect(mayMarkUrgent(r)).toBe(false);
    }
  });

  it("before the migration a row is not ready and the toggle is hidden", () => {
    const row = { id: "f1", status: "open" };
    expect(urgentReady(row)).toBe(false);
    expect(isUrgent(row)).toBe(false);
    expect(showUrgentToggle(row)).toBe(false);
  });

  it("shows the toggle on open, queued and claimed rows; on closed rows only to take it back", () => {
    expect(showUrgentToggle({ status: "open", urgent_at: null })).toBe(true);
    expect(showUrgentToggle({ status: "agent_queued", urgent_at: null })).toBe(true);
    expect(showUrgentToggle({ status: "agent_queued", urgent_at: null, agent_claimed_at: "2026-10-07T06:00:00Z" })).toBe(true);
    expect(showUrgentToggle({ status: "fixed", urgent_at: null })).toBe(false);
    expect(showUrgentToggle({ status: "fixed", urgent_at: "2026-10-07T06:00:00Z" })).toBe(true);
    expect(canSetUrgent("fixed")).toBe(false);
    expect(canSetUrgent("wont_fix")).toBe(false);
  });

  it("patches touch only the urgent columns; open → also queued", () => {
    expect(urgentPatch(true, "u1", "T")).toEqual({ urgent_at: "T", urgent_by: "u1", updated_at: "T" });
    expect(urgentPatch(false, "u1", "T")).toEqual({ urgent_at: null, urgent_by: null, updated_at: "T" });
    expect(urgentQueuePatch("u1", "T")).toEqual({
      status: "agent_queued", dispatched_at: "T", dispatched_by: "u1", urgent_at: "T", urgent_by: "u1", updated_at: "T",
    });
  });

  it("label: ⚡ Urgent · AI worker has it · R-xxx", () => {
    expect(urgentLabel("R-123")).toBe("⚡ Urgent · AI worker has it · R-123");
    expect(urgentLabel(null)).toBe("⚡ Urgent · AI worker has it");
  });

  it("queue order: urgent first (earliest marked first), rest keep their order", () => {
    const rows = [
      { id: "a", urgent_at: null },
      { id: "b", urgent_at: "2026-10-07T09:00:00Z" },
      { id: "c" },
      { id: "d", urgent_at: "2026-10-07T08:00:00Z" },
      { id: "e", urgent_at: null },
    ];
    expect(urgentFirst(rows).map((r) => r.id)).toEqual(["d", "b", "a", "c", "e"]);
  });

  it("body needs a uuid and a boolean", () => {
    expect(urgentBody.safeParse({ id: "11111111-1111-4111-8111-111111111111", urgent: true }).success).toBe(true);
    expect(urgentBody.safeParse({ id: "x", urgent: true }).success).toBe(false);
    expect(urgentBody.safeParse({ id: "11111111-1111-4111-8111-111111111111" }).success).toBe(false);
  });

  it("toast text says what happened", () => {
    expect(urgentToast(true, true)).toMatch(/sent to the AI worker/);
    expect(urgentToast(true, false)).toMatch(/top of the AI worker's queue/);
    expect(urgentToast(false, false)).toBe("No longer urgent.");
  });
});
