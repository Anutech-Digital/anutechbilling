import { describe, expect, it } from "vitest";
import { resellerCardState, resellerReturnPath, RESELLER_OAUTH_MESSAGES } from "./reseller-connect";

describe("R-824 Settings → Google Reseller card", () => {
  it("connected → no Connect button", () => {
    expect(resellerCardState({ connected: true })).toMatchObject({ connected: true, showConnect: false, text: "Connected · live sync ready" });
  });

  it("each probe code → one plain-English line, Connect where it helps", () => {
    expect(resellerCardState({ code: "not_connected" })).toMatchObject({ text: "Connect Google Reseller to see subscriptions", showConnect: true });
    expect(resellerCardState({ code: "missing_scope" })).toMatchObject({ text: "Connect Google Reseller to see subscriptions", showConnect: true });
    expect(resellerCardState({ code: "needs_reauth" })).toMatchObject({ text: "Google needs you to sign in again", showConnect: true, connectLabel: "Reconnect" });
    expect(resellerCardState({ code: "api_disabled" })).toMatchObject({ text: "The Reseller API is turned off in Google Cloud", showConnect: false });
    expect(resellerCardState(undefined)).toMatchObject({ showConnect: true });
  });

  it("the OAuth round-trip always lands on Settings → Integrations with a known status", () => {
    expect(resellerReturnPath("connected")).toBe("/settings?tab=integrations&greseller=connected");
    for (const s of ["connected", "denied", "noscope", "badstate", "role", "notconfigured", "error", "connected_scopelost"]) {
      expect(RESELLER_OAUTH_MESSAGES[s]?.text).toBeTruthy();
    }
  });
});

describe("R-1425 — Google not set up on this server is a calm state, not an error", () => {
  it("not_configured → 'not available on this server yet', no Connect", () => {
    const s = resellerCardState({ code: "not_configured" });
    expect(s).toMatchObject({ showConnect: false, notAvailable: true });
    expect(s.text).toMatch(/not available on this server yet/i);
  });

  it("not connected but the server has no Google client → no Connect button that would fail", () => {
    expect(resellerCardState({ code: "not_connected", connectAvailable: false })).toMatchObject({ showConnect: false, notAvailable: true });
    expect(resellerCardState({ code: "needs_reauth", connectAvailable: false })).toMatchObject({ showConnect: false, notAvailable: true });
  });

  it("connected state unchanged even if the connect client is missing (sign-in session token works)", () => {
    expect(resellerCardState({ connected: true, connectAvailable: false })).toMatchObject({ connected: true, showConnect: false, text: "Connected · live sync ready" });
  });

  it("the ?greseller=notconfigured landing is not an error toast", () => {
    expect(RESELLER_OAUTH_MESSAGES.notconfigured.tone).toBe("calm");
    expect(RESELLER_OAUTH_MESSAGES.notconfigured.text).toMatch(/not available on this server yet/i);
    expect(RESELLER_OAUTH_MESSAGES.denied.tone).toBe("error");
    expect(RESELLER_OAUTH_MESSAGES.connected.tone).toBe("ok");
  });
});
