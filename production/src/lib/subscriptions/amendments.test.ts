import { describe, it, expect } from "vitest";
import { describeAmendment, amendmentActor, seatHistory, seatHistoryReconciles } from "./amendments";
import type { ContractAmendment } from "@/lib/supabase/database.types";

const amend = (over: Partial<ContractAmendment> = {}): ContractAmendment => ({
  id: "a1", tenant_id: "t1", subscription_id: "s1", customer_name: "Acme",
  kind: "seats_added", changes: {}, seats_from: null, seats_to: null,
  mrr_from: null, mrr_to: null, changed_by: null, source: "user",
  note: null, created_at: "2026-08-16T10:00:00Z",
  ...over,
});

describe("describeAmendment", () => {
  it("reads seats as a movement with the delta", () => {
    const lines = describeAmendment(amend({ changes: { seats: { from: 10, to: 30 } } }));
    expect(lines).toEqual([{ text: "Seats: 10 → 30 (+20)", tone: "increase" }]);
  });

  it("uses a minus sign for a reduction", () => {
    const lines = describeAmendment(amend({ changes: { seats: { from: 30, to: 10 } } }));
    expect(lines[0].text).toBe("Seats: 30 → 10 (−20)");
    expect(lines[0].tone).toBe("decrease");
  });

  it("formats money in rupees, Indian grouping", () => {
    const lines = describeAmendment(amend({ changes: { mrr: { from: 2700, to: 810000 } } }));
    expect(lines[0].text).toBe("Monthly price: ₹2,700 → ₹8,10,000");
  });

  it("colours only the status changes worth noticing", () => {
    expect(describeAmendment(amend({ changes: { status: { from: "active", to: "paused" } } }))[0].tone).toBe("warning");
    expect(describeAmendment(amend({ changes: { status: { from: "paused", to: "active" } } }))[0].tone).toBe("neutral");
  });

  it("handles several fields in one amendment", () => {
    const lines = describeAmendment(amend({
      changes: { seats: { from: 10, to: 30 }, mrr: { from: 2700, to: 8100 } },
    }));
    expect(lines).toHaveLength(2);
  });

  it("labels a field it has no label for rather than dropping it", () => {
    const lines = describeAmendment(amend({ changes: { something_new: { from: "a", to: "b" } } }));
    expect(lines[0].text).toBe("something_new: a → b");
  });

  it("renders empty and null values as a dash, never as 'null'", () => {
    const lines = describeAmendment(amend({ changes: { plan: { from: null, to: "" } } }));
    expect(lines[0].text).toBe("Plan: — → —");
    expect(lines[0].text).not.toMatch(/null|undefined/);
  });

  it("returns nothing for an empty change set", () => {
    expect(describeAmendment(amend())).toEqual([]);
  });

  it("NEVER invents a reason — it states what moved, not why", () => {
    /* The trigger sees 10 → 30. It cannot know whether that was an approved request,
       a typo correction, or a mistake. In a dispute that difference is the point. */
    const lines = describeAmendment(amend({ changes: { seats: { from: 10, to: 30 } } }));
    for (const l of lines) {
      expect(l.text).not.toMatch(/customer|requested|approved|upgrade|because/i);
    }
  });
});

describe("amendmentActor", () => {
  it("names an automatic change as automatic rather than leaving it blank", () => {
    /* An unattributed change reads as hidden; "automatic" reads as explainable. */
    expect(amendmentActor(amend({ source: "system" }))).toMatch(/Automatic/);
  });

  it("resolves a user id to a name when one is available", () => {
    const names = new Map([["u1", "Pardeep Sharma"]]);
    expect(amendmentActor(amend({ source: "user", changed_by: "u1" }), names)).toBe("Pardeep Sharma");
  });

  it("falls back without pretending to know who", () => {
    expect(amendmentActor(amend({ source: "user", changed_by: "u9" }), new Map())).toBe("A team member");
    expect(amendmentActor(amend({ source: "user", changed_by: null }))).toBe("Unknown");
  });

  it("names a portal customer from actor_label when changed_by is null (R-326)", () => {
    expect(amendmentActor({ ...amend({ source: "user", changed_by: null }), actor_label: "Customer X" })).toBe("Customer X");
  });

  it("behaves as before when the actor_label column is missing or empty (migration not applied)", () => {
    const row = amend({ source: "user", changed_by: null });
    expect("actor_label" in row).toBe(false);
    expect(amendmentActor(row)).toBe("Unknown");
    expect(amendmentActor({ ...row, actor_label: null })).toBe("Unknown");
    expect(amendmentActor({ ...row, actor_label: "  " })).toBe("Unknown");
  });

  it("keeps a staff name and the system label ahead of actor_label", () => {
    const names = new Map([["u1", "Pardeep Sharma"]]);
    expect(amendmentActor({ ...amend({ changed_by: "u1" }), actor_label: "Customer X" }, names)).toBe("Pardeep Sharma");
    expect(amendmentActor({ ...amend({ source: "system" }), actor_label: "Customer X" })).toMatch(/Automatic/);
  });
});

describe("seatHistory", () => {
  const rows = [
    amend({ id: "b", created_at: "2026-06-01T00:00:00Z", seats_from: 10, seats_to: 20 }),
    amend({ id: "a", created_at: "2026-05-01T00:00:00Z", seats_from: 5,  seats_to: 10 }),
    amend({ id: "c", created_at: "2026-07-01T00:00:00Z", seats_from: 20, seats_to: 30, source: "system" }),
    amend({ id: "d", created_at: "2026-07-15T00:00:00Z", changes: { plan: { from: "x", to: "y" } } }),
  ];

  it("is oldest first — the question is how we got here", () => {
    expect(seatHistory(rows).map((h) => h.to)).toEqual([10, 20, 30]);
  });

  it("ignores amendments that did not touch seats", () => {
    expect(seatHistory(rows)).toHaveLength(3);
  });

  it("carries the delta and the source", () => {
    const last = seatHistory(rows)[2];
    expect(last).toMatchObject({ from: 20, to: 30, delta: 10, source: "system" });
  });

  it("does not mutate its input", () => {
    const before = rows.map((r) => r.id);
    seatHistory(rows);
    expect(rows.map((r) => r.id)).toEqual(before);
  });

  it("is empty when nothing touched seats", () => {
    expect(seatHistory([amend()])).toEqual([]);
  });
});

describe("seatHistoryReconciles", () => {
  const rows = [
    amend({ created_at: "2026-05-01T00:00:00Z", seats_from: 5,  seats_to: 10 }),
    amend({ created_at: "2026-06-01T00:00:00Z", seats_from: 10, seats_to: 30 }),
  ];

  it("agrees when the ledger's last value matches the subscription", () => {
    expect(seatHistoryReconciles(rows, 30)).toBe(true);
  });

  it("DISAGREES when seats moved without the trigger seeing it", () => {
    /* That should be impossible, which is exactly why it is worth checking rather
       than trusting. */
    expect(seatHistoryReconciles(rows, 45)).toBe(false);
  });

  it("returns null when there is no history to check against", () => {
    expect(seatHistoryReconciles([], 10)).toBeNull();
  });
});
