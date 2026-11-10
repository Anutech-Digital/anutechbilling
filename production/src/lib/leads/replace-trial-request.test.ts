/**
 * R-2563 — the signed replace token: only the browser that sent the earlier trial request (same
 * tenant, same email AND mobile, under 24 h) can name it for closing. The DB side
 * (replace_trial_request) is proven in supabase/tests/r2563_replace_trial_request.test.sql and the
 * whole path in e2e/cards/R-2563.spec.ts.
 */
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanReplaceTokens, signReplaceToken, verifyReplaceTokens } from "./replace-trial-request";

const T = "00000000-0000-0000-0000-000000002563";
const OTHER_T = "00000000-0000-0000-0000-000000009999";
const NOW = new Date("2026-11-07T13:00:00Z");
const CONTACT = { email: "Ravi@Example.invalid", phone: "+91 98765 43210" };

const ENV = { ...process.env };
beforeEach(() => { process.env.PDF_SIGNING_SECRET = randomBytes(24).toString("hex"); });
afterEach(() => { process.env = { ...ENV }; });

const tokenFor = (leadId = "L-MHOLD1", now = NOW, contact = CONTACT, tenantId = T) =>
  signReplaceToken({ tenantId, leadId, contact, now }) as string;

describe("R-2563 replace token", () => {
  it("the same contact gets its own earlier lead back (email any case, phone any format)", () => {
    const tok = tokenFor();
    expect(tok).toMatch(/^L-MHOLD1\.\d{10}\.[A-Za-z0-9_-]{43}$/);
    expect(verifyReplaceTokens([tok], { tenantId: T, contact: { email: "ravi@example.invalid", phone: "09876543210" }, now: NOW }))
      .toEqual(["L-MHOLD1"]);
  });

  it("another contact (email OR mobile differs) gets nothing — a forged replace closes nothing", () => {
    const tok = tokenFor();
    expect(verifyReplaceTokens([tok], { tenantId: T, contact: { ...CONTACT, email: "victim@example.invalid" }, now: NOW })).toEqual([]);
    expect(verifyReplaceTokens([tok], { tenantId: T, contact: { ...CONTACT, phone: "9000000001" }, now: NOW })).toEqual([]);
  });

  it("a guessed lead id / quote number, a tampered token or another tenant's token gets nothing", () => {
    const tok = tokenFor();
    const [, issued, sig] = tok.split(".");
    expect(verifyReplaceTokens(["L-MHOLD1", "Q-ANUT-27-0040"], { tenantId: T, contact: CONTACT, now: NOW })).toEqual([]);
    expect(verifyReplaceTokens([`L-MHOLD2.${issued}.${sig}`], { tenantId: T, contact: CONTACT, now: NOW })).toEqual([]);
    expect(verifyReplaceTokens([tok], { tenantId: OTHER_T, contact: CONTACT, now: NOW })).toEqual([]);
  });

  it("older than 24 hours → nothing; a token signed with another secret → nothing", () => {
    const old = tokenFor("L-MHOLD1", new Date(NOW.getTime() - 25 * 3600_000));
    expect(verifyReplaceTokens([old], { tenantId: T, contact: CONTACT, now: NOW })).toEqual([]);
    const fresh = tokenFor();
    process.env.PDF_SIGNING_SECRET = randomBytes(24).toString("hex");
    process.env.SIGNING_LEGACY_UNTIL = "2000-01-01T00:00:00Z";
    expect(verifyReplaceTokens([fresh], { tenantId: T, contact: CONTACT, now: NOW })).toEqual([]);
  });

  it("no token without a lead id, email or mobile", () => {
    expect(signReplaceToken({ tenantId: T, leadId: "Q-2026-1", contact: CONTACT, now: NOW })).toBeNull();
    expect(signReplaceToken({ tenantId: T, leadId: "L-MHOLD1", contact: { email: "", phone: "9876543210" }, now: NOW })).toBeNull();
    expect(signReplaceToken({ tenantId: T, leadId: "L-MHOLD1", contact: { email: "a@b.in", phone: "12" }, now: NOW })).toBeNull();
  });

  it("input cleaning: strings of the token shape only, de-duplicated, at most 5", () => {
    const toks = ["L-AAAA1", "L-AAAA2", "L-AAAA3", "L-AAAA4", "L-AAAA5", "L-AAAA6"].map((id) => tokenFor(id));
    expect(cleanReplaceTokens("x")).toEqual([]);
    expect(cleanReplaceTokens([toks[0], toks[0], 5, "x'; drop", "(sent without a number)"])).toEqual([toks[0]]);
    expect(cleanReplaceTokens(toks)).toHaveLength(5);
  });
});
