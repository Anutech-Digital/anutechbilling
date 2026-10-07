/**
 * /api/webhooks/meta — R-117. Meta Lead Ads → leads, pinned with signed fake deliveries.
 * The Graph API is never called: every fetch is a vi.fn stand-in (no network in tests).
 *
 *  - GET handshake echoes the challenge only for the env verify token; no token → 403.
 *  - POST refuses with no app secret (503), no/bad signature (401), no tenant env (503).
 *  - A signed leadgen notice creates one lead in the env tenant, source "meta-ads", owner left
 *    to the R-111 trigger (not set here), answers mapped from field_data.
 *  - The same notice again creates nothing (deterministic id).
 *  - Same phone / email as an existing lead of the SAME tenant → no new lead, one note.
 *    A lead with that phone in ANOTHER tenant is not a duplicate.
 *  - No page token → stub lead with a note saying so; Graph never called.
 *  - Pages outside META_LEADS_PAGE_IDS are ignored.
 */
import crypto from "node:crypto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({ tables: {} as Record<string, Row[]> }));

vi.mock("@/lib/supabase/server", () => {
  function query(table: string) {
    const filters: ((r: Row) => boolean)[] = [];
    let lim = Infinity;
    const likeToRe = (pat: string) =>
      new RegExp("^" + pat.replace(/\\([\\%_])|([%_])|([.*+?^${}()|[\]])/g, (_m, esc, wild, re) =>
        esc ? `\\${esc}` : wild === "%" ? ".*" : wild === "_" ? "." : `\\${re}`) + "$", "is");
    const rows = () => (db.tables[table] ?? []).filter((r) => filters.every((f) => f(r))).slice(0, lim);
    const q: Record<string, unknown> = {
      select: () => q,
      eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return q; },
      ilike: (c: string, pat: string) => { const re = likeToRe(pat); filters.push((r) => re.test(String(r[c] ?? ""))); return q; },
      order: () => q,
      limit: (n: number) => { lim = n; return q; },
      maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
      insert: async (row: Row) => {
        const t = (db.tables[table] ??= []);
        if (row.id && t.some((r) => r.id === row.id)) return { data: null, error: { code: "23505", message: "duplicate key" } };
        t.push({ ...row });
        return { data: null, error: null };
      },
      then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) =>
        Promise.resolve({ data: rows(), error: null }).then(ok, bad),
    };
    return q;
  }
  return { createAdminClient: () => ({ from: (t: string) => query(t) }) };
});

import { GET, POST } from "./route";

const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const SECRET = "app_secret_aitest";
const PAGE = "1000001";
const ENV_KEYS = ["META_LEADS_VERIFY_TOKEN", "META_APP_SECRET", "META_LEADS_TENANT_ID", "META_LEADS_PAGE_IDS", "META_LEADS_PAGE_ACCESS_TOKEN", "META_GRAPH_VERSION"];

const fetchMock = vi.fn();

function graphReply(fields: Record<string, string>) {
  return {
    id: "x", created_time: "2026-10-07T03:00:00+0000", ad_id: "555", ad_name: "Workspace Oct", form_id: "777", campaign_name: "AITEST campaign",
    field_data: Object.entries(fields).map(([name, v]) => ({ name, values: [v] })),
  };
}
function okJson(body: unknown) { return { ok: true, status: 200, json: async () => body } as unknown as Response; }

function notice(leadgenId: string, pageId = PAGE) {
  return {
    object: "page",
    entry: [{ id: pageId, time: 1759806000, changes: [{ field: "leadgen", value: { leadgen_id: leadgenId, page_id: pageId, form_id: "777", ad_id: "555", created_time: 1759806000 } }] }],
  };
}
function signed(body: unknown, secret: string | null = SECRET, override?: string) {
  const raw = JSON.stringify(body);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (override !== undefined) headers["x-hub-signature-256"] = override;
  else if (secret) headers["x-hub-signature-256"] = "sha256=" + crypto.createHmac("sha256", secret).update(raw).digest("hex");
  return new NextRequest("http://localhost/api/webhooks/meta", { method: "POST", body: raw, headers });
}
const leads = () => db.tables.leads ?? [];
const notes = () => db.tables.lead_activities ?? [];

beforeEach(() => {
  db.tables = { leads: [], lead_activities: [] };
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.META_LEADS_VERIFY_TOKEN = "verify_aitest";
  process.env.META_APP_SECRET = SECRET;
  process.env.META_LEADS_TENANT_ID = TENANT;
  process.env.META_LEADS_PAGE_ACCESS_TOKEN = "page_token_aitest";
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(okJson(graphReply({ full_name: "Asha Verma", email: "Asha@Example.in", phone_number: "+91 98765-43210", company_name: "AITEST Traders", city: "Ludhiana", "how_many_users?": "12" })));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); for (const k of ENV_KEYS) delete process.env[k]; });

describe("GET handshake", () => {
  const url = (token: string) => `http://localhost/api/webhooks/meta?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=CH123`;
  it("echoes the challenge for the env verify token", async () => {
    const res = await GET(new NextRequest(url("verify_aitest")));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("CH123");
  });
  it("refuses a wrong token, and every token when none is configured", async () => {
    expect((await GET(new NextRequest(url("nope")))).status).toBe(403);
    delete process.env.META_LEADS_VERIFY_TOKEN;
    expect((await GET(new NextRequest(url("verify_aitest")))).status).toBe(403);
  });
});

