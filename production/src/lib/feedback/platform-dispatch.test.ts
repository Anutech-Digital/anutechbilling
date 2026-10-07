import { describe, it, expect } from "vitest";
import { canQueue, queuePatch, dispatchSummary, platformDispatchBody } from "./platform-dispatch";

describe("R-366 platform-dispatch helpers", () => {
  it("canQueue: only open + never dispatched", () => {
    expect(canQueue({ status: "open", dispatched_at: null })).toBe(true);
    expect(canQueue({ status: "open", dispatched_at: "2026-10-07T05:00:00Z" })).toBe(false);
    expect(canQueue({ status: "agent_queued", dispatched_at: null })).toBe(false);
    expect(canQueue(null)).toBe(false);
  });

  it("queuePatch writes only the four R-357 columns", () => {
    expect(queuePatch("u1", "T")).toEqual({ status: "agent_queued", dispatched_at: "T", dispatched_by: "u1", updated_at: "T" });
  });

  it("body: id or all, nothing else", () => {
    expect(platformDispatchBody.safeParse({ all: true }).success).toBe(true);
    expect(platformDispatchBody.safeParse({ id: "11111111-1111-4111-8111-111111111111" }).success).toBe(true);
    expect(platformDispatchBody.safeParse({ all: false }).success).toBe(false);
    expect(platformDispatchBody.safeParse({ tenant_id: "t" }).success).toBe(false);
  });

  it("summary text", () => {
    expect(dispatchSummary(0, 0)).toBe("No open reports to send.");
    expect(dispatchSummary(0, 1)).toBe("Already with the AI — nothing to send.");
    expect(dispatchSummary(2, 1)).toBe("2 reports sent to the AI worker · 1 already with the AI");
  });
});
