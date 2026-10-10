/**
 * The gateway answers exactly like PostgREST v12.2.3 (production's version) — proven by
 * sending the SAME supabase-js queries to a real PostgREST and to the gateway, against the
 * same database, and comparing data, count, status and error.
 *
 *   docker: ros-pg (npm run db:local) + ros-postgrest (see db/local/README or the plan doc)
 *   npm run test:isolation
 *
 * Writes cannot be replayed twice with the same ids, so each write runs on both sides with
 * its own ids and the results are compared with those ids masked.
 */
import pg from "pg";
import { createHmac, randomUUID } from "node:crypto";
import { PostgrestClient } from "@supabase/postgrest-js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { handlePostgrest } from "@/server/postgrest/handler";
import { disconnectGateway, type Identity } from "@/server/db/gateway";
import { disconnectDb } from "@/server/db";
import { buildWorld, tenantTables, type World } from "./seed";

const admin = new pg.Client({ connectionString: process.env.ADMIN_DATABASE_URL });
await admin.connect();
const TABLES = await tenantTables(admin);
let w: World;

function jwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ exp: Math.floor(Date.now() / 1000) + 3600, ...claims });
  const sig = createHmac("sha256", process.env.POSTGREST_JWT_SECRET!).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

type Side = { real: PostgrestClient; gw: PostgrestClient };

function sides(identity: Identity, claims: Record<string, unknown> | null): Side {
  const real = new PostgrestClient(process.env.POSTGREST_URL!, {
    headers: claims ? { Authorization: `Bearer ${jwt(claims)}` } : {},
  });
  const gw = new PostgrestClient("http://gateway.local/rest/v1", {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      return handlePostgrest({
        method: init?.method ?? "GET",
        path: url.pathname.replace(/^\/rest\/v1\//, ""),
        search: url.searchParams,
        headers: new Headers(init?.headers),
        body: typeof init?.body === "string" ? init.body : null,
      }, identity);
    },
  });
  return { real, gw };
}

let A: Side, B: Side, anon: Side, service: Side;

/** What a caller of supabase-js can observe. */
function view(r: { data: unknown; error: unknown; count: number | null; status: number }) {
  const e = r.error as { code?: string; message?: string; details?: string | null; hint?: string | null } | null;
  return { status: r.status, count: r.count, data: r.data, error: e ? { code: e.code, message: e.message, details: e.details ?? null, hint: e.hint ?? null } : null };
}

type Q = (c: PostgrestClient) => PromiseLike<{ data: unknown; error: unknown; count: number | null; status: number }>;

async function same(side: Side, q: Q, opts: { ignoreErrorText?: boolean } = {}) {
  const [real, gw] = await Promise.all([q(side.real), q(side.gw)]);
  const r = view(real), g = view(gw);
  if (opts.ignoreErrorText && r.error && g.error) {
    expect({ status: g.status, code: g.error.code }).toEqual({ status: r.status, code: r.error.code });
  } else {
    expect(g).toEqual(r);
  }
  return r;
}

beforeAll(async () => {
  w = await buildWorld(admin);
  A = sides({ mode: "user", userId: w.userA }, { sub: w.userA, role: "authenticated" });
  B = sides({ mode: "user", userId: w.userB }, { sub: w.userB, role: "authenticated" });
  anon = sides({ mode: "anon" }, null);
  service = sides({ mode: "service" }, { role: "service_role" });
});

afterAll(async () => {
  if (w) {
    await admin.query("begin");
    await admin.query("set local session_replication_role = replica");
    for (const { table } of TABLES) await admin.query(`delete from public."${table}" where tenant_id = any($1::uuid[])`, [[w.tenantA, w.tenantB]]);
    await admin.query(`delete from public.tenants where id = any($1::uuid[])`, [[w.tenantA, w.tenantB]]);
    await admin.query(`delete from auth.users where id = any($1::uuid[])`, [[w.userA, w.userB]]);
    await admin.query("commit");
  }
  await admin.end();
  await disconnectGateway();
  await disconnectDb();
});

