/**
 * PROOF that one tenant cannot reach another tenant's rows through the Prisma path —
 * for EVERY table with a tenant_id column, read from the live catalog (not a hand list),
 * so a table added tomorrow is covered tomorrow, and one added without RLS fails here.
 *
 *   npm run db:local          # once: builds the local database from git
 *   npm run test:isolation    # this suite
 *
 * scripts/isolation-mutation.mjs breaks the guard on purpose in four different ways and
 * requires this suite to go RED each time — so a green run here means something.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { dbFor, disconnectDb, withTenant, type TenantSession } from "@/server/db";
import { disconnectJobsDb, listTenantsForJobs, withJobsTenant } from "@/server/db/jobs";
import { buildWorld, tenantTables, type World } from "./seed";
import visibility from "./visibility.json";

const admin = new pg.Client({ connectionString: process.env.ADMIN_DATABASE_URL });
await admin.connect();
const TABLES = await tenantTables(admin);

let w: World;
let A: TenantSession;
let B: TenantSession;

const q = (t: string) => `public."${t}"`;
async function countFor(tenant: string, table: string): Promise<number> {
  const r = await admin.query(`select count(*)::int as n from ${q(table)} where tenant_id = $1`, [tenant]);
  return r.rows[0].n;
}

beforeAll(async () => {
  w = await buildWorld(admin);
  A = { userId: w.userA, tenantId: w.tenantA };
  B = { userId: w.userB, tenantId: w.tenantB };
});

afterAll(async () => {
  if (w) {
    await admin.query("begin");
    await admin.query("set local session_replication_role = replica");
    for (const { table } of TABLES) {
      await admin.query(`delete from ${q(table)} where tenant_id = any($1::uuid[])`, [[w.tenantA, w.tenantB]]);
    }
    await admin.query(`delete from public.tenants where id = any($1::uuid[])`, [[w.tenantA, w.tenantB]]);
    await admin.query(`delete from auth.users where id = any($1::uuid[])`, [[w.userA, w.userB]]);
    await admin.query("commit");
  }
  await admin.end();
  await disconnectDb();
  await disconnectJobsDb();
});

describe("the catalog", () => {
  test("there are tenant tables to check (a broken query must not pass with zero)", () => {
    expect(TABLES.length).toBeGreaterThan(150);
  });

  test("every tenant table has RLS switched on", () => {
    expect(TABLES.filter((t) => !t.rls).map((t) => t.table)).toEqual([]);
  });

  test("every tenant table could be seeded — no silent gaps", () => {
    expect(w.unseedable).toEqual([]);
  });

  test("no policy or function reads the JWT directly (it would bypass the Prisma context)", async () => {
    const { rows } = await admin.query(`
      select 'policy ' || tablename || '.' || policyname as what from pg_policies
       where coalesce(qual,'') || coalesce(with_check,'') ~ 'auth\\.(uid|role)\\(\\)'
      union all
      select 'function ' || p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname in ('public','storage') and p.prosrc ~ 'auth\\.(uid|role)\\(\\)'
         and p.proname not in ('current_user_id','current_request_role','current_tenant_id')`);
    expect(rows.map((r) => r.what)).toEqual([]);
  });
});

describe("the database logins", () => {
  test("app_runtime and app_jobs cannot skip RLS: not superuser, no BYPASSRLS, own nothing", async () => {
    const { rows } = await admin.query(`
      select r.rolname, r.rolsuper, r.rolbypassrls,
             (select count(*)::int from pg_class c where c.relowner = r.oid) as owns
        from pg_roles r where r.rolname in ('app_runtime', 'app_jobs') order by 1`);
    expect(rows).toEqual([
      { rolname: "app_jobs", rolsuper: false, rolbypassrls: false, owns: 0 },
      { rolname: "app_runtime", rolsuper: false, rolbypassrls: false, owns: 0 },
    ]);
  });

  test("they are members of `authenticated` only — never service_role or anon", async () => {
    const { rows } = await admin.query(`
      select m.rolname as member, r.rolname as role from pg_auth_members am
        join pg_roles r on r.oid = am.roleid join pg_roles m on m.oid = am.member
       where m.rolname in ('app_runtime', 'app_jobs') order by 1, 2`);
    expect(rows).toEqual([
      { member: "app_jobs", role: "authenticated" },
      { member: "app_runtime", role: "authenticated" },
    ]);
  });

  test("the app's connection really is app_runtime", async () => {
    const who = await withTenant(A, (tx) => tx.$queryRaw<{ s: string }[]>`select session_user::text as s`);
    expect(who[0].s).toBe("app_runtime");
  });
});

describe("context lives for one transaction only (why the pool cannot leak it)", () => {
  test("set_config(..., true) is gone after COMMIT on the same connection", async () => {
    const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    await c.query("begin");
    await c.query("select set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)", [w.tenantA, w.userA]);
    const inside = await c.query("select current_setting('app.tenant_id', true) as t");
    await c.query("commit");
    const after = await c.query("select current_setting('app.tenant_id', true) as t, public.current_tenant_id() as ct");
    await c.end();
    expect(inside.rows[0].t).toBe(w.tenantA);
    expect(after.rows[0].t ?? "").toBe("");
    expect(after.rows[0].ct).toBeNull();
  });

  test("no context at all → zero rows from every tenant table (forgetting fails closed)", async () => {
    const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    const leaks: string[] = [];
    for (const { table } of TABLES) {
      try {
        // tenant_id IS NULL rows are shared on purpose (e.g. campaign_templates.is_system).
        const r = await c.query(`select count(*)::int as n from ${q(table)} where tenant_id is not null`);
        if (r.rows[0].n > 0) leaks.push(`${table}: ${r.rows[0].n}`);
      } catch {
        /* permission denied is also "no rows" */
      }
    }
    await c.end();
    expect(leaks).toEqual([]);
  });

  test("pool of ONE connection, 60 interleaved A/B requests: each sees only its own tenant", async () => {
    const runs = Array.from({ length: 60 }, (_, i) => (i % 2 === 0 ? A : B));
    const seen = await Promise.all(runs.map((s) =>
      withTenant(s, async (tx) => {
        const rows = await tx.$queryRaw<{ tenant_id: string }[]>`select distinct tenant_id::text from public.invoices`;
        return { want: s.tenantId, got: rows.map((r) => r.tenant_id) };
      })));
    for (const { want, got } of seen) expect(got).toEqual([want]);
  });

  test("a session that names the WRONG tenant for its user sees nothing (helper cross-checks users)", async () => {
    const forged = { userId: w.userA, tenantId: w.tenantB };
    const rows = await withTenant(forged, (tx) => tx.$queryRaw<{ n: number }[]>`select count(*)::int as n from public.invoices`);
    expect(rows[0].n).toBe(0);
  });

  test("the client-extension form (dbFor) is scoped the same way", async () => {
    const rows = await dbFor(A).invoices.findMany({ select: { tenant_id: true } });
    expect(new Set(rows.map((r) => r.tenant_id))).toEqual(new Set([w.tenantA]));
  });
});

