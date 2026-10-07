import { describe, it, expect, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";
import { decryptTenantSecrets, sealTenantSecrets, SECRET_COLUMNS } from "./tenant-secrets";
import { encryptSecret, isEncrypted, VaultNotConfiguredError } from "./vault";

const KEY = crypto.randomBytes(32).toString("base64");
let original: string | undefined;
beforeEach(() => { original = process.env.SECRETS_MASTER_KEY; process.env.SECRETS_MASTER_KEY = KEY; });
afterEach(() => { if (original === undefined) delete process.env.SECRETS_MASTER_KEY; else process.env.SECRETS_MASTER_KEY = original; });

describe("decryptTenantSecrets", () => {
  it("opens every credential field", () => {
    const row = { tenant_id: "t1", razorpay_key_secret: encryptSecret("rzp_secret"), gemini_api_key: encryptSecret("AQ.key") };
    expect(decryptTenantSecrets(row)).toMatchObject({ razorpay_key_secret: "rzp_secret", gemini_api_key: "AQ.key" });
  });

  it("leaves configuration fields alone", () => {
    // Decrypting everything would try to open razorpay_mode and gemini_model.
    const row = { razorpay_mode: "test", gemini_model: "gemini-2.5-flash", razorpay_key_id: "rzp_test_abc" };
    expect(decryptTenantSecrets(row)).toEqual(row);
  });

  it("passes legacy plaintext through", () => {
    const row = { razorpay_key_secret: "plain_secret", gemini_api_key: "AQ.plain" };
    expect(decryptTenantSecrets(row)).toEqual(row);
  });

  it("handles a mixed row — some encrypted, some not", () => {
    // Exactly the state during migration: one secret re-saved, others not yet.
    const row = { razorpay_key_secret: encryptSecret("sealed"), gemini_api_key: "still_plain" };
    expect(decryptTenantSecrets(row)).toEqual({ razorpay_key_secret: "sealed", gemini_api_key: "still_plain" });
  });

  it("returns null for a missing row", () => {
    expect(decryptTenantSecrets(null)).toBeNull();
    expect(decryptTenantSecrets(undefined)).toBeNull();
  });

  it("leaves null and empty fields as they are", () => {
    const row = { razorpay_key_secret: null, gemini_api_key: "" };
    expect(decryptTenantSecrets(row)).toEqual(row);
  });
});

describe("sealTenantSecrets", () => {
  it("encrypts credential fields and leaves config alone", () => {
    const { row } = sealTenantSecrets({
      razorpay_key_id: "rzp_test_abc", razorpay_key_secret: "s3cret", razorpay_mode: "test",
    });
    expect(row.razorpay_key_id).toBe("rzp_test_abc");
    expect(row.razorpay_mode).toBe("test");
    expect(isEncrypted(row.razorpay_key_secret as string)).toBe(true);
  });

  it("does not double-wrap an already-encrypted value", () => {
    // Re-saving a form that echoes back a stored value must be a no-op.
    const already = encryptSecret("s3cret");
    const { row } = sealTenantSecrets({ razorpay_key_secret: already });
    expect(row.razorpay_key_secret).toBe(already);
  });

  it("REFUSES to seal without a master key instead of storing in the clear (R-051)", () => {
    delete process.env.SECRETS_MASTER_KEY;
    expect(() => sealTenantSecrets({ razorpay_key_secret: "s3cret", razorpay_mode: "test" }))
      .toThrow(VaultNotConfiguredError);
    // The error names the fix, never the value.
    let msg = "";
    try { sealTenantSecrets({ gemini_api_key: "AQ.secret" }); } catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(/SECRETS_MASTER_KEY[\s\S]*NOT saved[\s\S]*Next step/);
    expect(msg).not.toContain("AQ.secret");
  });

  it("refuses a too-short key the same way", () => {
    process.env.SECRETS_MASTER_KEY = Buffer.alloc(16, 1).toString("base64");
    expect(() => sealTenantSecrets({ gemini_api_key: "AQ.x" })).toThrow(VaultNotConfiguredError);
  });

  it("needs no key when the patch carries no credential to seal", () => {
    // Changing gemini_model alone must still work on a keyless server.
    delete process.env.SECRETS_MASTER_KEY;
    expect(sealTenantSecrets({ tenant_id: "t1", gemini_model: "gemini-2.5-flash" }).row)
      .toEqual({ tenant_id: "t1", gemini_model: "gemini-2.5-flash" });
  });

  it("skips empty values", () => {
    const { row } = sealTenantSecrets({ razorpay_key_secret: "", gemini_api_key: null });
    expect(row).toEqual({ razorpay_key_secret: "", gemini_api_key: null });
  });

  it("round-trips through seal then decrypt", () => {
    const { row } = sealTenantSecrets({ whatsapp_app_secret: "meta_app_secret", whatsapp_verify_token: "tok" });
    expect(decryptTenantSecrets(row)).toEqual({ whatsapp_app_secret: "meta_app_secret", whatsapp_verify_token: "tok" });
  });

  it("covers every credential column the app stores", () => {
    // A credential missing from SECRET_COLUMNS is stored in the clear while
    // everything looks normal — the exact state the vault exists to end.
    for (const col of SECRET_COLUMNS) {
      const { row } = sealTenantSecrets({ [col]: "value-" + col });
      expect(isEncrypted(row[col] as string), `${col} was not sealed`).toBe(true);
    }
  });
});
