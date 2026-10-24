/**
 * R-1547 — a password-only (aal1) session must not reach aal2 by enrolling a NEW authenticator
 * and verifying it. verifyCode() is the gate: a not-yet-verified factor only counts as the second
 * step when the user has no other verified factor (first-time enrollment), or the session is
 * already aal2. And it only ever looks at the session user's own factors.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { codeAt, newSecret, stepAt } from "./totp";

interface Row {
  id: string; user_id: string; friendly_name: string | null; status: "verified" | "unverified";
  secret: string; created_at: Date; updated_at: Date; last_challenged_at: Date | null;
}
let rows: Row[] = [];

/** A tiny stand-in for auth.mfa_factors that understands the few queries mfa.ts sends. */
const tx = {
  async $queryRawUnsafe(sql: string, ...args: string[]) {
    let out = rows.filter((r) => r.user_id === args[0]);
    if (/and id = \$2/.test(sql)) out = out.filter((r) => r.id === args[1]);
    if (/and id <> \$2/.test(sql)) out = out.filter((r) => r.id !== args[1]);
    if (/status = 'verified'/.test(sql)) out = out.filter((r) => r.status === "verified");
    if (/count\(\*\)/.test(sql)) return [{ n: out.length }];
    return out.map((r) => ({ ...r }));
  },
  async $executeRawUnsafe(sql: string, ...args: unknown[]) {
    if (/^\s*update auth\.mfa_factors/.test(sql)) {
      const r = rows.find((x) => x.id === args[0]);
      if (!r) return 0;
      r.status = "verified";
      r.last_challenged_at = new Date(Number(args[1]) * 30_000);
      return 1;
    }
    return 0;
  },
};
vi.mock("@/server/db/auth-store", () => ({ withAuthStore: (fn: (t: typeof tx) => unknown) => fn(tx) }));

const { verifyCode } = await import("./mfa");

const ME = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const OLD = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NEW = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function factor(id: string, user: string, status: Row["status"]): Row {
  return { id, user_id: user, friendly_name: null, status, secret: newSecret(), created_at: new Date(), updated_at: new Date(), last_challenged_at: null };
}
const codeOf = (id: string) => codeAt(rows.find((r) => r.id === id)!.secret, stepAt(Date.now()));
const statusOf = (id: string) => rows.find((r) => r.id === id)!.status;

beforeEach(() => { rows = []; });

describe("verifyCode (R-1547)", () => {
  it("aal1 + an existing verified factor: verifying a NEW factor is refused and it stays unverified", async () => {
    rows = [factor(OLD, ME, "verified"), factor(NEW, ME, "unverified")];
    expect(await verifyCode(ME, codeOf(NEW), NEW, "aal1")).toBe(false);
    expect(statusOf(NEW)).toBe("unverified");
  });

  it("aal2 + an existing verified factor: adding a second authenticator works", async () => {
    rows = [factor(OLD, ME, "verified"), factor(NEW, ME, "unverified")];
    expect(await verifyCode(ME, codeOf(NEW), NEW, "aal2")).toBe(true);
    expect(statusOf(NEW)).toBe("verified");
  });

  it("first-time enrollment (no verified factor yet) at aal1 verifies it", async () => {
    rows = [factor(NEW, ME, "unverified")];
    expect(await verifyCode(ME, codeOf(NEW), NEW, "aal1")).toBe(true);
    expect(statusOf(NEW)).toBe("verified");
  });

  it("normal sign-in step-up with the existing factor still works at aal1", async () => {
    rows = [factor(OLD, ME, "verified")];
    expect(await verifyCode(ME, codeOf(OLD), undefined, "aal1")).toBe(true);
    rows[0].last_challenged_at = null;
    expect(await verifyCode(ME, codeOf(OLD), OLD, "aal1")).toBe(true);
  });

  it("without factorId, an unverified factor never counts", async () => {
    rows = [factor(OLD, ME, "verified"), factor(NEW, ME, "unverified")];
    expect(await verifyCode(ME, codeOf(NEW), undefined, "aal1")).toBe(false);
    expect(statusOf(NEW)).toBe("unverified");
  });

  it("another user's factor is refused, even with its right code", async () => {
    rows = [factor(NEW, OTHER, "unverified")];
    expect(await verifyCode(ME, codeOf(NEW), NEW, "aal1")).toBe(false);
    expect(statusOf(NEW)).toBe("unverified");
  });
});