describe("tables without a tenant_id column", () => {
  test("tenants: A sees only its own tenant row", async () => {
    const rows = await withTenant(A, (tx) => tx.tenants.findMany({ select: { id: true } }));
    expect(rows.map((r) => r.id)).toEqual([w.tenantA]);
  });

  test("the other non-tenant tables have RLS on and show A nothing that is not shared", async () => {
    const { rows } = await admin.query(`
      select c.relname as t, c.relrowsecurity as rls from pg_class c
       where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','p') and c.relname <> 'tenants'
         and not exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped)
       order by 1`);
    expect(rows.filter((r) => !r.rls).map((r) => r.t)).toEqual([]);
    for (const { t } of rows) {
      const n = await withTenant(A, (tx) => tx.$queryRawUnsafe<{ n: number }[]>(`select count(*)::int as n from ${q(t)}`)).catch(() => [{ n: 0 }]);
      expect({ t, visible: n[0].n }).toEqual({ t, visible: 0 });
    }
  });
});

describe("background jobs", () => {
  test("jobs can list tenants, but per-tenant work sees only that tenant", async () => {
    const ids = await listTenantsForJobs();
    expect(ids).toEqual(expect.arrayContaining([w.tenantA, w.tenantB]));
    const rows = await withJobsTenant(w.tenantB, (tx) => tx.$queryRaw<{ t: string }[]>`select distinct tenant_id::text as t from public.invoices`);
    expect(rows.map((r) => r.t)).toEqual([w.tenantB]);
  });

  test("the web app's login cannot list tenants", async () => {
    await expect(withTenant(A, (tx) => tx.$queryRaw`select * from public.jobs_list_tenants()`)).rejects.toThrow(/permission denied/i);
  });
});

