/**
 * R-160 — "Connect Google (email)" failed for a second tenant and nothing on screen said why.
 *
 * The bug, measured 7 Oct 2026: the Gmail callback redirects to
 * /settings?tab=integrations&gmail=<outcome>, but NO screen ever read `gmail=` — every
 * failure (denied, expired state, missing send box, keys not set, Google token error)
 * landed the user back on Settings looking exactly like nothing happened. Contacts, Ads and
 * Business Profile all show their result; Gmail alone was silent.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  GMAIL_CONNECT_OUTCOMES, gmailConnectMessage, parseGmailConnectOutcome,
  outcomeFromGoogleError, outcomeFromExchangeError,
} from "./gmail-connect-result";

const src = (...p: string[]) =>
  readFileSync(join(process.cwd(), ...p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("every outcome the callback can send has a clear message", () => {
  it("callback only emits known outcomes", () => {
    const cb = src("src", "app", "api", "integrations", "google-gmail", "callback", "route.ts");
    const connect = src("src", "app", "api", "integrations", "google-gmail", "connect", "route.ts");
    const used = [...`${cb}\n${connect}`.matchAll(/gmail=([a-z_]+)/g)].map((m) => m[1]);
    for (const o of used) expect(GMAIL_CONNECT_OUTCOMES, o).toContain(o);
  });

  it.each(GMAIL_CONNECT_OUTCOMES)("%s: plain sentence, no codes or JSON", (o) => {
    const m = gmailConnectMessage(o);
    expect(m.text.length).toBeGreaterThan(20);
    for (const leak of ["{", "invalid_grant", "invalid_client", "GOCSPX", "client_secret"]) {
      expect(m.text).not.toContain(leak);
    }
  });

  it("only the connected outcome counts as ok", () => {
    expect(gmailConnectMessage("connected").kind).toBe("ok");
    expect(gmailConnectMessage("denied").kind).toBe("error");
    expect(gmailConnectMessage("connected_scopelost").kind).toBe("warn");
  });

  it("config problems say an admin must act, user problems say connect again", () => {
    expect(gmailConnectMessage("redirect_mismatch").text).toMatch(/admin/i);
    expect(gmailConnectMessage("client_rejected").text).toMatch(/admin/i);
    expect(gmailConnectMessage("notconfigured").text).toMatch(/admin/i);
    expect(gmailConnectMessage("admin_blocked").text).toMatch(/Workspace admin/i);
    expect(gmailConnectMessage("badstate").text).toMatch(/Connect again/i);
    expect(gmailConnectMessage("code_expired").text).toMatch(/Connect again/i);
  });
});

describe("parseGmailConnectOutcome", () => {
  it("accepts known values and rejects anything else", () => {
    expect(parseGmailConnectOutcome("denied")).toBe("denied");
    expect(parseGmailConnectOutcome(null)).toBeNull();
    expect(parseGmailConnectOutcome("<script>")).toBeNull();
  });
});

describe("Google's own error codes are kept, not flattened to 'denied'", () => {
  it.each([
    ["access_denied", "denied"],
    ["admin_policy_enforced", "admin_blocked"],
    ["org_internal", "admin_blocked"],
    ["something_new", "google_error"],
  ] as const)("%s → %s", (code, want) => {
    expect(outcomeFromGoogleError(code)).toBe(want);
  });
});

describe("token exchange failures are classified from Google's body", () => {
  it.each([
    ['Google token exchange failed: 400 {"error":"redirect_uri_mismatch"}', "redirect_mismatch"],
    ['Google token exchange failed: 401 {"error":"invalid_client"}', "client_rejected"],
    ['Google token exchange failed: 401 {"error":"unauthorized_client"}', "client_rejected"],
    ['Google token exchange failed: 400 {"error":"invalid_grant"}', "code_expired"],
    ["fetch failed", "error"],
  ] as const)("%s → %s", (msg, want) => {
    expect(outcomeFromExchangeError(new Error(msg))).toBe(want);
  });
});

describe("the Settings email card shows the outcome (the actual R-160 bug)", () => {
  it("email-sending-card reads gmail= and renders the message", () => {
    const card = src("src", "components", "features", "integrations", "email-sending-card.tsx");
    expect(card).toContain("parseGmailConnectOutcome(");
    expect(card).toContain("gmailConnectMessage(");
  });

  it("callback passes Google's error code through and separates save from exchange", () => {
    const cb = src("src", "app", "api", "integrations", "google-gmail", "callback", "route.ts");
    expect(cb).toContain("outcomeFromGoogleError(");
    expect(cb).toContain("outcomeFromExchangeError(");
    expect(cb).toContain("save_failed");
    expect(cb).toContain("notenant");
  });
});
