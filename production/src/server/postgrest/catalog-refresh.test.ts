/**
 * R-1671: staging 19 Oct — the app was deployed before the DB step, so after "DB READY" the new
 * column payments.credit_applied still answered 400 "column payments.credit_applied does not
 * exist" until Cloud Run was restarted: the gateway read the schema catalog once per instance
 * and kept it forever. A name missing from the catalog must make the gateway re-read it (once,
 * rate-limited, shared by concurrent requests) and retry — without resetCatalog() or a restart.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* A fake database: the catalog queries answer from `schema`, any other query is the data query. */
const schema = {
  columns: [] as { table: string; name: string; type: string }[],
  fns: [] as string[],
  catalogLoads: 0,
  loadDelay: null as Promise<void> | null,
};

vi.mock("@/server/db/gateway", () => ({
  withIdentity: async (_id: unknown, fn: (tx: unknown) => unknown) => fn({
    $queryRawUnsafe: async (sql: string) => {
      if (sql.includes("from pg_class c join pg_attribute")) {
        schema.catalogLoads++;
        if (schema.loadDelay) await schema.loadDelay;
        return schema.columns.map((c) => ({
          table: c.table, kind: "table", name: c.name, type: c.type,
          has_default: false, generated: false, sel_auth: true, sel_anon: true,
        }));
      }
      if (sql.includes("from pg_constraint")) {
        return [...new Set(schema.columns.map((c) => c.table))].map((t) => ({
          name: `${t}_pkey`, type: "p", table: t, columns: ["id"], ref_table: null, ref_columns: [],
        }));
      }
      if (sql.includes("from pg_proc")) {
        return schema.fns.map((name) => ({
          name, returns_set: false, stable: true, ret_type: "jsonb", ret_typtype: "b",
          arg_names: [], arg_modes: [], arg_types: [], nargs: 0, ndefaults: 0,
        }));
      }
      return [{ body: '[{"ok":true}]', n: 1 }];
    },
  }),
}));

import { handlePostgrest, type GatewayRequest } from "./handler";
import { getCatalog, resetCatalog, CATALOG_RELOAD_MIN_MS } from "./catalog";

const SERVICE = { mode: "service" } as const;
const get = (path: string, query = ""): GatewayRequest => ({
  method: "GET", path, search: new URLSearchParams(query), headers: new Headers(), body: null,
});
const T0 = new Date("2026-10-19T08:00:00Z").getTime();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  schema.columns = [
    { table: "payments", name: "id", type: "uuid" },
    { table: "payments", name: "amount", type: "numeric" },
  ];
  schema.fns = [];
  schema.catalogLoads = 0;
  schema.loadDelay = null;
  resetCatalog();
});
afterEach(() => vi.useRealTimers());

describe("R-1671: the gateway re-reads its catalog when a name is missing", () => {
  it("a column added by a DB step after the catalog was read works without a restart", async () => {
    await getCatalog(); // the app started before the migration
    expect(schema.catalogLoads).toBe(1);

    schema.columns.push({ table: "payments", name: "credit_applied", type: "numeric" }); // DB step
    vi.setSystemTime(T0 + 5 * 60_000);

    const res = await handlePostgrest(get("payments", "select=id,credit_applied"), SERVICE);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ ok: true }]);
    expect(schema.catalogLoads).toBe(2);

    // The fresh catalog is kept: the next request does not reload again.
    const again = await handlePostgrest(get("payments", "select=credit_applied"), SERVICE);
    expect(again.status).toBe(200);
    expect(schema.catalogLoads).toBe(2);
  });

  it("a new table and a new function are found the same way", async () => {
    await getCatalog();
    schema.columns.push({ table: "credit_notes", name: "id", type: "uuid" });
    vi.setSystemTime(T0 + 60_000);

    expect((await handlePostgrest(get("credit_notes"), SERVICE)).status).toBe(200);
    expect(schema.catalogLoads).toBe(2);

    schema.fns.push("customer_statement"); // a later DB step
    vi.setSystemTime(T0 + 2 * 60_000);
    expect((await handlePostgrest(get("rpc/customer_statement"), SERVICE)).status).toBe(200);
    expect(schema.catalogLoads).toBe(3);
  });

  it("a wrong name reloads at most once per window and still answers the same error as before", async () => {
    await getCatalog();
    vi.setSystemTime(T0 + 60_000);

    for (let i = 0; i < 20; i++) {
      const res = await handlePostgrest(get("payments", "select=no_such_column"), SERVICE);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.code).toBe("42703");
      expect(body.message).toBe("column payments.no_such_column does not exist");
    }
    expect(schema.catalogLoads).toBe(2); // one reload, not twenty

    const missingTable = await handlePostgrest(get("no_such_table"), SERVICE);
    expect(missingTable.status).toBe(404);
    expect((await missingTable.json()).code).toBe("42P01");
    expect(schema.catalogLoads).toBe(2); // still inside the window

    vi.setSystemTime(T0 + 60_000 + CATALOG_RELOAD_MIN_MS);
    await handlePostgrest(get("payments", "select=no_such_column"), SERVICE);
    expect(schema.catalogLoads).toBe(3); // next window → one more
  });

  it("a catalog read less than the window ago is not re-read at once", async () => {
    await getCatalog();
    vi.setSystemTime(T0 + 1000);
    const res = await handlePostgrest(get("payments", "select=nope"), SERVICE);
    expect(res.status).toBe(400);
    expect(schema.catalogLoads).toBe(1);
  });

  it("concurrent misses share one reload", async () => {
    await getCatalog();
    schema.columns.push({ table: "payments", name: "credit_applied", type: "numeric" });
    vi.setSystemTime(T0 + 60_000);

    let release!: () => void;
    schema.loadDelay = new Promise<void>((r) => { release = r; });
    const pending = Array.from({ length: 10 }, () =>
      handlePostgrest(get("payments", "select=credit_applied"), SERVICE));
    await new Promise((r) => setTimeout(r, 10));
    release();
    const results = await Promise.all(pending);
    expect(results.map((r) => r.status)).toEqual(Array(10).fill(200));
    expect(schema.catalogLoads).toBe(2);
  });

  it("a failed reload keeps the old catalog working", async () => {
    await getCatalog();
    vi.setSystemTime(T0 + 60_000);
    schema.loadDelay = Promise.reject(new Error("db down"));
    schema.loadDelay.catch(() => {});
    const miss = await handlePostgrest(get("payments", "select=nope"), SERVICE);
    expect(miss.status).toBe(400);
    expect((await miss.json()).code).toBe("42703");
    schema.loadDelay = null;
    const ok = await handlePostgrest(get("payments", "select=amount"), SERVICE);
    expect(ok.status).toBe(200);
  });
});
