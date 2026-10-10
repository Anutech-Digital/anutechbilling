/**
 * Seeds one row per tenant table for two tenants, generically, so the isolation suite can
 * cover EVERY table the catalog lists — including ones added after this file was written.
 *
 * Runs as the local superuser with session_replication_role = replica: that switches off
 * foreign-key and trigger checks (we want one row in each table, not a coherent business),
 * while CHECK constraints still apply — so values are chosen to satisfy them: the first
 * allowed literal of an `= ANY (ARRAY[...])` check, the first label of an enum, otherwise a
 * small value. A table that still cannot be seeded is reported, and the suite FAILS on it
 * until tests/isolation/seed-overrides.ts says how — a silent gap is the one thing this
 * suite must not have.
 */
import pg from "pg";
import { randomUUID } from "node:crypto";
import { SEED_OVERRIDES } from "./seed-overrides";

export interface Col {
  name: string;
  type: string;
  typtype: string;
  typcategory: string;
  enumFirst: string | null;
  isArray: boolean;
  notNull: boolean;
  hasDefault: boolean;
  generated: boolean;
}

export async function tenantTables(admin: pg.Client): Promise<{ table: string; rls: boolean; force: boolean }[]> {
  const { rows } = await admin.query(`
    select c.relname as table, c.relrowsecurity as rls, c.relforcerowsecurity as force
      from pg_class c
     where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
       and exists (select 1 from pg_attribute a where a.attrelid = c.oid
                    and a.attname = 'tenant_id' and not a.attisdropped)
     order by c.relname`);
  return rows;
}

async function columns(admin: pg.Client, table: string): Promise<Col[]> {
  const { rows } = await admin.query(
    `select a.attname as name, format_type(a.atttypid, a.atttypmod) as type,
            coalesce(et.typtype, t.typtype) as typtype, coalesce(et.typcategory, t.typcategory) as typcategory,
            (select e.enumlabel from pg_enum e where e.enumtypid = coalesce(et.oid, t.oid) order by e.enumsortorder limit 1) as "enumFirst",
            (t.typcategory = 'A') as "isArray",
            a.attnotnull as "notNull", a.atthasdef as "hasDefault",
            (a.attgenerated <> '' or a.attidentity <> '') as generated
       from pg_attribute a
       join pg_type t on t.oid = a.atttypid
       left join pg_type et on et.oid = t.typelem and t.typcategory = 'A'
      where a.attrelid = $1::regclass and a.attnum > 0 and not a.attisdropped
      order by a.attnum`,
    [`public."${table}"`],
  );
  return rows;
}

async function checkLiterals(admin: pg.Client, table: string): Promise<Map<string, string>> {
  const { rows } = await admin.query(
    `select pg_get_constraintdef(oid) as def from pg_constraint where conrelid = $1::regclass and contype = 'c'`,
    [`public."${table}"`],
  );
  const out = new Map<string, string>();
  for (const { def } of rows as { def: string }[]) {
    // ((status = ANY (ARRAY['draft'::text, 'sent'::text]))) — Postgres' normal form for IN (...)
    const m = def.match(/\(?\(?"?(\w+)"?\)?(?:::\w+)? = ANY \(\(?ARRAY\['((?:[^']|'')*)'/);
    if (m && !out.has(m[1])) out.set(m[1], m[2].replace(/''/g, "'"));
  }
  return out;
}

function valueFor(col: Col, allowed: Map<string, string>): unknown {
  const lit = allowed.get(col.name);
  if (lit !== undefined) return col.isArray ? [lit] : lit;
  if (col.typtype === "e") return col.isArray ? [col.enumFirst] : col.enumFirst;
  if (col.isArray) return [];
  const t = col.type;
  if (t === "uuid") return randomUUID();
  if (t === "boolean") return false;
  if (/^(smallint|integer|bigint|numeric|real|double)/.test(t)) return 1;
  if (/^(date|timestamp)/.test(t)) return new Date();
  if (/^time/.test(t)) return "10:00";
  if (/^interval/.test(t)) return "1 day";
  if (/^jsonb?$/.test(t)) return {};
  if (t === "inet") return "127.0.0.1";
  if (t === "bytea") return Buffer.from("x");
  const len = Number(t.match(/\((\d+)\)/)?.[1] ?? 12);
  return ("iso" + randomUUID().replace(/-/g, "")).slice(0, Math.max(1, Math.min(len, 12)));
}

/** Insert one row into `table` for `tenantId`, returning its primary-key-free fingerprint. */
export async function seedRow(admin: pg.Client, table: string, tenantId: string, extra: Record<string, unknown> = {}): Promise<void> {
  const cols = await columns(admin, table);
  const allowed = await checkLiterals(admin, table);
  const values: Record<string, unknown> = { tenant_id: tenantId };
  for (const c of cols) {
    if (c.name in values || c.generated) continue;
    if (c.notNull && !c.hasDefault) values[c.name] = valueFor(c, allowed);
  }
  Object.assign(values, SEED_OVERRIDES[table]?.(tenantId) ?? {}, extra);
  const names = Object.keys(values);
  const sql = `insert into public."${table}" (${names.map((n) => `"${n}"`).join(", ")})
               values (${names.map((_, i) => `$${i + 1}`).join(", ")})`;
  const params = names.map((n) => {
    const v = values[n];
    return v !== null && typeof v === "object" && !(v instanceof Date) && !Array.isArray(v) && !Buffer.isBuffer(v) ? JSON.stringify(v) : v;
  });
  await admin.query("savepoint seed");
  try {
    await admin.query(sql, params);
    await admin.query("release savepoint seed");
  } catch (e) {
    await admin.query("rollback to savepoint seed");
    throw new Error(`seed ${table}: ${(e as Error).message}`);
  }
}

export interface World {
  tenantA: string;
  tenantB: string;
  userA: string;
  userB: string;
  seeded: string[];
  unseedable: { table: string; error: string }[];
}

/** Two tenants, an owner in each, and one row per tenant table for each tenant. Committed. */
export async function buildWorld(admin: pg.Client): Promise<World> {
  const w: World = { tenantA: randomUUID(), tenantB: randomUUID(), userA: randomUUID(), userB: randomUUID(), seeded: [], unseedable: [] };
  await admin.query("begin");
  await admin.query("set local session_replication_role = replica");
  for (const [tenant, user, tag] of [[w.tenantA, w.userA, "a"], [w.tenantB, w.userB, "b"]] as const) {
    await admin.query(`insert into public.tenants (id, name, email) values ($1, $2, $3)`, [tenant, `Isolation ${tag}`, `iso-${tag}@example.test`]);
    await admin.query(`insert into auth.users (id, email) values ($1, $2)`, [user, `owner-${tag}-${user.slice(0, 8)}@example.test`]);
    await admin.query(`insert into public.users (id, tenant_id, email, role) values ($1, $2, $3, 'owner')`,
      [user, tenant, `owner-${tag}-${user.slice(0, 8)}@example.test`]);
  }
  for (const { table } of await tenantTables(admin)) {
    if (table === "users") { w.seeded.push(table); continue; }
    try {
      await seedRow(admin, table, w.tenantA);
      await seedRow(admin, table, w.tenantB);
      w.seeded.push(table);
    } catch (e) {
      w.unseedable.push({ table, error: (e as Error).message });
    }
  }
  await admin.query("commit");
  return w;
}
