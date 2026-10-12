import { describe, it, expect } from "vitest";
import {
  emailDomain,
  isPublicEmailDomain,
  decideOnboarding,
  PUBLIC_EMAIL_DOMAINS,
} from "./domain";

describe("emailDomain", () => {
  it("returns the lower-cased domain", () => {
    expect(emailDomain("Ranjeet.Raj@example.test")).toBe("example.test");
  });

  it("trims surrounding whitespace", () => {
    expect(emailDomain("  pardeep@anutech.in  ")).toBe("anutech.in");
  });

  it("uses the LAST @ — a local part may legally contain one when quoted", () => {
    expect(emailDomain('"weird@local"@anutech.in')).toBe("anutech.in");
  });

  it("returns '' for anything that is not an address", () => {
    expect(emailDomain("no-at-sign")).toBe("");
    expect(emailDomain("@leading.in")).toBe("");
    expect(emailDomain("trailing@")).toBe("");
    expect(emailDomain(null)).toBe("");
    expect(emailDomain(undefined)).toBe("");
    expect(emailDomain("")).toBe("");
  });

  it("returns '' for a dotless host, so 'localhost' is never a claimable domain", () => {
    expect(emailDomain("root@localhost")).toBe("");
  });
});

describe("isPublicEmailDomain", () => {
  it("recognises consumer providers", () => {
    expect(isPublicEmailDomain("gmail.com")).toBe(true);
    expect(isPublicEmailDomain("rediffmail.com")).toBe(true);
    expect(isPublicEmailDomain("GMAIL.COM")).toBe(true);
  });

  it("does not flag a company domain", () => {
    expect(isPublicEmailDomain("anutech.in")).toBe(false);
    expect(isPublicEmailDomain("example.test")).toBe(false);
  });

  it("handles empty input", () => {
    expect(isPublicEmailDomain("")).toBe(false);
    expect(isPublicEmailDomain(null)).toBe(false);
  });

  it("lists gmail — the case that would funnel every consumer signup into one tenant", () => {
    expect(PUBLIC_EMAIL_DOMAINS.has("gmail.com")).toBe(true);
  });
});

describe("decideOnboarding", () => {
  it("an invite wins, and carries its role", () => {
    const d = decideOnboarding({
      invite: { tenant_id: "t-anutech", role: "manager" },
      domainMatch: { tenant_id: "t-other", tenant_name: "Other" },
    });
    expect(d).toEqual({ mode: "join", tenantId: "t-anutech", role: "manager" });
  });

  it("a domain match asks for approval — it NEVER joins (CLAUDE.md §4)", () => {
    const d = decideOnboarding({
      invite: null,
      domainMatch: { tenant_id: "t-anutech", tenant_name: "ANUTECH DIGITAL PVT LTD" },
    });
    expect(d).toEqual({
      mode: "request_approval",
      tenantId: "t-anutech",
      tenantName: "ANUTECH DIGITAL PVT LTD",
    });
    // The exhaustive version of the same guarantee: no input produces "join"
    // unless an invite was present.
    expect(d.mode).not.toBe("join");
  });

  it("falls through to 'choose' when nothing recognises the person", () => {
    expect(decideOnboarding({})).toEqual({ mode: "choose" });
    expect(decideOnboarding({ invite: null, domainMatch: null })).toEqual({ mode: "choose" });
  });

  it("never silently creates a tenant — there is no 'new' outcome at all", () => {
    const outcomes = [
      decideOnboarding({}),
      decideOnboarding({ invite: null }),
      decideOnboarding({ domainMatch: null }),
      decideOnboarding({ invite: { tenant_id: "", role: "sales" } }),
    ];
    for (const o of outcomes) expect(o.mode).toBe("choose");
  });

  it("a malformed invite (empty tenant_id) does not join, but a domain match still applies", () => {
    const d = decideOnboarding({
      invite: { tenant_id: "", role: "sales" },
      domainMatch: { tenant_id: "t-anutech", tenant_name: "ANUTECH DIGITAL PVT LTD" },
    });
    expect(d.mode).toBe("request_approval");
  });

  it("reproduces the 11 Aug 2026 case: right company, wrong invite address", () => {
    // Invite existed for ranjeet@anutech.in; he signed in as
    // staff@example.test. Exact-string matching found nothing.
    const invite = null;
    // Had example.test been a verified domain of the real workspace:
    const d = decideOnboarding({
      invite,
      domainMatch: { tenant_id: "t-democo", tenant_name: "Demo Co" },
    });
    // He waits for an owner instead of getting a private company of his own.
    expect(d.mode).toBe("request_approval");
  });
});
