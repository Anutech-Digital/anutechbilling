/**
 * R-726: a typed From line is not proof (support-email-inbound/route.ts:198 used to hand it to
 * the bot as the customer). Only a verdict the sender cannot write proves the From domain.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { senderDomainVerified, headersFromBody } from "./sender-auth";

afterEach(() => vi.unstubAllEnvs());

describe("senderDomainVerified (R-726)", () => {
  it("a bare From line with no verdict is NOT verified (spoof)", () => {
    expect(senderDomainVerified({ from: "ceo@victimco.com" }, {}, "ceo@victimco.com")).toBe(false);
  });

  it("SendGrid's own dkim field, aligned with the From domain → verified", () => {
    expect(senderDomainVerified({ dkim: "{@victimco.com : pass}" }, {}, "ceo@victimco.com")).toBe(true);
    expect(senderDomainVerified({ dkim: "{@victimco.com : pass}" }, {}, "ceo@mail.victimco.com")).toBe(true);
  });

  it("DKIM pass for the ATTACKER's domain does not prove the victim's From", () => {
    expect(senderDomainVerified({ dkim: "{@evil.com : pass}" }, {}, "ceo@victimco.com")).toBe(false);
    expect(senderDomainVerified({ dkim: "{@victimco.com : fail}" }, {}, "ceo@victimco.com")).toBe(false);
    /* "co.com" is not the victim's parent domain in a way that helps an attacker: notvictimco.com */
    expect(senderDomainVerified({ dkim: "{@victimco.com : pass}" }, {}, "ceo@notvictimco.com")).toBe(false);
  });

  it("the secret-authenticated forwarder's own verdict is trusted", () => {
    expect(senderDomainVerified({ dmarc: "PASS" }, {}, "ceo@victimco.com")).toBe(true);
    expect(senderDomainVerified({ senderVerified: true }, {}, "ceo@victimco.com")).toBe(true);
    expect(senderDomainVerified({ senderVerified: "true" }, {}, "ceo@victimco.com")).toBe(false);
  });

  it("Authentication-Results is ignored unless its authserv-id is configured as trusted", () => {
    const h = { "authentication-results": ["mx.google.com; dkim=pass header.i=@victimco.com; dmarc=pass header.from=victimco.com"] };
    expect(senderDomainVerified({}, h, "ceo@victimco.com")).toBe(false); // forgeable by default
    vi.stubEnv("INBOUND_TRUSTED_AUTHSERV_IDS", "mx.google.com");
    expect(senderDomainVerified({}, h, "ceo@victimco.com")).toBe(true);
    expect(senderDomainVerified({}, { "authentication-results": ["evil.example; dmarc=pass header.from=victimco.com"] }, "ceo@victimco.com")).toBe(false);
    expect(senderDomainVerified({}, { "authentication-results": ["mx.google.com; dmarc=fail header.from=victimco.com"] }, "ceo@victimco.com")).toBe(false);
  });

  it("no domain → not verified (fail closed)", () => {
    expect(senderDomainVerified({ senderVerified: true }, {}, "")).toBe(false);
  });

  it("headersFromBody keeps every Authentication-Results line (Postmark shape)", () => {
    const h = headersFromBody({ Headers: [
      { Name: "Authentication-Results", Value: "a; dkim=pass header.d=x.in" },
      { Name: "Authentication-Results", Value: "b; spf=pass" },
    ] });
    expect(h["authentication-results"]).toHaveLength(2);
  });
});
