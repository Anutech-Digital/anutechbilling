/**
 * R-1550 — Meta WhatsApp handshake (GET) on BOTH WhatsApp routes:
 *   /api/webhooks/whatsapp                              (sales number)
 *   /api/v1/integrations/support-whatsapp-inbound       (support number)
 *
 *  - `whatsapp_verify_token` is in SECRET_COLUMNS, so /api/integrations/seal stores it as a
 *    `rosv1:…` envelope. The handshake must DECRYPT before comparing — before the fix a sealed
 *    token made every Meta "Verify and save" a 403.
 *  - Legacy plaintext rows still work.
 *  - "no such tenant", "no token saved", "wrong token" and "envelope cannot be opened" all get
 *    the SAME 403 body — different messages told anyone which companies have WhatsApp set up.
 *
 * No DB: createAdminClient is a stand-in over an in-memory tenant_secrets table.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { encryptSecret } from "@/lib/crypto/vault";

type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[] }));

vi.mock("@/lib/supabase/server", () => {
  function query() {
    const filters: ((r: Row) => boolean)[] = [];
    const q: Record<string, unknown> = {
      select: () => q,
      eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return q; },
      maybeSingle: async () => ({ data: db.rows.find((r) => filters.every((f) => f(r))) ?? null, error: null }),
    };
    return q;
  }
  const client = { from: () => query() };
  return { createAdminClient: () => client, createAdminClientFor: () => client, createClient: () => client };
});

import { GET as salesGET } from "./route";
import { GET as supportGET } from "../../v1/integrations/support-whatsapp-inbound/route";

const KEY = Buffer.alloc(32, 7).toString("base64");
const SEALED_TENANT = "11111111-1111-4111-8111-111111111111";
const PLAIN_TENANT = "22222222-2222-4222-8222-222222222222";
const EMPTY_TENANT = "33333333-3333-4333-8333-333333333333";
const BROKEN_TENANT = "44444444-4444-4444-8444-444444444444";
const NO_SUCH_TENANT = "55555555-5555-4555-8555-555555555555";

let originalKey: string | undefined;
beforeEach(() => {
  originalKey = process.env.SECRETS_MASTER_KEY;
  process.env.SECRETS_MASTER_KEY = KEY;
  db.rows = [
    { tenant_id: SEALED_TENANT, whatsapp_verify_token: encryptSecret("abc123") },
    { tenant_id: PLAIN_TENANT, whatsapp_verify_token: "plain-token" },
    { tenant_id: EMPTY_TENANT, whatsapp_verify_token: null },
    /* An envelope that does not open (wrong master key / altered) — must not throw a 500. */
    { tenant_id: BROKEN_TENANT, whatsapp_verify_token: "rosv1:a:b:c:d:e:f" },
  ];
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  if (originalKey === undefined) delete process.env.SECRETS_MASTER_KEY;
  else process.env.SECRETS_MASTER_KEY = originalKey;
  vi.restoreAllMocks();
});

const ROUTES = [
  ["webhooks/whatsapp", salesGET, "http://localhost/api/webhooks/whatsapp"],
  ["support-whatsapp-inbound", supportGET, "http://localhost/api/v1/integrations/support-whatsapp-inbound"],
] as const;

const req = (base: string, tenant: string, token: string) =>
  new NextRequest(`${base}?tenant=${tenant}&hub.mode=subscribe&hub.verify_token=${encodeURIComponent(token)}&hub.challenge=42`);

describe.each(ROUTES)("%s GET handshake", (_name, GET, base) => {
  it("sealed (encrypted) verify token → challenge echoed — ASLI BUG", async () => {
    const res = await GET(req(base, SEALED_TENANT, "abc123"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("42");
  });

  it("purana plaintext token bhi chalta hai", async () => {
    const res = await GET(req(base, PLAIN_TENANT, "plain-token"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("42");
  });

  it("the envelope string itself is NOT accepted as the token", async () => {
    const sealed = String(db.rows[0].whatsapp_verify_token);
    expect((await GET(req(base, SEALED_TENANT, sealed))).status).toBe(403);
  });

  it("no such tenant / no token / wrong token / unopenable envelope → identical 403", async () => {
    const cases = [
      req(base, NO_SUCH_TENANT, "abc123"),
      req(base, EMPTY_TENANT, "abc123"),
      req(base, SEALED_TENANT, "wrong"),
      req(base, BROKEN_TENANT, "abc123"),
    ];
    const answers: string[] = [];
    for (const r of cases) {
      const res = await GET(r);
      expect(res.status).toBe(403);
      answers.push(await res.text());
    }
    expect(new Set(answers).size).toBe(1);
  });
});
