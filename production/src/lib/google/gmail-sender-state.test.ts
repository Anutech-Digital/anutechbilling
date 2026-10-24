/**
 * R-1425 — choosing Gmail as the sender when Google is not ready: a calm notice that names
 * what is missing and the next step, never a raw 409.
 */
import { describe, it, expect } from "vitest";
import { gmailChoiceBlocker, gmailNoticeForSaveError } from "./gmail-sender-state";

const CONNECT = "/api/integrations/google-gmail/connect";

describe("gmailChoiceBlocker — before any PATCH", () => {
  it("server has no Google client → not available yet, no Connect button", () => {
    const n = gmailChoiceBlocker({ googleConfigured: false, gmail: { canSend: false, email: null } });
    expect(n?.kind).toBe("not_available");
    expect(n?.text).toMatch(/not available on this server yet/i);
    expect(n?.connectHref).toBeNull();
  });

  it("configured but not connected → connect Google first, with Connect", () => {
    const n = gmailChoiceBlocker({ googleConfigured: true, gmail: { canSend: false, email: null } });
    expect(n?.kind).toBe("connect_first");
    expect(n?.text).toMatch(/connect google first/i);
    expect(n?.connectHref).toBe(CONNECT);
  });

  it("connected without send permission → reconnect, with Connect", () => {
    const n = gmailChoiceBlocker({ googleConfigured: true, gmail: { canSend: false, email: "a@b.in" } });
    expect(n?.kind).toBe("reconnect");
    expect(n?.connectHref).toBe(CONNECT);
  });

  it("ready to send → no blocker (connected state unchanged)", () => {
    expect(gmailChoiceBlocker({ googleConfigured: true, gmail: { canSend: true, email: "a@b.in" } })).toBeNull();
  });

  it("older server without googleConfigured → treated as configured", () => {
    expect(gmailChoiceBlocker({ gmail: { canSend: true, email: "a@b.in" } })).toBeNull();
    expect(gmailChoiceBlocker({ gmail: { canSend: false, email: null } })?.kind).toBe("connect_first");
  });
});

describe("gmailNoticeForSaveError — the server's 409 mapped to the same notices", () => {
  it.each([
    ["google_not_configured", "not_available"],
    ["google_not_connected", "connect_first"],
    ["google_send_scope_missing", "reconnect"],
  ])("%s → %s", (code, kind) => {
    expect(gmailNoticeForSaveError(409, { code })?.kind).toBe(kind);
  });

  it("a 409 without a code (older server) → connect first", () => {
    expect(gmailNoticeForSaveError(409, { error: "x" })?.kind).toBe("connect_first");
  });

  it("other statuses are not Google setup states", () => {
    expect(gmailNoticeForSaveError(500, { code: "google_not_connected" })).toBeNull();
    expect(gmailNoticeForSaveError(403, {})).toBeNull();
  });
});
