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
