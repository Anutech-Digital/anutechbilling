/**
 * R-1903 slice 1 — /api/settings/mobile (status), /send and /verify.
 *
 * The owner's path: Settings → Security → Mobile number → "98765 43210" → Verify → the code
 * (on a local server shown on screen, never an SMS) → Confirm code → "Verified".
 * The database side (hash, expiry, 3-try lock, limits, other user) is proven in
 * supabase/tests/r1903_phone_otp.test.sql; here: the routes pass a HASH, map every refusal to
 * a plain message, and the dev code never appears on a deployment.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const st = vi.hoisted(() => ({
  user: { id: "u-a" } as { id: string } | null,
  calls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  replies: {} as Record<string, { data: unknown; error: unknown }>,
  row: { phone: "+919876543210", phone_verified_at: null as string | null },
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: st.user } }) },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      st.calls.push({ fn, args });
      return st.replies[fn] ?? { data: null, error: { message: "no reply set" } };
    },
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: st.row, error: null }) }) }),
    }),
  }),
}));

import { GET } from "./route";
import { POST as SEND } from "./send/route";
import { POST as VERIFY } from "./verify/route";
import { hashOtp } from "@/lib/sms/otp";

const req = (path: string, body: unknown) =>
  new Request(`https://x.test/api/settings/mobile${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });

const ENV_KEYS = ["NODE_ENV", "NEXT_PUBLIC_APP_ENV", "K_SERVICE", "OTP_HASH_SECRET", "AUTH_SECRET", "NEXTAUTH_SECRET", "SUPABASE_SERVICE_ROLE_KEY"] as const;
const saved: Record<string, string | undefined> = {};
const setEnv = (k: string, v: string | undefined) => {
  if (v === undefined) delete (process.env as Record<string, string | undefined>)[k];
  else (process.env as Record<string, string | undefined>)[k] = v;
};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  setEnv("NODE_ENV", "test");
  setEnv("NEXT_PUBLIC_APP_ENV", "local");
  setEnv("K_SERVICE", undefined);
  setEnv("OTP_HASH_SECRET", "test-otp-secret");
  st.user = { id: "u-a" };
  st.calls = [];
  st.replies = {};
  st.row = { phone: "+919876543210", phone_verified_at: null };
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => {
  for (const k of ENV_KEYS) setEnv(k, saved[k]);
  vi.restoreAllMocks();
});

describe("POST /api/settings/mobile/send", () => {
  it("owner's path on a local server: hashes the code, stores it, shows the dev code — no SMS", async () => {
    st.replies.request_phone_otp = { data: { ok: true, otp_id: "o1", expires_at: "2026-10-25T09:00:00Z", resend_after_seconds: 30 }, error: null };
    const r = await SEND(req("/send", { phone: "98765 43210" }));
    const j = await r.json();
    expect(r.status).toBe(200);
    expect(j.devCode).toMatch(/^\d{6}$/);
    expect(j.sentTo).toBe("+91 98*****210");
    const call = st.calls.find((c) => c.fn === "request_phone_otp")!;
    expect(call.args.p_phone).toBe("+919876543210");
    // The database gets the HMAC, never the code.
    expect(call.args.p_code_hash).toBe(hashOtp("test-otp-secret", "u-a", "+919876543210", j.devCode));
    expect(call.args.p_code_hash).not.toContain(j.devCode);
    // The dev console line has the masked number only.
    const line = String((console.info as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0]);
    expect(line).toContain("+91 98*****210");
    expect(line).not.toContain("9876543210");
  });

  it("an invalid number is refused before anything is stored", async () => {
    const r = await SEND(req("/send", { phone: "12345" }));
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/10-digit Indian mobile/);
    expect(st.calls).toHaveLength(0);
  });

  it.each([
    ["NODE_ENV=production", { NODE_ENV: "production" }],
    ["staging", { NEXT_PUBLIC_APP_ENV: "staging" }],
    ["Cloud Run", { K_SERVICE: "reselleros" }],
  ])("on a deployment (%s) with no SMS provider: 'SMS not set up yet', nothing stored, no code shown", async (_n, env) => {
    for (const [k, v] of Object.entries(env)) setEnv(k, v);
    st.replies.request_phone_otp = { data: { ok: true, otp_id: "o1" }, error: null };
    const r = await SEND(req("/send", { phone: "9876543210" }));
    const j = await r.json();
    expect(r.status).toBe(503);
    expect(j.code).toBe("sms_not_set_up");
    expect(j.error).toMatch(/SMS is not set up yet, so no code was sent/);
    expect(j.devCode).toBeUndefined();
    expect(JSON.stringify(j)).not.toMatch(/\d{6}/);
    expect(st.calls).toHaveLength(0);
  });

  it.each([
    [{ reason: "cooldown", retry_after_seconds: 22 }, 429, /Wait 22 seconds/],
    [{ reason: "rate_limited", retry_after_seconds: 2100 }, 429, /Try again in 35 min/],
    [{ reason: "locked", retry_after_seconds: 600 }, 429, /Wait 10 min/],
  ])("a refusal %o → %i with a next step", async (reply, status, msg) => {
    st.replies.request_phone_otp = { data: { ok: false, ...reply }, error: null };
    const r = await SEND(req("/send", { phone: "9876543210" }));
    const j = await r.json();
    expect(r.status).toBe(status);
    expect(j.error).toMatch(msg);
    expect(j.devCode).toBeUndefined();
  });

  it("signed out → 401, nothing stored", async () => {
    st.user = null;
    const r = await SEND(req("/send", { phone: "9876543210" }));
    expect(r.status).toBe(401);
    expect(st.calls).toHaveLength(0);
  });

  it("no company (RPC 28000) → 403 with the RPC's own next step", async () => {
    st.replies.request_phone_otp = { data: null, error: { code: "28000", message: "R-1903: sign in to your company account to verify your mobile number." } };
    const r = await SEND(req("/send", { phone: "9876543210" }));
    expect(r.status).toBe(403);
    expect((await r.json()).error).toBe("sign in to your company account to verify your mobile number.");
  });
});

describe("POST /api/settings/mobile/verify", () => {
  it("the right code: sends the same HMAC, returns verified", async () => {
    st.replies.verify_phone_otp = { data: { ok: true, phone: "+919876543210", phone_verified_at: "2026-10-25T09:00:00Z" }, error: null };
    const r = await VERIFY(req("/verify", { phone: "+91 98765 43210", code: "123456" }));
    expect(r.status).toBe(200);
    expect((await r.json()).verifiedAt).toBe("2026-10-25T09:00:00Z");
    const call = st.calls.find((c) => c.fn === "verify_phone_otp")!;
    expect(call.args).toEqual({ p_phone: "+919876543210", p_code_hash: hashOtp("test-otp-secret", "u-a", "+919876543210", "123456") });
  });

  it("not 6 digits → plain message, the database is not asked (no attempt used)", async () => {
    const r = await VERIFY(req("/verify", { phone: "9876543210", code: "12 34" }));
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/6-digit code/);
    expect(st.calls).toHaveLength(0);
  });

  it.each([
    [{ reason: "wrong_code", tries_left: 2 }, 400, /2 tries left/],
    [{ reason: "wrong_code", tries_left: 1 }, 400, /1 try left/],
    [{ reason: "locked", retry_after_seconds: 900 }, 429, /Wait 15 min/],
    [{ reason: "expired" }, 400, /expired.*Resend code/],
    [{ reason: "no_code" }, 400, /Press Verify to get a new code/],
    [{ reason: "taken" }, 409, /already verified on another login/],
  ])("%o → %i", async (reply, status, msg) => {
    st.replies.verify_phone_otp = { data: { ok: false, ...reply }, error: null };
    const r = await VERIFY(req("/verify", { phone: "9876543210", code: "000000" }));
    expect(r.status).toBe(status);
    expect((await r.json()).error).toMatch(msg);
  });
});

describe("GET /api/settings/mobile", () => {
  it("local: my number, not verified, dev mode on", async () => {
    const j = await (await GET()).json();
    expect(j).toEqual({ phone: "+919876543210", verifiedAt: null, smsReady: true, devMode: true });
  });

  it("staging: dev mode off, SMS not ready", async () => {
    setEnv("NEXT_PUBLIC_APP_ENV", "staging");
    st.row = { phone: "+919876543210", phone_verified_at: "2026-10-25T09:00:00Z" };
    const j = await (await GET()).json();
    expect(j).toEqual({ phone: "+919876543210", verifiedAt: "2026-10-25T09:00:00Z", smsReady: false, devMode: false });
  });
});
