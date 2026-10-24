/** R-1550 — verifyTokenMatches: decrypt first, constant-time compare, never throws. */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { encryptSecret } from "@/lib/crypto/vault";
import { verifyTokenMatches } from "./handshake";

const KEY = Buffer.alloc(32, 9).toString("base64");
let original: string | undefined;
beforeEach(() => { original = process.env.SECRETS_MASTER_KEY; process.env.SECRETS_MASTER_KEY = KEY; });
afterEach(() => {
  if (original === undefined) delete process.env.SECRETS_MASTER_KEY; else process.env.SECRETS_MASTER_KEY = original;
  vi.restoreAllMocks();
});

describe("verifyTokenMatches", () => {
  it("opens a sealed token before comparing", () => {
    expect(verifyTokenMatches("abc123", { whatsapp_verify_token: encryptSecret("abc123") })).toBe(true);
  });
  it("legacy plaintext still matches", () => {
    expect(verifyTokenMatches("abc123", { whatsapp_verify_token: "abc123" })).toBe(true);
  });
  it("wrong / empty / missing → false", () => {
    expect(verifyTokenMatches("nope", { whatsapp_verify_token: encryptSecret("abc123") })).toBe(false);
    expect(verifyTokenMatches("", { whatsapp_verify_token: "abc123" })).toBe(false);
    expect(verifyTokenMatches("abc123", { whatsapp_verify_token: null })).toBe(false);
    expect(verifyTokenMatches("abc123", null)).toBe(false);
  });
  it("an envelope that cannot be opened is a refusal, not a throw — and the log has no secret", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const sealed = encryptSecret("abc123");
    process.env.SECRETS_MASTER_KEY = Buffer.alloc(32, 1).toString("base64");   // wrong key
    expect(verifyTokenMatches("abc123", { whatsapp_verify_token: sealed })).toBe(false);
    expect(err).toHaveBeenCalled();
    expect(String(err.mock.calls[0][0])).not.toContain(sealed);
    expect(String(err.mock.calls[0][0])).not.toContain("abc123");
  });
});
