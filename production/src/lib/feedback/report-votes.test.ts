/**
 * R-1466 — "+1 / I have this too" on a matching report.
 *  • counts are per report, and "mine" is true only for the caller's own vote;
 *  • toggling adds one vote, toggling again takes it back (never below zero);
 *  • every read and write is pinned to the caller's tenant, and a write to the caller's own user id.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ calls: [] as [string, ...unknown[]][], rows: [] as unknown[], error: null as unknown }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => {
    const builder: Record<string, (...a: unknown[]) => unknown> = {};
    for (const m of ["from", "select", "eq", "in", "insert", "delete"]) {
      builder[m] = (...a: unknown[]) => { h.calls.push([m, ...a]); return builder; };
    }
    (builder as { then?: unknown }).then = (ok: (v: unknown) => void) => ok({ data: h.rows, error: h.error });
    return builder;
  },
}));

import { tallyVotes, toggleTally, fetchReportVotes, saveReportVote, EMPTY_TALLY } from "./report-votes";

beforeEach(() => { h.calls = []; h.rows = []; h.error = null; });

describe("tallyVotes", () => {
  it("counts votes per report and marks the caller's own vote", () => {
    const t = tallyVotes([
      { feedback_id: "a", user_id: "u1" },
      { feedback_id: "a", user_id: "u2" },
      { feedback_id: "b", user_id: "u2" },
    ], "u1");
    expect(t.get("a")).toEqual({ count: 2, mine: true });
    expect(t.get("b")).toEqual({ count: 1, mine: false });
    expect(t.get("c")).toBeUndefined();
  });

  it("without a caller nothing is 'mine'", () => {
    const t = tallyVotes([{ feedback_id: "a", user_id: "u1" }], null);
    expect(t.get("a")).toEqual({ count: 1, mine: false });
  });
});

describe("toggleTally", () => {
  it("+1 adds the caller's vote, pressing again takes it back", () => {
    const on = toggleTally({ count: 2, mine: false });
    expect(on).toEqual({ count: 3, mine: true });
    expect(toggleTally(on)).toEqual({ count: 2, mine: false });
  });

  it("never goes below zero", () => {
    expect(toggleTally({ count: 0, mine: true })).toEqual({ count: 0, mine: false });
    expect(toggleTally(EMPTY_TALLY)).toEqual({ count: 1, mine: true });
  });
});

describe("fetchReportVotes", () => {
  it("reads only this tenant's votes for the listed reports", async () => {
    h.rows = [{ feedback_id: "a", user_id: "u1" }];
    const out = await fetchReportVotes("t1", ["a", "b"]);
    expect(out).toEqual(h.rows);
    expect(h.calls).toContainEqual(["from", "feedback_votes"]);
    expect(h.calls).toContainEqual(["select", "feedback_id, user_id"]);
    expect(h.calls).toContainEqual(["eq", "tenant_id", "t1"]);
    expect(h.calls).toContainEqual(["in", "feedback_id", ["a", "b"]]);
  });

  it("no reports → no read", async () => {
    expect(await fetchReportVotes("t1", [])).toEqual([]);
    expect(h.calls).toEqual([]);
  });

  it("throws when the read fails", async () => {
    h.error = { message: "permission denied" };
    await expect(fetchReportVotes("t1", ["a"])).rejects.toBeTruthy();
  });
});

describe("saveReportVote", () => {
  it("on: inserts one vote row in the caller's tenant under the caller's own id", async () => {
    await saveReportVote({ tenantId: "t1", userId: "u1", feedbackId: "a", on: true });
    expect(h.calls).toContainEqual(["from", "feedback_votes"]);
    expect(h.calls).toContainEqual(["insert", { tenant_id: "t1", feedback_id: "a", user_id: "u1" }]);
    expect(h.calls.some((c) => c[0] === "delete")).toBe(false);
  });

  it("off: deletes only the caller's own vote, pinned to tenant + report + user", async () => {
    await saveReportVote({ tenantId: "t1", userId: "u1", feedbackId: "a", on: false });
    expect(h.calls).toContainEqual(["delete"]);
    expect(h.calls).toContainEqual(["eq", "tenant_id", "t1"]);
    expect(h.calls).toContainEqual(["eq", "feedback_id", "a"]);
    expect(h.calls).toContainEqual(["eq", "user_id", "u1"]);
  });

  it("a second +1 by the same user (unique violation) counts as already voted, not an error", async () => {
    h.error = { code: "23505", message: "duplicate key value" };
    await expect(saveReportVote({ tenantId: "t1", userId: "u1", feedbackId: "a", on: true })).resolves.toBeUndefined();
  });

  it("any other failure throws", async () => {
    h.error = { code: "42501", message: "new row violates row-level security policy" };
    await expect(saveReportVote({ tenantId: "t1", userId: "u1", feedbackId: "a", on: true })).rejects.toBeTruthy();
  });

  it("refuses without a tenant or user (fails closed, nothing sent)", async () => {
    await expect(saveReportVote({ tenantId: "", userId: "u1", feedbackId: "a", on: true })).rejects.toThrow();
    await expect(saveReportVote({ tenantId: "t1", userId: "", feedbackId: "a", on: true })).rejects.toThrow();
    expect(h.calls).toEqual([]);
  });
});