describe("reads, as tenant A", () => {
  test.each(TABLES.map((t) => t.table))("select * from %s", async (t) => {
    await same(A, (c) => c.from(t).select("*").order("id" in {} ? "id" : "tenant_id"));
  });

  test("columns, order, limit", () => same(A, (c) => c.from("invoices").select("id, tenant_id, created_at").order("created_at", { ascending: false }).limit(5)));
  test("eq / neq / in / is", () => same(A, (c) => c.from("leads").select("id, stage").eq("tenant_id", w.tenantA).neq("stage", "zzz").in("tenant_id", [w.tenantA, w.tenantB]).is("deleted_at", null).order("id")));
  test("gt / gte / lt / lte on dates", () => same(A, (c) => c.from("invoices").select("id").gte("created_at", "2000-01-01").lt("created_at", "2999-01-01").order("id")));
  test("ilike with * wildcard", () => same(A, (c) => c.from("leads").select("id, company").ilike("company", "*iso*").order("id")));
  test("or + not", () => same(A, (c) => c.from("leads").select("id").or(`stage.eq.new,and(tenant_id.eq.${w.tenantA},stage.neq.lost)`).not("company", "is", null).order("id")));
  test("count exact + range", () => same(A, (c) => c.from("leads").select("id", { count: "exact" }).order("id").range(0, 0)));
  test("head + count", () => same(A, (c) => c.from("invoices").select("*", { count: "exact", head: true })));
  test("single on exactly one row", () => same(A, (c) => c.from("tenants").select("id, name").eq("id", w.tenantA).single()));
  test("single on zero rows → PGRST116", () => same(A, (c) => c.from("tenants").select("id").eq("id", w.tenantB).single()));
  test("maybeSingle on zero rows → null", () => same(A, (c) => c.from("tenants").select("id").eq("id", w.tenantB).maybeSingle()));
  test("match()", () => same(A, (c) => c.from("users").select("id, role").match({ id: w.userA, tenant_id: w.tenantA })));
});

describe("embedding", () => {
  test("to-one with alias and fk hint", () => same(A, (c) => c.from("leads").select("id, owner:users!leads_owner_id_fkey(full_name)").order("id")));
  test("to-one, several at once", () => same(A, (c) => c.from("tasks").select("*, leads(company), customers(name), quotes(customer_name)").order("id")));
  test("to-many", () => same(A, (c) => c.from("packages").select("id, name, package_items(item_id, qty_mode)").order("id")));
  test("star inside an embed", () => same(A, (c) => c.from("customer_contacts").select("role, is_primary, contacts(*)").order("customer_id")));
  test("ambiguous embed → PGRST201", () => same(A, (c) => c.from("leads").select("id, users(full_name)")));
  test("no relationship → PGRST200", () => same(A, (c) => c.from("leads").select("id, item_categories(name)"), { ignoreErrorText: true }));
});

describe("errors", () => {
  test("unknown table", () => same(A, (c) => c.from("no_such_table").select("*"), { ignoreErrorText: true }));
  test("unknown column", () => same(A, (c) => c.from("leads").select("nope"), { ignoreErrorText: true }));
  test("bad uuid input", () => same(A, (c) => c.from("leads").select("id").eq("id", "not-a-uuid")));
});

describe("isolation through the gateway", () => {
  test("A reading B's tenant row gets nothing", () => same(A, (c) => c.from("tenants").select("id").eq("id", w.tenantB)));
  test("B reading A's invoices gets nothing", () => same(B, (c) => c.from("invoices").select("id").eq("tenant_id", w.tenantA)));
  test("signed-out visitor sees no tenant data", () => same(anon, (c) => c.from("invoices").select("id").limit(5)));
  test("service role sees both tenants", () => same(service, (c) => c.from("tenants").select("id").in("id", [w.tenantA, w.tenantB]).order("id")));
});

describe("functions (rpc)", () => {
  test("scalar uuid", () => same(A, (c) => c.rpc("current_tenant_id")));
  test("scalar date", () => same(A, (c) => c.rpc("ist_today")));
  test("scalar with args", () => same(A, (c) => c.rpc("format_document_number", { p_prefix: "INV", p_fiscal_year: "2026-27", p_number: 7 })));
  test("jsonb result", () => same(A, (c) => c.rpc("lead_counts", { p_filters: {} })));
  test("set of scalars", () => same(A, (c) => c.rpc("get_subordinate_user_ids", { p_user_id: w.userA })));
  test("RETURNS TABLE", () => same(A, (c) => c.rpc("find_lead_duplicates", { p_phone: "x", p_email: "x", p_gstin: "x", p_company: "iso", p_exclude_id: null })));
  test("variadic text[]", () => same(A, (c) => c.rpc("current_user_has_role", { p_roles: ["owner", "manager"] })));
  test("unknown function → PGRST202", () => same(A, (c) => c.rpc("no_such_fn", { a: 1 }), { ignoreErrorText: true }));
});

