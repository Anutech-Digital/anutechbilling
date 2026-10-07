import { describe, it, expect } from "vitest";
import {
  AGENT_CARD_RE,
  agentClaim,
  isAutoSendOn,
  isJunkReport,
  isMissingColumnError,
  shouldAutoDispatch,
} from "./auto-send";

const fresh = {
  status: "open",
  dispatchedAt: null,
  triagedAtBefore: null,
  title: "Invoice PDF not opening",
  body: "Invoice PDF not opening on the invoices page, spinner forever",
};

describe("R-357 auto-send helpers", () => {
  it("switch is ON by default, also before the migration adds the column", () => {
    expect(isAutoSendOn(null)).toBe(true);
    expect(isAutoSendOn({ id: "t" })).toBe(true);
    expect(isAutoSendOn({ feedback_auto_send: null })).toBe(true);
    expect(isAutoSendOn({ feedback_auto_send: true })).toBe(true);
    expect(isAutoSendOn({ feedback_auto_send: false })).toBe(false);
  });

  it("sends a fresh, open, real report", () => {
    expect(shouldAutoDispatch(fresh)).toBe(true);
  });

  it("does not send a re-triage, a dispatched, a closed or a junk report", () => {
    expect(shouldAutoDispatch({ ...fresh, triagedAtBefore: "2026-10-01T00:00:00Z" })).toBe(false);
    expect(shouldAutoDispatch({ ...fresh, dispatchedAt: "2026-10-01T00:00:00Z" })).toBe(false);
    expect(shouldAutoDispatch({ ...fresh, status: "duplicate" })).toBe(false);
    expect(shouldAutoDispatch({ ...fresh, status: "fixed" })).toBe(false);
    expect(shouldAutoDispatch({ ...fresh, body: "test", title: "test" })).toBe(false);
  });

  it("junk = tester poking the box; Hinglish reports are not junk", () => {
    for (const j of ["test", "Testing!!", "asdf", "hi", "ok", "...", "123", "  "]) expect(isJunkReport(j)).toBe(true);
    expect(isJunkReport("button kaam nahi kar raha")).toBe(false);
    expect(isJunkReport("test invoice total galat hai")).toBe(false);
  });

  it("card id shape", () => {
    expect(AGENT_CARD_RE.test("R-357")).toBe(true);
    for (const bad of ["r-357", "R-", "R-357; drop", "X-1", "R-123456"]) expect(AGENT_CARD_RE.test(bad)).toBe(false);
  });

  it("reads a claim only when both columns are set", () => {
    expect(agentClaim({})).toBeNull();
    expect(agentClaim({ agent_card: "R-1", agent_claimed_at: null })).toBeNull();
    expect(agentClaim({ agent_card: "R-1", agent_claimed_at: "2026-10-07T00:00:00Z" })).toEqual({ card: "R-1", claimedAt: "2026-10-07T00:00:00Z" });
  });

  it("recognises a missing-column error", () => {
    expect(isMissingColumnError({ code: "PGRST204", message: "x" })).toBe(true);
    expect(isMissingColumnError({ code: "42703", message: "x" })).toBe(true);
    expect(isMissingColumnError({ code: null, message: "Could not find the 'agent_card' column of 'feedback' in the schema cache" })).toBe(true);
    expect(isMissingColumnError({ code: "23505", message: "duplicate key" })).toBe(false);
    expect(isMissingColumnError(null)).toBe(false);
  });
});
