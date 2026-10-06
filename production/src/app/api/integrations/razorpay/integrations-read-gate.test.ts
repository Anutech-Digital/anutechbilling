/**
 * R-256: integration STATUS is readable by owner / manager / billing; saving and clearing stay
 * owner-only; no secret preview reaches a non-owner.
 *
 * Before: GET was owner-only, so a manager or billing user got 403, Settings read that as
 * "Not configured / simulation" while Razorpay, Gemini and WhatsApp were live.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

const db = vi.hoisted(() => ({
  me: { tenant_id: "T1", role: "manager" } as { tenant_id: string; role: string } | null,
  secrets: {} as Record<string, unknown>,
  writes: [] as Array<{ op: string; data: unknown }>,
}));

function chain(table: string, user: boolean) {
  const q: Record<string, unknown> = {};
  for (const m of ["select", "eq"]) q[m] = () => q;
  q.upsert = (data: unknown) => { db.writes.push({ op: "upsert", data }); return Promise.resolve({ error: null }); };
  q.update = (data: unknown) => { db.writes.push({ op: "update", data }); return q; };
  const one = async () => ({ data: table === "users" && user ? db.me : db.secrets, error: null });
  q.single = one;
  q.maybeSingle = one;
  q.then = (ok: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(ok);
  return q;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: "U1" } } }) },
    from: (t: string) => chain(t, true),
  }),
  createAdminClient: () => ({ from: (t: string) => chain(t, false) }),
}));

import * as razorpay from "./route";
import * as gemini from "../gemini/route";
import * as whatsapp from "../whatsapp/route";
import * as sandbox from "../sandbox/route";

/* Throwaway values for the test only — shaped like real ones, never real. */
const FAKE = {
  razorpay_key_id: "rzp_live_TESTONLY000000",
  razorpay_key_secret: "testonly-secret-aaaaaaaaaaaa",
  razorpay_webhook_secret: "testonly-webhook-bbbbbbbb",
  gemini_api_key: "testonly-gemini-key-cccccccccccc",
  gemini_model: "gemini-flash-latest",
  whatsapp_provider: "meta",
  whatsapp_phone_number_id: "1000000001",
  whatsapp_access_token: "testonly-token-dddddddddddd",
  whatsapp_app_secret: "testonly-app-eeeeeeee",
  whatsapp_verify_token: "testonly-verify-ffff",
  sandbox_api_key: "testonly-sbx-key-gggg",
  sandbox_api_secret: "testonly-sbx-secret-hhhh",
  updated_at: "2026-10-06T00:00:00Z",
};

const req = (method = "GET") => new NextRequest("https://example.invalid/api/integrations/x", {
  method,
  headers: { "content-type": "application/json" },
  body: method === "GET" ? undefined : JSON.stringify({ key_id: "rzp_test_TESTONLY000000", api_key: "testonly-gemini-key-zzzzzzzzzzzz", phone_number_id: "1", access_token: "testonly-token-zzzzzzzz", api_secret: "x" }),
});

const GETS = {
  razorpay: () => razorpay.GET(req()),
  gemini: () => gemini.GET(),
  whatsapp: () => whatsapp.GET(req()),
  sandbox: () => sandbox.GET(),
};
const WRITES = {
  "razorpay POST": () => razorpay.POST(req("POST")),
  "razorpay DELETE": () => razorpay.DELETE(),
  "gemini POST": () => gemini.POST(req("POST")),
  "gemini DELETE": () => gemini.DELETE(),
  "whatsapp POST": () => whatsapp.POST(req("POST")),
  "whatsapp DELETE": () => whatsapp.DELETE(),
  "sandbox POST": () => sandbox.POST(req("POST")),
};

beforeEach(() => {
  db.me = { tenant_id: "T1", role: "manager" };
  db.secrets = { ...FAKE };
  db.writes = [];
});

describe("R-256 integration status is readable by owner, manager, billing", () => {
  for (const role of ["manager", "billing"]) {
    for (const [name, get] of Object.entries(GETS)) {
      it(`${role} GET ${name} → 200, configured, no secret preview`, async () => {
        db.me = { tenant_id: "T1", role };
        const res = await get();
        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.ok).toBe(true);
        expect(json.configured).toBe(true);
        expect(json.can_manage).toBe(false);
        const text = JSON.stringify(json);
        for (const k of Object.keys(json)) if (/mask/.test(k)) expect(json[k], k).toBeNull();
        for (const secret of [FAKE.razorpay_key_secret, FAKE.razorpay_webhook_secret, FAKE.gemini_api_key, FAKE.whatsapp_access_token, FAKE.whatsapp_app_secret, FAKE.whatsapp_verify_token, FAKE.sandbox_api_key, FAKE.sandbox_api_secret]) {
          expect(text).not.toContain(secret);
          expect(text).not.toContain(secret.slice(-4));
        }
      });
    }
  }

  it("razorpay status keeps mode and readiness for a manager", async () => {
    const json = await (await GETS.razorpay()).json();
    expect(json.mode).toBe("live");
    expect(json.readiness).toBeTruthy();
  });

  it.each(Object.entries(GETS))("owner GET %s → 200 with masks and can_manage", async (_n, get) => {
    db.me = { tenant_id: "T1", role: "owner" };
    const json = await (await get()).json();
    expect(json.can_manage).toBe(true);
    expect(Object.keys(json).filter((k) => /mask/.test(k)).some((k) => json[k] !== null)).toBe(true);
  });

  it.each(["sales", "support", "accountant", "delivery"])("%s GET → 403", async (role) => {
    db.me = { tenant_id: "T1", role };
    for (const get of Object.values(GETS)) expect((await get()).status).toBe(403);
  });
});

describe("R-256 saving and clearing stay owner-only", () => {
  for (const role of ["manager", "billing"]) {
    for (const [name, call] of Object.entries(WRITES)) {
      it(`${role} ${name} → 403, nothing written`, async () => {
        db.me = { tenant_id: "T1", role };
        expect((await call()).status).toBe(403);
        expect(db.writes).toEqual([]);
      });
    }
  }
});