describe("writes (ids masked)", () => {
  const mask = (v: unknown, ids: string[]): unknown => JSON.parse(ids.reduce((s, id) => s.split(id).join("<id>"), JSON.stringify(v))
    .replace(/"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(\+00:00|Z)?"/g, '"<ts>"'));

  async function both(side: Side, make: (id: string) => Q) {
    const idR = randomUUID(), idG = randomUUID();
    const [r, g] = await Promise.all([make(idR)(side.real), make(idG)(side.gw)]);
    expect(mask(view(g), [idG])).toEqual(mask(view(r), [idR]));
    return [idR, idG];
  }

  test("insert one, return it", async () => {
    await both(A, (id) => (c) => c.from("contacts").insert({ id, tenant_id: w.tenantA, full_name: "Parity Person", email: `p-${id.slice(0, 6)}@example.test` }).select("id, full_name").single());
  });
  test("insert many, minimal return", async () => {
    await both(A, (id) => (c) => c.from("contacts").insert([
      { id, tenant_id: w.tenantA, full_name: "One" },
      { id: randomUUID(), tenant_id: w.tenantA, full_name: "Two", phone: "+919800000000" },
    ]));
  });
  test("insert into the OTHER tenant is refused (RLS)", async () => {
    await both(A, (id) => (c) => c.from("contacts").insert({ id, tenant_id: w.tenantB, full_name: "Sneaky" }).select());
  });
  test("update with filter, return rows", async () => {
    const [r, g] = await both(A, (id) => (c) => c.from("contacts").insert({ id, tenant_id: w.tenantA, full_name: "Before" }));
    const [ur, ug] = await Promise.all([
      A.real.from("contacts").update({ full_name: "After" }).eq("id", r).select("full_name"),
      A.gw.from("contacts").update({ full_name: "After" }).eq("id", g).select("full_name"),
    ]);
    expect(view(ug)).toEqual(view(ur));
  });
  test("upsert on a unique column", async () => {
    await both(A, (id) => (c) => c.from("contacts").upsert({ id, tenant_id: w.tenantA, full_name: "Upserted" }, { onConflict: "id" }).select("full_name"));
  });
  test("delete with filter, return rows", async () => {
    const [r, g] = await both(A, (id) => (c) => c.from("contacts").insert({ id, tenant_id: w.tenantA, full_name: "Doomed" }));
    const [dr, dg] = await Promise.all([
      A.real.from("contacts").delete().eq("id", r).select("full_name"),
      A.gw.from("contacts").delete().eq("id", g).select("full_name"),
    ]);
    expect(view(dg)).toEqual(view(dr));
  });
  test("update that matches nothing in another tenant", async () => {
    await both(A, () => (c) => c.from("leads").update({ notes: "x" }).eq("tenant_id", w.tenantB).select("id"));
  });
});

describe("attacks on the gateway (it must refuse or treat them as data)", () => {
  async function gw(q: Q) {
    return view(await q(A.gw));
  }
  async function tableCount(): Promise<number> {
    return (await admin.query(`select count(*)::int as n from pg_class where relnamespace = 'public'::regnamespace`)).rows[0].n;
  }

  test("SQL in a column name is refused", async () => {
    const before = await tableCount();
    const r = await gw((c) => c.from("leads").select('id, "x"; drop table leads; --'));
    expect(r.error).not.toBeNull();
    expect(await tableCount()).toBe(before);
  });

  test("SQL in a table name is refused", async () => {
    const r = await gw((c) => c.from('leads"; drop table leads; --').select("id"));
    expect(r.status).toBe(404);
  });

  test("SQL in a cast is refused", async () => {
    const r = await gw((c) => c.from("leads").select("id::text); drop table leads; --"));
    expect(r.error?.code).toBe("PGRST100");
  });

  test("SQL in a filter VALUE is only data", async () => {
    const before = await tableCount();
    const r = await gw((c) => c.from("leads").select("id").eq("company", "x'); drop table leads; --"));
    expect(r).toMatchObject({ status: 200, data: [] });
    expect(await tableCount()).toBe(before);
  });

  test("SQL in an in() list is only data — and odd quoting is handled like PostgREST", async () => {
    const before = await tableCount();
    const r = await gw((c) => c.from("leads").select("id").in("company", ["b'); drop table leads; --", "c,d"]));
    expect(r).toMatchObject({ status: 200, data: [] });
    await same(A, (c) => c.from("leads").select("id").in("company", ['a"}', "x"]), { ignoreErrorText: true });
    expect(await tableCount()).toBe(before);
  });

  test("SQL in an order column is refused", async () => {
    const r = await gw((c) => c.from("leads").select("id").order("id; drop table leads"));
    expect(r.error).not.toBeNull();
  });

  test("SQL in an rpc name or argument name is refused", async () => {
    expect((await gw((c) => c.rpc("current_tenant_id); drop table leads; --"))).status).toBe(404);
    expect((await gw((c) => c.rpc("format_document_number", { 'p_prefix" text); drop table leads; --': "x" }))).error?.code).toBe("PGRST202");
  });

  test("SQL in an insert key is refused", async () => {
    const r = await gw((c) => c.from("contacts").insert({ tenant_id: w.tenantA, full_name: "x", 'notes") values (1); drop table leads; --': "y" }));
    expect(r.error?.code).toBe("42703");
  });

  test("an insert payload cannot set columns the table does not have, nor escape RLS", async () => {
    const r = await gw((c) => c.from("invoices").insert({ tenant_id: w.tenantB, id: "INV-ISO-ATTACK" }).select());
    expect(r.error).not.toBeNull();
    expect((await admin.query(`select count(*)::int as n from public.invoices where id = 'INV-ISO-ATTACK'`)).rows[0].n).toBe(0);
  });
});
