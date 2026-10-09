/**
 * R-524 — PROOF against a real database (local docker Supabase) that a "Try the demo" session:
 *   - can read its own sample workspace,
 *   - cannot read another tenant's rows,
 *   - cannot write ANYTHING: insert / update / delete on tables, a SECURITY DEFINER RPC, or a
 *     storage upload — the database refuses, not just the app,
 * while the seeder (an ordinary login) is NOT read-only, so the wall is aimed at the visitor only.
 *
 * Needs migration 20261009220000 on the local database and PostgREST reloaded. Opt-in, because
 * it talks to a live database: DEMO_DB_TEST=1 npx vitest run src/lib/demo/demo-readonly.db.test.ts
 * (reads NEXT_PUBLIC_SUPABASE_URL / keys from .env.local, and refuses to run unless the URL is
 * a local 127.0.0.1 / localhost address).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { DEMO_SEEDER_EMAIL, DEMO_VISITOR_EMAIL } from "./demo-account";
import { ensureDemoTenant, readOnlyWallUp, resetDemoData, signInAs, type DemoTenantRow } from "./demo-account.server";

function localEnv(): Record<string, string> {
  try {
    const out: Record<string, string> = {};
    for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m) out[m[1]] = m[2].replace(/^"|"$/g, "");
    }
    return out;
  } catch {
    return {};
  }
}

const env = localEnv();
const url = env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const isLocal = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(url);
const run = process.env.DEMO_DB_TEST === "1" && isLocal && !!env.SUPABASE_SERVICE_ROLE_KEY;

const sessionless = (key: string): SupabaseClient =>
  createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });

describe.runIf(run)("demo session against the local database (R-524)", () => {
  let admin: SupabaseClient;
  let visitor: SupabaseClient;
  let seeder: SupabaseClient;
  let demo: DemoTenantRow;
  let otherTenant: string;
  let otherCustomer: string;

  beforeAll(async () => {
    admin = sessionless(env.SUPABASE_SERVICE_ROLE_KEY);
    const ensured = await ensureDemoTenant(admin);
    if (!ensured.ok) throw new Error(ensured.error);
    demo = ensured.demo;

    seeder = sessionless(env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
    const s = await signInAs(admin, seeder, DEMO_SEEDER_EMAIL);
    if (!s.ok) throw new Error(s.error);
    const reset = await resetDemoData(seeder, demo, { today: "2026-10-09", stamp: Date.now(), newId: randomUUID });
    if (!reset.ok) throw new Error(reset.error);

    // A real tenant with a customer the visitor must never see.
    otherTenant = randomUUID();
    otherCustomer = randomUUID();
    const t = await admin.from("tenants").insert({ id: otherTenant, name: "R-524 isolation check", email: "isolation@example.invalid" });
    if (t.error) throw new Error(t.error.message);
    const c = await admin.from("customers").insert({ id: otherCustomer, tenant_id: otherTenant, name: "Private customer" });
    if (c.error) throw new Error(c.error.message);

    visitor = sessionless(env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
    const v = await signInAs(admin, visitor, DEMO_VISITOR_EMAIL);
    if (!v.ok) throw new Error(v.error);
    return async () => {
      await admin.from("customers").delete().eq("id", otherCustomer);
      await admin.from("tenants").delete().eq("id", otherTenant);
    };
  }, 60_000);

  it("the read-only wall is up for the visitor, and only for the visitor", async () => {
    expect(await readOnlyWallUp(visitor)).toBe(true);
    expect(await readOnlyWallUp(seeder)).toBe(false);
  });

  it("reads its own sample workspace", async () => {
    const { data, error } = await visitor.from("customers").select("id, tenant_id");
    expect(error).toBeNull();
    expect((data ?? []).length).toBeGreaterThan(0);
    expect((data ?? []).every((r) => r.tenant_id === demo.tenant_id)).toBe(true);
  });

  it("cannot read another tenant", async () => {
    const byId = await visitor.from("customers").select("id").eq("id", otherCustomer);
    expect(byId.data ?? []).toEqual([]);
    const byTenant = await visitor.from("customers").select("id").eq("tenant_id", otherTenant);
    expect(byTenant.data ?? []).toEqual([]);
    const tenants = await visitor.from("tenants").select("id");
    expect((tenants.data ?? []).map((r) => r.id)).toEqual([demo.tenant_id]);
  });

  it("cannot insert, update or delete — in its own workspace or anywhere else", async () => {
    const ins = await visitor.from("customers").insert({ id: randomUUID(), tenant_id: demo.tenant_id, name: "DEMO · should fail" });
    expect(ins.error?.code).toBe("25006");
    const insOther = await visitor.from("customers").insert({ id: randomUUID(), tenant_id: otherTenant, name: "x" });
    expect(insOther.error).not.toBeNull();
    const upd = await visitor.from("customers").update({ name: "changed" }).eq("tenant_id", demo.tenant_id);
    expect(upd.error?.code).toBe("25006");
    const del = await visitor.from("customers").delete().eq("tenant_id", demo.tenant_id);
    expect(del.error?.code).toBe("25006");
    const settings = await visitor.from("tenants").update({ name: "hijacked" }).eq("id", demo.tenant_id);
    expect(settings.error?.code).toBe("25006");

    const { count } = await admin.from("customers").select("id", { count: "exact", head: true }).eq("tenant_id", demo.tenant_id).eq("name", "DEMO · should fail");
    expect(count).toBe(0);
  });

  it("cannot write through a SECURITY DEFINER RPC either", async () => {
    const r = await visitor.rpc("demo_data_clear_invoices");
    expect(r.error?.code).toBe("25006");
  });

  it("cannot upload a file", async () => {
    const r = await visitor.storage.from("documents").upload(`${demo.tenant_id}/r524-${Date.now()}.pdf`, new Blob(["%PDF-1.4"], { type: "application/pdf" }), { upsert: false, contentType: "application/pdf" });
    expect(r.error).not.toBeNull();
    // Same upload as the seeder (same tenant, same bucket) works — so it is the demo wall, not the path.
    const path = `${demo.tenant_id}/r524-seeder-${Date.now()}.pdf`;
    const ok = await seeder.storage.from("documents").upload(path, new Blob(["%PDF-1.4"], { type: "application/pdf" }), { upsert: false, contentType: "application/pdf" });
    expect(ok.error).toBeNull();
    await seeder.storage.from("documents").remove([path]);
  });

  it("the nightly reset is idempotent: a second run leaves the same sample set", async () => {
    const before = await admin.from("customers").select("id", { count: "exact", head: true }).eq("tenant_id", demo.tenant_id);
    const again = await resetDemoData(seeder, demo, { today: "2026-10-09", stamp: Date.now(), newId: randomUUID });
    expect(again.ok).toBe(true);
    const after = await admin.from("customers").select("id", { count: "exact", head: true }).eq("tenant_id", demo.tenant_id);
    expect(after.count).toBe(before.count);
  }, 60_000);
});