describe.each(TABLES.map((t) => t.table))("%s", (table) => {
  test("tenant A cannot read tenant B's rows", async () => {
    const rows = await withTenant(A, (tx) =>
      tx.$queryRawUnsafe<{ t: string }[]>(`select distinct tenant_id::text as t from ${q(table)}`)).catch(() => []);
    expect(rows.map((r) => r.t)).not.toContain(w.tenantB);
  });

  test("tenant A sees its own row exactly as the old Supabase path does (both paths agree)", async () => {
    const viaPrisma = await withTenant(A, (tx) =>
      tx.$queryRawUnsafe<{ n: number }[]>(`select count(*)::int as n from ${q(table)} where tenant_id = $1::uuid`, w.tenantA)).catch(() => [{ n: -1 }]);
    // PostgREST path, simulated the way supabase/tests do it: role authenticated + JWT claims.
    await admin.query("begin");
    await admin.query("set local role authenticated");
    await admin.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: w.userA, role: "authenticated" })]);
    const viaPostgrest = await admin.query(`select count(*)::int as n from ${q(table)} where tenant_id = $1`, [w.tenantA])
      .then((r) => r.rows, () => [{ n: -1 }]);
    await admin.query("rollback");
    expect({ table, prisma: viaPrisma[0].n }).toEqual({ table, prisma: viaPostgrest[0].n });
  });

  test("tenant A can read its own row — or the table is on the known not-visible list", async () => {
    const rows = await withTenant(A, (tx) =>
      tx.$queryRawUnsafe<{ n: number }[]>(`select count(*)::int as n from ${q(table)} where tenant_id = $1::uuid`, w.tenantA)).catch(() => [{ n: 0 }]);
    const visible = rows[0].n > 0;
    expect({ table, visible }).toEqual({ table, visible: !(visibility.hiddenFromOwner as string[]).includes(table) });
  });

  test("tenant A cannot change or delete tenant B's rows", async () => {
    const before = await countFor(w.tenantB, table);
    const changed = await withTenant(A, async (tx) => {
      const u = await tx.$executeRawUnsafe(`update ${q(table)} set tenant_id = tenant_id where tenant_id = $1::uuid`, w.tenantB);
      const d = await tx.$executeRawUnsafe(`delete from ${q(table)} where tenant_id = $1::uuid`, w.tenantB);
      return u + d;
    }).catch(() => 0);
    expect(changed).toBe(0);
    expect(await countFor(w.tenantB, table)).toBe(before);
  });

  test("tenant A cannot add a row into tenant B", async () => {
    const before = await countFor(w.tenantB, table);
    const src = await admin.query(`select to_jsonb(t) as j from ${q(table)} t where tenant_id = $1 limit 1`, [w.tenantB]);
    const row = src.rows[0]?.j as Record<string, unknown> | undefined;
    if (row) {
      if (typeof row.id === "string") row.id = crypto.randomUUID();
      await withTenant(A, (tx) => tx.$executeRawUnsafe(
        `insert into ${q(table)} select * from jsonb_populate_record(null::${q(table)}, $1::jsonb)`, JSON.stringify(row))).catch(() => 0);
    }
    expect(await countFor(w.tenantB, table)).toBe(before);
  });
});
