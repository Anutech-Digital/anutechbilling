import { describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  originFromRequest, gmailRedirectUri, contactsRedirectUri, buildAuthUrl,
  GMAIL_SEND_SCOPES, GOOGLE_CONTACTS_SCOPES,
} from "./oauth";

function req(headers: Record<string, string>, url = "http://localhost:3000/x"): NextRequest {
  return new NextRequest(url, { headers });
}

describe("originFromRequest", () => {
  it("uses http for localhost when no proxy header is present", () => {
    // The bug this pins: the https default sent Google
    // https://localhost:3000/... and it answered redirect_uri_mismatch, because
    // the registered URI is http. Invisible on Cloud Run, which always sets
    // x-forwarded-proto — so it only appeared the first time the flow ran
    // locally, after the code had been written and reviewed.
    expect(originFromRequest(req({ host: "localhost:3000" })))
      .toBe("http://localhost:3000");
  });

  it.each(["127.0.0.1:3000", "[::1]:3000"])("treats %s as local too", (host) => {
    expect(originFromRequest(req({ host }))).toBe(`http://${host}`);
  });

  it("keeps https for the app's own host with no proxy header", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.example.com");
    expect(originFromRequest(req({ host: "app.example.com" })))
      .toBe("https://app.example.com");
    vi.unstubAllEnvs();
  });

  it("obeys x-forwarded-proto https for localhost", () => {
    expect(originFromRequest(req({ host: "localhost:3000", "x-forwarded-proto": "https" })))
      .toBe("https://localhost:3000");
  });

  it("prefers an allowlisted x-forwarded-host over host", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://resellersos.run.app");
    expect(originFromRequest(req({
      host: "0.0.0.0:8080",
      "x-forwarded-host": "resellersos.run.app",
      "x-forwarded-proto": "https",
    }))).toBe("https://resellersos.run.app");
    vi.unstubAllEnvs();
  });

  it("R-723: a host that is not allowlisted never becomes the redirect origin", () => {
    // localhost-evil.com is not localhost and not ours: the app URL is used instead.
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.example.com");
    expect(originFromRequest(req({ host: "localhost-evil.com" })))
      .toBe("https://app.example.com");
    expect(originFromRequest(req({ host: "app.example.com", "x-forwarded-host": "evil.tld" })))
      .toBe("https://app.example.com");
    vi.unstubAllEnvs();
  });
});

describe("redirect URIs", () => {
  it("gives Gmail and Contacts different callbacks", () => {
    // Sharing one would leave the handler unable to tell which consent it was
    // completing, so it could not decide what to store.
    expect(gmailRedirectUri("http://localhost:3000"))
      .not.toBe(contactsRedirectUri("http://localhost:3000"));
  });

  it("builds the exact path registered in Google Cloud", () => {
    // Google matches the redirect_uri byte for byte; a stray slash breaks it.
    expect(gmailRedirectUri("http://localhost:3000"))
      .toBe("http://localhost:3000/api/integrations/google-gmail/callback");
  });
});

describe("buildAuthUrl", () => {
  it("defaults to the contacts scopes so the existing caller is unchanged", () => {
    const u = new URL(buildAuthUrl("cid", "http://x/cb", "st"));
    expect(u.searchParams.get("scope")).toBe(GOOGLE_CONTACTS_SCOPES);
  });

  it("asks for gmail.send when that scope is passed", () => {
    const u = new URL(buildAuthUrl("cid", "http://x/cb", "st", GMAIL_SEND_SCOPES));
    expect(u.searchParams.get("scope")).toContain("gmail.send");
    expect(u.searchParams.get("scope")).not.toContain("contacts");
  });

  it("keeps include_granted_scopes on BOTH flows", () => {
    // Both write the same user_google_tokens row. Without this, connecting
    // Gmail stores a send-only token and contacts sync starts 403ing — one
    // integration broken by connecting another.
    for (const scope of [GOOGLE_CONTACTS_SCOPES, GMAIL_SEND_SCOPES]) {
      const u = new URL(buildAuthUrl("cid", "http://x/cb", "st", scope));
      expect(u.searchParams.get("include_granted_scopes")).toBe("true");
    }
  });

  it("requests offline access so a refresh token is issued", () => {
    // Without this, cron sends stop working an hour after consent.
    const u = new URL(buildAuthUrl("cid", "http://x/cb", "st", GMAIL_SEND_SCOPES));
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("prompt")).toBe("consent");
  });

  it("passes the CSRF state through unchanged", () => {
    const u = new URL(buildAuthUrl("cid", "http://x/cb", "abc-123"));
    expect(u.searchParams.get("state")).toBe("abc-123");
  });
});
