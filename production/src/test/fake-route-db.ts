/**
 * A tiny in-memory stand-in for the two Supabase clients an API route uses, for route tests
 * that pin WHO may call it (R-880). Not a Postgres: it knows select / eq / maybeSingle /
 * single / update / insert / rpc and storage upload / remove, enough to see whether a route
 * read the right row and whether it WROTE anything.
 *
 * `user` = the signed-in user (null → signed out). The user client sees every row the test
 * puts in `tables` (RLS is not modelled — the route's own checks are what is under test).
 */
type Row = Record<string, unknown>;

export interface FakeDb {
  user: { id: string; email?: string } | null;
  tables: Record<string, Row[]>;
  /** Every write: [client, table/bucket, op, payload]. Empty ⇒ the route wrote nothing. */
  writes: Array<[string, string, string, unknown]>;
  rpcCalls: Array<[string, unknown]>;
  rpcResult: { data: unknown; error: unknown };
}

export function newFakeDb(): FakeDb {
  return { user: null, tables: {}, writes: [], rpcCalls: [], rpcResult: { data: null, error: null } };
}

function query(db: FakeDb, who: string, table: string) {
  const filters: Array<[string, unknown]> = [];
  let op: "select" | "update" | "insert" = "select";
  let payload: unknown = null;
  const rows = () => (db.tables[table] ?? []).filter((r) => filters.every(([c, v]) => r[c] === v));
  const finish = () => {
    if (op !== "select") db.writes.push([who, table, op, { payload, filters: [...filters] }]);
    const found = rows();
    if (op === "update") for (const r of found) Object.assign(r, payload as Row);
    return found;
  };
  const q = {
    select() { return q; },
    eq(c: string, v: unknown) { filters.push([c, v]); return q; },
    order() { return q; },
    update(p: unknown) { op = "update"; payload = p; return q; },
    insert(p: unknown) { op = "insert"; payload = p; finish(); return Promise.resolve({ data: null, error: null }); },
    maybeSingle() { return Promise.resolve({ data: finish()[0] ?? null, error: null }); },
    single() {
      const r = finish()[0];
      return Promise.resolve(r ? { data: r, error: null } : { data: null, error: { code: "PGRST116", message: "no rows" } });
    },
    then(res: (v: { data: Row[]; error: null }) => unknown) { return Promise.resolve({ data: finish(), error: null }).then(res); },
  };
  return q;
}

function client(db: FakeDb, who: string) {
  return {
    auth: { getUser: async () => ({ data: { user: db.user } }) },
    from: (t: string) => query(db, who, t),
    rpc: async (fn: string, args: unknown) => {
      db.rpcCalls.push([fn, args]);
      db.writes.push([who, fn, "rpc", args]);
      return db.rpcResult;
    },
    storage: {
      from: (bucket: string) => ({
        upload: async (path: string) => { db.writes.push([who, bucket, "upload", path]); return { error: null }; },
        remove: async (paths: string[]) => { db.writes.push([who, bucket, "remove", paths]); return { error: null }; },
      }),
    },
  };
}

/** Pass to vi.mock("@/lib/supabase/server", () => fakeServerModule(db)). */
export function fakeServerModule(db: FakeDb) {
  return {
    createClient: () => client(db, "user"),
    createAdminClientFor: () => client(db, "admin"),
    createAdminClient: () => client(db, "admin"),
  };
}

export const TENANT_A = "aaaaaaaa-0000-4000-8000-000000000001";
export const TENANT_B = "bbbbbbbb-0000-4000-8000-000000000002";

/** Sign in as `role` of TENANT_A (or `tenant`). */
export function signInAs(db: FakeDb, role: string, tenant = TENANT_A, id = `u-${role}`) {
  db.user = { id, email: `${role}@example.test` };
  db.tables.users = [{ id, tenant_id: tenant, role }];
}
