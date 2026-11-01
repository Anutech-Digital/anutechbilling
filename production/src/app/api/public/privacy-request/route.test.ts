/**
 * R-2013 (DPDP): the public "Your data" form. Start → an UNCONFIRMED request for the website
 * tenant with only the code's HASH stored, and the code emailed (mailer mocked — no real mail).
 * Verify → the hashed code goes to privacy_request_verify; its answer becomes plain words.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { createHmac } from "node:crypto";

const db = vi.hoisted(() => ({
  inserts: [] as Array<{ table: string; row: Record<string, unknown> }>,
  rpcs: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  rpcResult: { ok: true, due_by: "2026-12-02", kind: "erasure" } as Record<string, unknown>,
  mails: [] as Array<Record<string, unknown>>,
  mailStatus: "sent",
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: () => ({
    from: (table: string) => ({
      insert: async (row: Record<string, unknown>) => { db.inserts.push({ table, row }); return { error: null }; },
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { name: "Acme Cloud" }, error: null }) }) }),
    }),
    rpc: async (fn: string, args: Record<string, unknown>) => { db.rpcs.push({ fn, args }); return { data: db.rpcResult, error: null }; },
  }),
}));
vi.mock("@/lib/website-tenant", () => ({ websiteTenantId: () => "T-SITE", websiteTenantMissingBody: () => ({ error: "x" }) }));
vi.mock("@/lib/security/turnstile-guard", () => ({ turnstileRefusal: async () => null }));
vi.mock("@/lib/messaging", () => ({
  sendInternalEmail: vi.fn(async (m: Record<string, unknown>) => { db.mails.push(m); return { status: db.mailStatus }; }),
}));

import { POST as start } from "./route";
import { POST as verify } from "./verify/route";

let n = 0;
const req = (path: string, b: Record<string, unknown>) => new NextRequest(`https://example.invalid/api/public/${path}`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-forwarded-for": `198.51.100.${++n}` },
  body: JSON.stringify(b),
});
const form = (over: Record<string, unknown> = {}) => ({ fullName: "Asha Verma", email: `Asha${n}@Example.in`, kind: "erasure", ...over });

beforeEach(() => { db.inserts = []; db.rpcs = []; db.mails = []; db.mailStatus = "sent"; db.rpcResult = { ok: true, due_by: "2026-12-02", kind: "erasure" }; });

describe("start: the request is saved unconfirmed and a code is emailed", () => {
  it("stores the request for the website tenant with only the code's hash, and mails the code", async () => {
    const res = await start(req("privacy-request", form({ phone: "+91 98100 20130", details: "Please delete everything" })));
    expect(res.status).toBe(200);
    const body = await res.json();
    const row = db.inserts.find((i) => i.table === "privacy_requests")!.row;
    expect(row).toMatchObject({ id: body.requestId, tenant_id: "T-SITE", full_name: "Asha Verma", kind: "erasure", phone: "+91 98100 20130", details: "Please delete everything" });
    expect(row.email).toMatch(/^asha\d+@example\.in$/);           // lower-cased
    expect(row.otp_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row).not.toHaveProperty("status");                     // the database default: unverified
    const mail = db.mails[0];
    expect(mail.to).toBe(row.email);
    expect(mail.kind).toBe("privacy_request_code");
    const code = String(mail.subject).match(/^(\d{6}) /)![1];
    expect(String(mail.text)).toContain(code);
    expect(String(mail.text)).toContain("Acme Cloud");
    // the stored hash is the code's hash for THIS request — never the code itself
    expect(JSON.stringify(row)).not.toContain(code);
    expect(row.otp_hash).toBe(createHmac("sha256", "r1903-local-dev-otp-key").update(`r1903:${body.requestId}:privacy-request:${code}`).digest("hex"));
  });

  it("refuses a correction with nothing to correct, and a bad email", async () => {
    const a = await start(req("privacy-request", form({ kind: "correction" })));
    expect(a.status).toBe(400);
    expect((await a.json()).error).toMatch(/what is wrong/);
    const b = await start(req("privacy-request", form({ email: "not-an-email" })));
    expect(b.status).toBe(400);
    expect(db.inserts).toEqual([]);
  });

  it("a code that could not be emailed is an error, not a silent success", async () => {
    db.mailStatus = "failed";
    const res = await start(req("privacy-request", form()));
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/could not email the code/i);
  });

  it("limits one email to 3 requests an hour", async () => {
    const email = "repeat@example.in";
    for (let i = 0; i < 3; i++) expect((await start(req("privacy-request", form({ email })))).status).toBe(200);
    expect((await start(req("privacy-request", form({ email })))).status).toBe(429);
  });
});

describe("verify: the code is checked by the database, hashed here", () => {
  const id = "11111111-2222-4333-8444-555555555555";

  it("sends the hash of the code (never the code) for the website tenant, and answers the due date", async () => {
    const res = await verify(req("privacy-request/verify", { requestId: id, code: "123456" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, dueBy: "2026-12-02" });
    expect(db.rpcs[0].fn).toBe("privacy_request_verify");
    expect(db.rpcs[0].args).toMatchObject({ p_tenant_id: "T-SITE", p_id: id });
    expect(db.rpcs[0].args.p_otp_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(db.rpcs[0].args)).not.toContain("123456");
  });

  it("a wrong code says how many tries are left", async () => {
    db.rpcResult = { ok: false, reason: "wrong_code", left: 3 };
    const res = await verify(req("privacy-request/verify", { requestId: id, code: "000000" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/3 tries left/);
  });

  it("an expired code tells the person to send the form again", async () => {
    db.rpcResult = { ok: false, reason: "expired" };
    const res = await verify(req("privacy-request/verify", { requestId: id, code: "000000" }));
    expect((await res.json()).error).toMatch(/expired.*send the form again/i);
  });

  it("a code that is not 6 digits never reaches the database", async () => {
    const res = await verify(req("privacy-request/verify", { requestId: id, code: "12ab" }));
    expect(res.status).toBe(400);
    expect(db.rpcs).toEqual([]);
  });
});
