/**
 * In-memory McpDb for MCP tests. It behaves like the real one where it matters: every read and
 * update is limited to `tenantId` (the real one adds tenant_id = … to every query, and RLS does
 * the same in Postgres), column names are checked against the same allowlist, and an insert
 * gets the caller's tenant_id.
 */
import { randomUUID } from "node:crypto";
import { assertColumn, MCP_READ_COLUMNS, type McpDb, type McpJson, type McpQuery, type McpReadTable, type McpResult, type McpRow } from "@/lib/mcp/db";

export type Tables = Record<string, McpRow[]>;

export interface FakeDbOptions {
  rpc?: Record<string, (args: Record<string, McpJson>, tenantId: string, tables: Tables) => unknown>;
  failTables?: string[];
}

function cmp(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  return String(a) < String(b) ? -1 : 1;
}

export function fakeDb(tables: Tables, tenantId: string, opts: FakeDbOptions = {}): McpDb & { tables: Tables; calls: string[] } {
  const calls: string[] = [];
  const rowsOf = (t: string) => (tables[t] ??= []);

  function query<Row>(table: McpReadTable, columns: readonly string[], count: boolean): McpQuery<Row> {
    const filters: ((r: McpRow) => boolean)[] = [(r) => r.tenant_id === tenantId];
    let orderBy: { c: string; asc: boolean } | null = null;
    let from = 0; let limit = 1000;
    const col = (c: string) => { assertColumn(table, c); return c; };
    const self: McpQuery<Row> = {
      eq(c, v) { col(c); filters.push((r) => r[c] === v); return self; },
      neq(c, v) { col(c); filters.push((r) => r[c] !== v); return self; },
      in(c, v) { col(c); filters.push((r) => (v as readonly unknown[]).includes(r[c])); return self; },
      is(c, v) { col(c); filters.push((r) => (r[c] ?? null) === v); return self; },
      not_null(c) { col(c); filters.push((r) => r[c] !== null && r[c] !== undefined); return self; },
      gte(c, v) { col(c); filters.push((r) => r[c] != null && cmp(r[c], v) >= 0); return self; },
      lte(c, v) { col(c); filters.push((r) => r[c] != null && cmp(r[c], v) <= 0); return self; },
      lt(c, v) { col(c); filters.push((r) => r[c] != null && cmp(r[c], v) < 0); return self; },
      gt(c, v) { col(c); filters.push((r) => r[c] != null && Number(r[c]) > Number(v)); return self; },
      search(cs, text) {
        cs.forEach(col);
        const t = text.toLowerCase();
        filters.push((r) => cs.some((c) => typeof r[c] === "string" && (r[c] as string).toLowerCase().includes(t)));
        return self;
      },
      order(c, o) { col(c); orderBy = { c, asc: o?.ascending ?? true }; return self; },
      page(o, n) { from = o; limit = n; return self; },
      then(onOk, onErr) {
        calls.push(`select:${table}`);
        let res: McpResult<Row[]>;
        if (opts.failTables?.includes(table)) res = { data: null, error: { message: "boom" }, count: null };
        else {
          let rows = rowsOf(table).filter((r) => filters.every((f) => f(r)));
          const total = rows.length;
          if (orderBy) { const o = orderBy; rows = [...rows].sort((a, b) => (o.asc ? 1 : -1) * cmp(a[o.c], b[o.c])); }
          rows = rows.slice(from, from + limit).map((r) => Object.fromEntries(columns.map((c) => [c, r[c] ?? null])));
          res = { data: rows as Row[], error: null, count: count ? total : null };
        }
        return Promise.resolve(res).then(onOk, onErr);
      },
    };
    return self;
  }

  const db: McpDb & { tables: Tables; calls: string[] } = {
    tenantId, tables, calls,
    select(table, columns, o) {
      if (!(table in MCP_READ_COLUMNS)) throw new Error(`not readable ${table}`);
      columns.forEach((c) => assertColumn(table, c));
      return query(table, columns, !!o?.count);
    },
    async insert(table, row, returning) {
      calls.push(`insert:${table}`);
      const full: McpRow = { id: randomUUID(), created_at: new Date().toISOString(), ...row, tenant_id: tenantId };
      if (table === "mcp_write_previews" && rowsOf(table).some((r) => r.tenant_id === tenantId && r.user_id === full.user_id && r.idempotency_key === full.idempotency_key)) {
        return { data: null, error: { message: "duplicate key", code: "23505" } };
      }
      rowsOf(table).push(full);
      return { data: Object.fromEntries(returning.map((c) => [c, full[c] ?? null])) as never, error: null };
    },
    async updateById(table, id, patch, returning) {
      calls.push(`update:${table}`);
      const r = rowsOf(table).find((x) => x.id === id && x.tenant_id === tenantId);
      if (!r) return { data: null, error: null };
      Object.assign(r, patch);
      return { data: Object.fromEntries(returning.map((c) => [c, r[c] ?? null])) as never, error: null };
    },
    async updateWhere(table, match, patch, returning) {
      calls.push(`update:${table}`);
      const hits = rowsOf(table).filter((x) => x.tenant_id === tenantId && Object.entries(match).every(([k, v]) => x[k] === v));
      hits.forEach((r) => Object.assign(r, patch));
      return { data: hits.map((r) => Object.fromEntries(returning.map((c) => [c, r[c] ?? null]))) as never, error: null };
    },
    async rpc(fn, args) {
      calls.push(`rpc:${fn}`);
      const h = opts.rpc?.[fn];
      return { data: (h ? h(args ?? {}, tenantId, tables) : null) as never, error: null };
    },
  };
  return db;
}
