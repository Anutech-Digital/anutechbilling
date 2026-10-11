/**
 * R-725: the public expense-claim routes (verify / submit / manage) share ONE PIN check —
 * a per-employee limit + a durable DB lockout — and the receipt photo is uploaded only
 * after the PIN passes, under a random name that cannot overwrite anyone's file.
 *
 * The DB is faked in memory: `claim_pin_check` mirrors the SQL (every 5th wrong PIN in a row
 * locks; the SQL itself is tested in supabase/tests/claim_pin_lockout.test.sql).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const st = vi.hoisted(() => ({
  rightPin: "4321",
  failed: new Map<string, number>(),
  locked: new Set<string>(),
  calls: [] as string[],
  uploads: [] as Array<{ path: string; upsert: unknown }>,
  removed: [] as string[],
  submitError: null as null | { message: string; code: string },
}));

vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: () => ({
    rpc: async (fn: string, a: Record<string, unknown>) => {
      st.calls.push(fn);
      if (fn === "claim_pin_check") {
        const emp = String(a.p_employee_id);
        if (st.locked.has(emp)) return { data: "pin_locked", error: null };
        if (a.p_pin !== st.rightPin) {
          const n = (st.failed.get(emp) ?? 0) + 1;
          st.failed.set(emp, n);
          if (n % 5 === 0) { st.locked.add(emp); return { data: "pin_locked", error: null }; }
          return { data: "wrong_pin", error: null };
        }
        st.failed.delete(emp);
        return { data: "ok", error: null };
      }
      if (fn === "submit_expense_claim") return st.submitError ? { data: null, error: st.submitError } : { data: "claim-1", error: null };
      if (fn === "verify_claim_access") return { data: 500, error: null };
      return { data: null, error: null };
    },
    storage: {
      from: () => ({
        upload: async (path: string, _b: unknown, o: { upsert?: unknown }) => {
          st.calls.push("upload");
          st.uploads.push({ path, upsert: o?.upsert });
          return { error: null };
        },
        remove: async (paths: string[]) => { st.removed.push(...paths); return { error: null }; },
      }),
    },
  }),
}));

import { createHmac } from "crypto";
import { POST as submit } from "./route";
import { POST as verify } from "./verify/route";
import { POST as manage } from "./manage/route";
import { resetRateLimiter } from "@/lib/security/rate-limit";
import { claimLinkExp, signClaimToken, CLAIM_LINK_EXPIRED, LEGACY_CLAIM_LINKS_UNTIL } from "@/lib/claim-token";

const T = "fbb976f1-9090-4f10-9726-0901bd144e42";
const E = "0b0c1d2e-3f40-4a51-8b62-7c83d94ea5f6";
const E2 = "1b0c1d2e-3f40-4a51-8b62-7c83d94ea5f6";
const CLAIM = "2b0c1d2e-3f40-4a51-8b62-7c83d94ea5f6";
const PHOTO = Buffer.from("fake-jpeg-bytes").toString("base64");

function link() {
  const exp = claimLinkExp();
  return { tid: T, exp, sig: signClaimToken(T, exp) };
}
const req = (url: string, body: unknown) =>
  new Request(`https://app.test${url}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }) as never;

type Over = Record<string, unknown>;
const doVerify = (over: Over = {}) =>
  verify(req("/api/public/expense-claim/verify", { ...link(), employeeId: E, pin: st.rightPin, ...over }));
const doSubmit = (over: Over = {}) =>
  submit(req("/api/public/expense-claim", { ...link(), employeeId: E, pin: st.rightPin, amount: 250, category: "Travel", spentOn: "2026-10-10", ...over }));
const doManage = (over: Over = {}) =>
  manage(req("/api/public/expense-claim/manage", { ...link(), action: "delete", employeeId: E, pin: st.rightPin, claimId: CLAIM, ...over }));

beforeEach(() => {
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-test");
  vi.stubEnv("PDF_SIGNING_SECRET", "");
  vi.stubEnv("SIGNING_LEGACY_UNTIL", "");
  vi.stubEnv("RATE_LIMIT_STORE", "");
  resetRateLimiter();
  st.failed.clear(); st.locked.clear();
  st.calls = []; st.uploads = []; st.removed = []; st.submitError = null;
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

describe("one PIN limit across all three routes", () => {
  it("20 PIN attempts an hour per employee, counted across verify + submit + manage", async () => {
    const routes = [doVerify, doSubmit, doManage];
    for (let i = 0; i < 20; i++) {
      const r = await routes[i % 3]();
      expect(r.status, `try ${i + 1}`).toBe(200);
    }
    for (const r of routes) {
      const res = await r();
      expect(res.status).toBe(429);
      expect(res.headers.get("Retry-After")).toBeTruthy();
    }
    // Another employee is not affected.
    expect((await doVerify({ employeeId: E2 })).status).toBe(200);
  });

  it("wrong PINs through submit and manage count toward the same lockout; 5th locks, right PIN then refused", async () => {
    expect((await doSubmit({ pin: "0000" })).status).toBe(400);
    expect((await doManage({ pin: "0001" })).status).toBe(400);
    expect((await doVerify({ pin: "0002" })).status).toBe(400);
    expect((await doManage({ action: "edit", pin: "0003", amount: 1, category: "x", spentOn: "2026-10-10" })).status).toBe(400);
    const fifth = await doSubmit({ pin: "0004" });
    expect(fifth.status).toBe(429);
    expect((await fifth.json()).error).toMatch(/Too many wrong PINs/);
    expect((await doVerify()).status).toBe(429);
    // No claim function ran for any wrong / locked attempt.
    expect(st.calls.filter((c) => c !== "claim_pin_check")).toEqual([]);
  });

  it("an employee id that is not a uuid is refused before any DB call", async () => {
    const r = await doSubmit({ employeeId: "../someone-else" });
    expect(r.status).toBe(400);
    expect(st.calls).toEqual([]);
  });
});

describe("receipt photo only after the PIN", () => {
  it("wrong PIN with a photo uploads nothing", async () => {
    const r = await doSubmit({ pin: "9999", photo: PHOTO });
    expect(r.status).toBe(400);
    expect(st.uploads).toEqual([]);
  });

  it("right PIN: check -> upload -> claim, random name, upsert false", async () => {
    const r = await doSubmit({ photo: PHOTO });
    expect(r.status).toBe(200);
    expect(st.calls.slice(0, 3)).toEqual(["claim_pin_check", "upload", "submit_expense_claim"]);
    expect(st.uploads[0].upsert).toBe(false);
    expect(st.uploads[0].path).toMatch(new RegExp(`^${T}/${E}/20261010_[0-9a-f-]{36}\\.jpg$`));
  });

  it("the same claim twice never reuses a file name (no overwrite)", async () => {
    await doSubmit({ photo: PHOTO });
    await doSubmit({ photo: PHOTO });
    expect(st.uploads).toHaveLength(2);
    expect(st.uploads[0].path).not.toBe(st.uploads[1].path);
  });

  it("if the claim is refused, its uploaded receipt is removed", async () => {
    st.submitError = { message: "You have no open expense advance to claim against", code: "P0001" };
    const r = await doSubmit({ photo: PHOTO });
    expect(r.status).toBe(400);
    expect(st.removed).toEqual([st.uploads[0].path]);
  });
});

describe("claim link expiry", () => {
  it("an expired link is refused on every route with a plain message", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-11T00:00:00Z"));
    const old = link();
    vi.setSystemTime(new Date("2027-02-01T00:00:00Z")); // > 90 days later
    for (const res of [await doVerify(old), await doSubmit(old), await doManage(old)]) {
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe(CLAIM_LINK_EXPIRED);
    }
    expect(st.calls).toEqual([]);
  });

  it("stretching exp breaks the signature", async () => {
    const l = link();
    const r = await doVerify({ ...l, exp: String(Number(l.exp) + 86_400 * 365) });
    expect(r.status).toBe(403);
    expect((await r.json()).error).toMatch(/invalid/);
  });

  it("a pre-R-725 link (no exp) still works until the legacy cutoff, then shows 'expired'", async () => {
    const legacySig = createHmac("sha256", "service-role-test").update(`expense-claim:${T}`).digest("hex");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-12T00:00:00Z"));
    expect((await doVerify({ exp: undefined, sig: legacySig })).status).toBe(200);
    vi.setSystemTime(new Date(new Date(LEGACY_CLAIM_LINKS_UNTIL).getTime() + 1000));
    const r = await doVerify({ exp: undefined, sig: legacySig });
    expect(r.status).toBe(403);
    expect((await r.json()).error).toBe(CLAIM_LINK_EXPIRED);
  });
});
