import { describe, it, expect, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";
import {
  encryptSecret, decryptSecret, isEncrypted, isVaultConfigured,
  generateMasterKey, maskSecret, VaultNotConfiguredError, VAULT_NOT_CONFIGURED_MESSAGE,
} from "./vault";

const KEY_A = crypto.randomBytes(32).toString("base64");
const KEY_B = crypto.randomBytes(32).toString("base64");
const SECRET = "rzp_live_9f3aK2mQ7xL0pZ";

const withKey = (k: string | undefined) => {
  if (k === undefined) delete process.env.SECRETS_MASTER_KEY;
  else process.env.SECRETS_MASTER_KEY = k;
};

let original: string | undefined;
beforeEach(() => { original = process.env.SECRETS_MASTER_KEY; withKey(KEY_A); });
afterEach(() => { withKey(original); });

describe("round trip", () => {
  it("encrypts and decrypts back to the same value", () => {
    expect(decryptSecret(encryptSecret(SECRET))).toBe(SECRET);
  });

  it("produces a different ciphertext every time", () => {
    // Per-value DEK plus a random IV: identical inputs must not produce
    // identical rows, or the table leaks which tenants share a key.
    const a = encryptSecret(SECRET);
    const b = encryptSecret(SECRET);
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe(decryptSecret(b));
  });

  it("handles unicode, whitespace and long values", () => {
    for (const v of ["ключ-123", "sk-🔑-abc", "  padded  ", "x".repeat(4000), "line\nbreak\ttab"]) {
      expect(decryptSecret(encryptSecret(v))).toBe(v);
    }
  });

  it("marks its output as encrypted", () => {
    expect(isEncrypted(encryptSecret(SECRET))).toBe(true);
    expect(isEncrypted(SECRET)).toBe(false);
    expect(isEncrypted(null)).toBe(false);
  });
});

// ── The rule that makes this safe to deploy ────────────────────────────────
describe("legacy plaintext passes through", () => {
  it("returns a non-envelope value unchanged", () => {
    // Every secret saved before encryption existed must keep working the moment
    // this ships. Without this, deploying would break Razorpay, Gemini and
    // WhatsApp for every tenant at once.
    expect(decryptSecret("rzp_test_plaintextkey")).toBe("rzp_test_plaintextkey");
    expect(decryptSecret("AQ.Ab8RN_googlekey")).toBe("AQ.Ab8RN_googlekey");
  });

  it("passes plaintext through even with NO master key configured", () => {
    withKey(undefined);
    expect(decryptSecret("rzp_test_plaintextkey")).toBe("rzp_test_plaintextkey");
  });

  it("treats null and empty as nothing stored", () => {
    expect(decryptSecret(null)).toBeNull();
    expect(decryptSecret(undefined)).toBeNull();
    expect(decryptSecret("")).toBeNull();
  });
});

describe("failures are loud, never silent", () => {
  it("refuses to decrypt an envelope with the WRONG key", () => {
    const sealed = encryptSecret(SECRET);
    withKey(KEY_B);
    expect(() => decryptSecret(sealed)).toThrow(/wrong SECRETS_MASTER_KEY|modified/);
  });

  it("refuses to decrypt an envelope with NO key", () => {
    const sealed = encryptSecret(SECRET);
    withKey(undefined);
    expect(() => decryptSecret(sealed)).toThrow(/not set/);
  });

  it("detects tampering with the ciphertext", () => {
    // AES-GCM is authenticated: a flipped byte must fail, not decrypt to
    // different bytes. A silently corrupted API key would surface as a baffling
    // third-party auth error instead of an obvious local one.
    const sealed = encryptSecret(SECRET);
    const parts = sealed.split(":");
    const ct = Buffer.from(parts[6], "base64url");
    ct[0] ^= 0xff;
    parts[6] = ct.toString("base64url");
    expect(() => decryptSecret(parts.join(":"))).toThrow(/modified/);
  });

  it("detects tampering with the wrapped data key", () => {
    const sealed = encryptSecret(SECRET);
    const parts = sealed.split(":");
    const w = Buffer.from(parts[3], "base64url");
    w[0] ^= 0xff;
    parts[3] = w.toString("base64url");
    expect(() => decryptSecret(parts.join(":"))).toThrow(/unwrap/);
  });

  it("rejects a malformed envelope rather than guessing", () => {
    expect(() => decryptSecret("rosv1:only:three:parts")).toThrow(/malformed/);
  });

  it("refuses to encrypt with no key rather than returning plaintext", () => {
    // Returning the input here would leave a secret in the clear while every
    // caller believed it was sealed — the exact state this module exists to end.
    withKey(undefined);
    expect(() => encryptSecret(SECRET)).toThrow(/not set/);
  });

  it("rejects a master key that is not 32 bytes", () => {
    withKey(crypto.randomBytes(16).toString("base64"));
    expect(isVaultConfigured()).toBe(false);
    expect(() => encryptSecret(SECRET)).toThrow();
  });

  it("rejects an empty value", () => {
    expect(() => encryptSecret("")).toThrow(/Nothing to encrypt/);
  });
});

describe("no key = refuse, never plaintext (R-051)", () => {
  it("throws VaultNotConfiguredError with the next step, not the value", () => {
    withKey(undefined);
    let err: unknown = null;
    try { encryptSecret(SECRET); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(VaultNotConfiguredError);
    expect((err as Error).message).toBe(VAULT_NOT_CONFIGURED_MESSAGE);
    expect((err as Error).message).toMatch(/Next step/);
    expect((err as Error).message).not.toContain(SECRET);
  });

  it("has no plaintext-fallback export left to call", async () => {
    const mod = await import("./vault");
    expect("encryptSecretIfPossible" in mod).toBe(false);
  });
});

describe("housekeeping", () => {
  it("generateMasterKey produces a usable 32-byte key", () => {
    const k = generateMasterKey();
    expect(Buffer.from(k, "base64")).toHaveLength(32);
    withKey(k);
    expect(decryptSecret(encryptSecret(SECRET))).toBe(SECRET);
  });

  it("maskSecret never reveals the middle of a secret", () => {
    expect(maskSecret(SECRET)).toBe("rzp_…pZ");
    expect(maskSecret("short")).toBe("•••••");
    expect(maskSecret(null)).toBe("—");
  });

  it("maskSecret says 'encrypted' rather than showing envelope bytes", () => {
    expect(maskSecret(encryptSecret(SECRET))).toBe("encrypted");
  });
});