describe("POST refusals", () => {
  it("no app secret → 503, nothing written, Graph not called", async () => {
    delete process.env.META_APP_SECRET;
    const res = await POST(signed(notice("9001")));
    expect(res.status).toBe(503);
    expect(leads()).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("missing or wrong signature → 401", async () => {
    expect((await POST(signed(notice("9001"), null))).status).toBe(401);
    expect((await POST(signed(notice("9001"), "wrong_secret"))).status).toBe(401);
    expect(leads()).toHaveLength(0);
  });
  it("no tenant configured → 503, never a guessed tenant", async () => {
    delete process.env.META_LEADS_TENANT_ID;
    expect((await POST(signed(notice("9001")))).status).toBe(503);
    process.env.META_LEADS_TENANT_ID = "not-a-uuid";
    expect((await POST(signed(notice("9001")))).status).toBe(503);
    expect(leads()).toHaveLength(0);
  });
});

describe("POST leadgen", () => {
  it("creates one lead in the env tenant with mapped answers, source meta-ads, no owner set", async () => {
    const res = await POST(signed(notice("9001")));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ created: 1 });
    expect(leads()).toHaveLength(1);
    const l = leads()[0];
    expect(l).toMatchObject({
      tenant_id: TENANT, source: "meta-ads", stage: "new", company: "AITEST Traders",
      contact_name: "Asha Verma", contact_email: "asha@example.in", contact_phone: "+91 98765-43210",
      utm_campaign: "AITEST campaign",
    });
    expect(l.owner_id).toBeUndefined();
    expect(String(l.notes)).toContain("how many users?: 12");
    expect(String(l.notes)).toContain("City: Ludhiana");
    /* token in a header, never in the URL */
    const [calledUrl, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toContain("/v21.0/9001?fields=");
    expect(calledUrl).not.toContain("page_token_aitest");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer page_token_aitest");
  });

  it("the same notice delivered again creates nothing more", async () => {
    await POST(signed(notice("9001")));
    const res = await POST(signed(notice("9001")));
    expect(await res.json()).toMatchObject({ created: 0, already_imported: 1 });
    expect(leads()).toHaveLength(1);
  });

  it("same phone as an existing lead in this tenant → no new lead, one note (once)", async () => {
    db.tables.leads.push({ id: "L-OLD", tenant_id: TENANT, is_junk: false, contact_phone: "9876543210", contact_email: null, company: "Old" });
    fetchMock.mockResolvedValue(okJson(graphReply({ full_name: "Asha", phone_number: "+919876543210" })));
    const res = await POST(signed(notice("9002")));
    expect(await res.json()).toMatchObject({ created: 0, duplicate: 1 });
    expect(leads()).toHaveLength(1);
    await POST(signed(notice("9002")));
    expect(notes()).toHaveLength(1);
    expect(notes()[0]).toMatchObject({ tenant_id: TENANT, lead_id: "L-OLD", kind: "note" });
    expect(String(notes()[0].detail)).toContain("Meta lead 9002");
  });

  it("same email (any case) as an existing lead → duplicate", async () => {
    db.tables.leads.push({ id: "L-OLD", tenant_id: TENANT, is_junk: false, contact_phone: null, contact_email: "asha@example.in", company: "Old" });
    const res = await POST(signed(notice("9003")));
    expect(await res.json()).toMatchObject({ duplicate: 1 });
    expect(leads()).toHaveLength(1);
  });

  it("a match in ANOTHER tenant (or a junk lead) is not a duplicate", async () => {
    db.tables.leads.push({ id: "L-THEIRS", tenant_id: OTHER, is_junk: false, contact_phone: "9876543210", contact_email: "asha@example.in", company: "X" });
    db.tables.leads.push({ id: "L-JUNK", tenant_id: TENANT, is_junk: true, contact_phone: "9876543210", contact_email: "asha@example.in", company: "Y" });
    const res = await POST(signed(notice("9004")));
    expect(await res.json()).toMatchObject({ created: 1 });
    expect(notes()).toHaveLength(0);
  });

  it("no page token → stub lead that says why, Graph never called", async () => {
    delete process.env.META_LEADS_PAGE_ACCESS_TOKEN;
    await POST(signed(notice("9005")));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(leads()[0]).toMatchObject({ company: "Facebook lead 9005", source: "meta-ads", contact_phone: null });
    expect(String(leads()[0].notes)).toContain("META_LEADS_PAGE_ACCESS_TOKEN is not set");
  });

  it("Graph error → stub lead with the HTTP status, still 200", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 400, json: async () => ({}) } as unknown as Response);
    const res = await POST(signed(notice("9006")));
    expect(res.status).toBe(200);
    expect(String(leads()[0].notes)).toContain("HTTP 400");
  });

  it("only pages listed in META_LEADS_PAGE_IDS are taken", async () => {
    process.env.META_LEADS_PAGE_IDS = "1000001, 1000002";
    const res = await POST(signed(notice("9007", "3333333")));
    expect(await res.json()).toMatchObject({ created: 0, ignored: 1 });
    expect(leads()).toHaveLength(0);
    await POST(signed(notice("9008", "1000002")));
    expect(leads()).toHaveLength(1);
  });

  it("non-leadgen payloads and non-numeric ids are ignored", async () => {
    const res = await POST(signed({ object: "page", entry: [{ id: PAGE, changes: [{ field: "feed", value: {} }, { field: "leadgen", value: { leadgen_id: "../x" } }] }] }));
    expect(res.status).toBe(200);
    expect(leads()).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
