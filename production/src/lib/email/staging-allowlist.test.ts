import { describe, it, expect } from "vitest";
import { guardMailRecipients, guardPhoneRecipient, isStagingEnv, readMailAllowlist } from "./staging-allowlist";

const LIVE = { NEXT_PUBLIC_APP_ENV: "", NEXT_PUBLIC_APP_URL: "https://reselleros.anutech.in" };
const STAGING = { NEXT_PUBLIC_APP_ENV: "staging" };

describe("isStagingEnv", () => {
  it("reads APP_ENV, NEXT_PUBLIC_APP_ENV and a staging app URL", () => {
    expect(isStagingEnv({ APP_ENV: "staging" })).toBe(true);
    expect(isStagingEnv(STAGING)).toBe(true);
    expect(isStagingEnv({ NEXT_PUBLIC_APP_URL: "https://resellersos-staging-x-as.a.run.app" })).toBe(true);
    expect(isStagingEnv(LIVE)).toBe(false);
    expect(isStagingEnv({ NEXT_PUBLIC_APP_ENV: "local", NEXT_PUBLIC_APP_URL: "http://localhost:3001" })).toBe(false);
  });
});

describe("guardMailRecipients", () => {
  it("live: everything passes, untouched", () => {
    expect(guardMailRecipients("anyone@gmail.com", LIVE)).toEqual({ allowedTo: "anyone@gmail.com", droppedMasked: [], reason: null });
  });

  it("staging: customer dropped (masked), @anutech.in kept", () => {
    const v = guardMailRecipients("Rahul <rahul@gmail.com>, team@anutech.in", STAGING);
    expect(v.allowedTo).toBe("team@anutech.in");
    expect(v.droppedMasked).toEqual(["r***@gmail.com"]);
    expect(v.reason).toBe("staging-allowlist");
  });

  it("staging: lookalike domains are not anutech.in", () => {
    expect(guardMailRecipients("x@anutech.in.evil.com", STAGING).allowedTo).toBe("");
    expect(guardMailRecipients("x@notanutech.in", STAGING).allowedTo).toBe("");
  });

  it("STAGING_MAIL_ALLOWLIST alone turns the guard on (laptop opt-in)", () => {
    expect(guardMailRecipients("a@gmail.com", { STAGING_MAIL_ALLOWLIST: "b@gmail.com" }).allowedTo).toBe("");
  });

  it("fails closed on an unreadable list", () => {
    expect(readMailAllowlist({ STAGING_MAIL_ALLOWLIST: "ok@x.com, ???" }).ok).toBe(false);
    const v = guardMailRecipients("team@anutech.in", { ...STAGING, STAGING_MAIL_ALLOWLIST: "???" });
    expect(v.allowedTo).toBe("");
    expect(v.reason).toBe("staging-allowlist-unreadable");
  });
});

describe("guardPhoneRecipient", () => {
  it("live: allowed", () => {
    expect(guardPhoneRecipient("+919876543210", LIVE)).toEqual({ allowed: true });
  });
  it("staging: empty list blocks every number, masked", () => {
    const v = guardPhoneRecipient("+919876543210", STAGING);
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.masked).toBe("+91 *******210");
  });
  it("staging: a listed number passes in any format", () => {
    expect(guardPhoneRecipient("+91 98765 43210", { ...STAGING, STAGING_PHONE_ALLOWLIST: "9876543210" }).allowed).toBe(true);
  });
  it("staging: an unreadable list blocks all", () => {
    const v = guardPhoneRecipient("9876543210", { ...STAGING, STAGING_PHONE_ALLOWLIST: "9876543210, abc" });
    expect(v.allowed).toBe(false);
  });
});
