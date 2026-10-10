/**
 * R-391: owner-set temporary passwords — generator, typed-password rules and WHO may do it.
 */
import { describe, it, expect } from "vitest";
import {
  TEMP_PASSWORD_GENERATED_LENGTH,
  TEMP_PASSWORD_MIN_LENGTH,
  canSetTempPassword,
  checkTypedTempPassword,
  decideTempPassword,
  generateTempPassword,
} from "./temp-password";
import { checkNewPassword } from "./password-rules";

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const owner  = { id: "a0000000-0000-4000-8000-000000000001", role: "owner", tenant_id: T1 };
const sales  = { id: "a0000000-0000-4000-8000-000000000002", role: "sales", tenant_id: T1 };
const owner2 = { id: "a0000000-0000-4000-8000-000000000003", role: "owner", tenant_id: T1 };
const other  = { id: "a0000000-0000-4000-8000-000000000004", role: "sales", tenant_id: T2 };

describe("generateTempPassword", () => {
  it("is 16 chars, mixed case + digit, unambiguous, and passes the normal rules", () => {
    for (let i = 0; i < 200; i++) {
      const pw = generateTempPassword();
      expect(pw).toHaveLength(TEMP_PASSWORD_GENERATED_LENGTH);
      expect(pw).toMatch(/[A-Z]/);
      expect(pw).toMatch(/[a-z]/);
      expect(pw).toMatch(/[0-9]/);
      expect(pw).not.toMatch(/[0O1lI]/);
      expect(checkNewPassword(pw)).toBeNull();
    }
  });

  it("does not repeat", () => {
    const seen = new Set(Array.from({ length: 500 }, () => generateTempPassword()));
    expect(seen.size).toBe(500);
  });

  it("skips bytes above the uniform limit (no modulo bias)", () => {
    /* 255 is above 256 - 256 % 55 = 220 and must never be used. Feed 255 then real bytes. */
    let call = 0;
    const fill = (buf: Uint8Array) => {
      call++;
      for (let i = 0; i < buf.length; i++) buf[i] = call === 1 ? 255 : (i * 7 + call) % 220;
      return buf;
    };
    const pw = generateTempPassword(16, fill);
    expect(pw).toHaveLength(16);
    expect(call).toBeGreaterThan(1);
  });

  it("refuses to make one shorter than the floor", () => {
    expect(() => generateTempPassword(TEMP_PASSWORD_MIN_LENGTH - 1)).toThrow();
  });
});

describe("checkTypedTempPassword", () => {
  it("needs 8+ characters, like a normal password (R-534: was 12)", () => {
    expect(checkTypedTempPassword("Sh0rt9p")).not.toBeNull();
    expect(checkTypedTempPassword("Kites-42")).toBeNull();
    expect(checkTypedTempPassword("Kites-river-42")).toBeNull();
  });
  it("still applies the normal rules", () => {
    expect(checkTypedTempPassword("Anutech@2026!!")).not.toBeNull();
    expect(checkTypedTempPassword(" Kites-river-42")).not.toBeNull();
  });
});

describe("decideTempPassword — server-side who-may", () => {
  it("lets an owner set it for a non-owner in the same workspace", () => {
    expect(decideTempPassword(owner, sales)).toEqual({ ok: true });
  });
  it("403 for a non-owner caller", () => {
    expect(decideTempPassword(sales, { ...owner2, role: "support" })).toMatchObject({ ok: false, status: 403 });
  });
  it("403 for a caller with no workspace", () => {
    expect(decideTempPassword(null, sales)).toMatchObject({ ok: false, status: 403 });
    expect(decideTempPassword({ ...owner, tenant_id: null }, sales)).toMatchObject({ ok: false, status: 403 });
  });
  it("403 cross-tenant — whether the lookup returned nothing or a row from elsewhere", () => {
    expect(decideTempPassword(owner, null)).toMatchObject({ ok: false, status: 403 });
    expect(decideTempPassword(owner, other)).toMatchObject({ ok: false, status: 403 });
  });
  it("403 for another owner, and for yourself", () => {
    expect(decideTempPassword(owner, owner2)).toMatchObject({ ok: false, status: 403 });
    expect(decideTempPassword(owner, owner)).toMatchObject({ ok: false, status: 403 });
  });
});

describe("canSetTempPassword — the Team page button", () => {
  it("hidden for yourself, owners, and before identity loads", () => {
    expect(canSetTempPassword(sales, owner.id)).toBe(true);
    expect(canSetTempPassword(owner, owner.id)).toBe(false);
    expect(canSetTempPassword(owner2, owner.id)).toBe(false);
    expect(canSetTempPassword(sales, undefined)).toBe(false);
  });
});
