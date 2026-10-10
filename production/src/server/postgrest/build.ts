/**
 * Turns a parsed PostgREST request into ONE parameterised SQL statement that returns
 * `body` (the JSON text PostgREST would send) and `n` (rows in the result).
 *
 * Safety rules, enforced here and tested in postgrest.test.ts:
 *   • every table / column / function / relation name comes from the catalog and is quoted;
 *   • casts are limited to a strict pattern; types written into SQL come from the catalog;
 *   • every value is a bind parameter ($n), never concatenated;
 *   • the statement runs inside withIdentity(), so RLS still decides which rows exist.
 * The JSON is produced by Postgres itself (json_agg / row_to_json / to_json), the same way
 * PostgREST produces it, so numbers, dates and nulls come out identical.
 */
import type { Catalog, Column, Fn, ForeignKey, Table } from "./catalog";
import {
  PgrstError,
  type Condition, type Filter, type OrderTerm, type ParsedQuery, type Prefer, type Scope, type SelectItem,
} from "./parse";

export const MAX_ROWS = 1000; // PostgREST db-max-rows on production (PGRST_DB_MAX_ROWS)

const q = (ident: string) => '"' + ident.replace(/"/g, '""') + '"';

export class Params {
  readonly values: unknown[] = [];
  add(value: unknown, cast?: string): string {
    this.values.push(value);
    return `$${this.values.length}${cast ? `::${cast}` : ""}`;
  }
}

function table(cat: Catalog, name: string): Table {
  const t = cat.tables.get(name);
  if (!t) {
    throw new PgrstError(404, "42P01", `relation "public.${name}" does not exist`, null,
      `Perhaps you meant to reference the table "public.${name}"`);
  }
  return t;
}

function column(t: Table, name: string): Column {
  const c = t.columns.get(name);
  if (!c) throw new PgrstError(400, "42703", `column ${t.name}.${name} does not exist`);
  return c;
}

/** Postgres array literal for a list of text values — `in.(a,"b,c")` → {"a","b,c"}. */
function arrayLiteral(values: string[]): string {
  return "{" + values.map((v) => '"' + v.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"').join(",") + "}";
}

function elementType(type: string): string {
  return type.endsWith("[]") ? type.slice(0, -2) : type;
}

// ─── filters ─────────────────────────────────────────────────────────────────

function condSql(t: Table, alias: string, c: Condition, p: Params): string {
  const col = column(t, c.column);
  const ref = `${alias}.${q(col.name)}`;
  const v = c.value;
  let sql: string;
  switch (c.op) {
    case "eq": sql = `${ref} = ${p.add(v, col.type)}`; break;
    case "neq": sql = `${ref} <> ${p.add(v, col.type)}`; break;
    case "gt": sql = `${ref} > ${p.add(v, col.type)}`; break;
    case "gte": sql = `${ref} >= ${p.add(v, col.type)}`; break;
    case "lt": sql = `${ref} < ${p.add(v, col.type)}`; break;
    case "lte": sql = `${ref} <= ${p.add(v, col.type)}`; break;
    case "like": sql = `${ref}::text like ${p.add(String(v).replace(/\*/g, "%"), "text")}`; break;
    case "ilike": sql = `${ref}::text ilike ${p.add(String(v).replace(/\*/g, "%"), "text")}`; break;
    case "match": sql = `${ref}::text ~ ${p.add(v, "text")}`; break;
    case "imatch": sql = `${ref}::text ~* ${p.add(v, "text")}`; break;
    case "in": sql = `${ref} = any(${p.add(arrayLiteral(v as string[]), `${elementType(col.type)}[]`)})`; break;
    case "is": sql = `${ref} is ${v === "null" ? "null" : v === "true" ? "true" : v === "false" ? "false" : "unknown"}`; break;
    case "isdistinct": sql = `${ref} is distinct from ${p.add(v, col.type)}`; break;
    case "cs": sql = `${ref} @> ${p.add(v, col.type)}`; break;
    case "cd": sql = `${ref} <@ ${p.add(v, col.type)}`; break;
    case "ov": sql = `${ref} && ${p.add(v, col.type)}`; break;
  }
  return c.negate ? `not (${sql})` : sql;
}

function filterSql(t: Table, alias: string, f: Filter, p: Params): string {
  if (f.kind === "cond") return condSql(t, alias, f, p);
  if (f.items.length === 0) return f.negate ? "false" : "true";
  const inner = f.items.map((i) => `(${filterSql(t, alias, i, p)})`).join(f.op === "and" ? " and " : " or ");
  return f.negate ? `not (${inner})` : inner;
}

function whereSql(t: Table, alias: string, filters: Filter[], p: Params, extra: string[] = []): string {
  const parts = [...filters.map((f) => `(${filterSql(t, alias, f, p)})`), ...extra];
  return parts.length ? ` where ${parts.join(" and ")}` : "";
}

function orderSql(t: Table, alias: string, order: OrderTerm[]): string {
  if (!order.length) return "";
  return " order by " + order.map((o) => {
    const c = column(t, o.column);
    return `${alias}.${q(c.name)} ${o.dir}${o.nulls ? ` nulls ${o.nulls}` : ""}`;
  }).join(", ");
}

// ─── embedding ───────────────────────────────────────────────────────────────

interface Relationship {
  fk: ForeignKey;
  /** m2o: current table holds the FK. o2m: the embedded table holds it. */
  dir: "m2o" | "o2m";
  toOne: boolean;
}

function isUnique(t: Table, cols: string[]): boolean {
  return t.uniques.some((u) => u.length === cols.length && u.every((c) => cols.includes(c)));
}

function relationship(cat: Catalog, from: Table, to: Table, hint: string | undefined): Relationship {
  let cands: Relationship[] = [];
  for (const fk of cat.fks) {
    if (fk.table === from.name && fk.refTable === to.name) cands.push({ fk, dir: "m2o", toOne: true });
    if (fk.table === to.name && fk.refTable === from.name) cands.push({ fk, dir: "o2m", toOne: isUnique(to, fk.columns) });
  }
  if (hint) {
    cands = cands.filter((r) => r.fk.name === hint
      || (r.fk.columns.length === 1 && r.fk.columns[0] === hint)
      || (r.fk.refColumns.length === 1 && r.fk.refColumns[0] === hint && r.dir === "m2o"));
  }
  // A self-reference matches both directions for the same FK; without a hint PostgREST picks m2o.
  if (cands.length === 2 && cands[0].fk === cands[1].fk) cands = cands.filter((r) => r.dir === "m2o");
  if (cands.length === 0) {
    throw new PgrstError(400, "PGRST200", `Could not find a relationship between '${from.name}' and '${to.name}' in the schema cache`,
      `Searched for a foreign key relationship between '${from.name}' and '${to.name}'${hint ? ` using the hint '${hint}'` : ""} in the schema 'public', but no matches were found.`,
      null);
  }
  if (cands.length > 1) {
    const sorted = [...cands].sort((a, b) => a.fk.name.localeCompare(b.fk.name));
    const details = sorted.map((c) => ({
      cardinality: c.dir === "m2o" ? "many-to-one" : c.toOne ? "one-to-one" : "one-to-many",
      embedding: `${from.name} with ${to.name}`,
      relationship: `${c.fk.name} using ${c.fk.table}(${c.fk.columns.join(", ")}) and ${c.fk.refTable}(${c.fk.refColumns.join(", ")})`,
    }));
    throw new PgrstError(300, "PGRST201", `Could not embed because more than one relationship was found for '${from.name}' and '${to.name}'`,
      details,
      `Try changing '${to.name}' to one of the following: ${sorted.map((c) => `'${to.name}!${c.fk.name}'`).join(", ")}. Find the desired relationship in the 'details' key.`);
  }
  return cands[0];
}

function joinSql(rel: Relationship, parentAlias: string, childAlias: string): string {
  const { fk } = rel;
  // m2o: parent.fk_cols → child.ref_cols ; o2m: child.fk_cols → parent.ref_cols
  return fk.columns.map((c, i) => rel.dir === "m2o"
    ? `${childAlias}.${q(fk.refColumns[i])} = ${parentAlias}.${q(c)}`
    : `${childAlias}.${q(c)} = ${parentAlias}.${q(fk.refColumns[i])}`).join(" and ");
}

interface Ctx {
  cat: Catalog;
  p: Params;
  scopes: Map<string, Scope>;
  seq: { n: number };
}

const emptyScope: Scope = { filters: [], order: [] };

/** Select-list SQL for `items` read from `t` aliased `alias`, at embed path `path`. Also returns parent filters for !inner. */
function selectList(ctx: Ctx, t: Table, alias: string, items: SelectItem[], path: string): { cols: string[]; innerExists: string[] } {
  const cols: string[] = [];
  const innerExists: string[] = [];
  for (const it of items) {
    if (it.kind === "star") {
      for (const c of t.columns.values()) cols.push(`${alias}.${q(c.name)}`);
    } else if (it.kind === "column") {
      const c = column(t, it.name);
      cols.push(`${alias}.${q(c.name)}${it.cast ? `::${it.cast}` : ""} as ${q(it.alias ?? c.name)}`);
    } else {
      const child = ctx.cat.tables.get(it.relation);
      if (!child) {
        throw new PgrstError(400, "PGRST200", `Could not find a relationship between '${t.name}' and '${it.relation}' in the schema cache`,
          `Searched for a foreign key relationship between '${t.name}' and '${it.relation}' in the schema 'public', but no matches were found.`, null);
      }
      const rel = relationship(ctx.cat, t, child, it.hint);
      const name = it.alias ?? it.relation;
      const childPath = path ? `${path}.${name}` : name;
      const sc = ctx.scopes.get(childPath) ?? (it.alias ? ctx.scopes.get(path ? `${path}.${it.relation}` : it.relation) : undefined) ?? emptyScope;
      const ca = `e${++ctx.seq.n}`;
      const inner = selectList(ctx, child, ca, it.items, childPath);
      const where = whereSql(child, ca, sc.filters, ctx.p, [joinSql(rel, alias, ca), ...inner.innerExists]);
      if (rel.toOne) {
        cols.push(`(select row_to_json(_${ca}) from (select ${inner.cols.join(", ") || "null"} from public.${q(child.name)} ${ca}${where} limit 1) _${ca}) as ${q(name)}`);
      } else {
        const limit = sc.limit !== undefined ? ` limit ${sc.limit}` : "";
        const offset = sc.offset !== undefined ? ` offset ${sc.offset}` : "";
        cols.push(`coalesce((select json_agg(_${ca}) from (select ${inner.cols.join(", ") || "null"} from public.${q(child.name)} ${ca}${where}${orderSql(child, ca, sc.order)}${limit}${offset}) _${ca}), '[]'::json) as ${q(name)}`);
      }
      if (it.inner) {
        const ia = `i${++ctx.seq.n}`;
        const iw = whereSql(child, ia, sc.filters, ctx.p, [joinSql(rel, alias, ia)]);
        innerExists.push(`exists (select 1 from public.${q(child.name)} ${ia}${iw})`);
      }
    }
  }
  return { cols, innerExists };
}

function aggregate(inner: string, stripNulls: boolean): string {
  const agg = stripNulls ? "json_strip_nulls(coalesce(json_agg(_r), '[]'::json))" : "coalesce(json_agg(_r), '[]'::json)";
  return `select ${agg}::text as body, count(*)::int as n from (${inner}) _r`;
}

// ─── reads ───────────────────────────────────────────────────────────────────

export interface Built {
  sql: string;
  params: unknown[];
  /** What `body` holds: a JSON array of rows, one JSON object (composite function), or a plain value (scalar/void function). */
  shape: "array" | "object" | "value";
  countSql?: string;
  countParams?: unknown[];
  offset: number;
}

export function buildRead(cat: Catalog, tableName: string, pq: ParsedQuery, opts: { count: boolean; stripNulls: boolean }): Built {
  const t = table(cat, tableName);
  const base = pq.scopes.get("") ?? emptyScope;
  const p = new Params();
  const ctx: Ctx = { cat, p, scopes: pq.scopes, seq: { n: 0 } };
  const { cols, innerExists } = selectList(ctx, t, "a", pq.select, "");
  const where = whereSql(t, "a", base.filters, p, innerExists);
  const limit = Math.min(base.limit ?? MAX_ROWS, MAX_ROWS);
  const offset = base.offset ?? 0;
  const inner = `select ${cols.join(", ") || "null"} from public.${q(t.name)} a${where}${orderSql(t, "a", base.order)} limit ${limit}${offset ? ` offset ${offset}` : ""}`;
  const out: Built = { sql: aggregate(inner, opts.stripNulls), params: p.values, offset, shape: "array" };
  if (opts.count) {
    const cp = new Params();
    const cctx: Ctx = { cat, p: cp, scopes: pq.scopes, seq: { n: 0 } };
    const ce = selectList(cctx, t, "a", pq.select, "").innerExists;
    out.countSql = `select count(*)::int as total from public.${q(t.name)} a${whereSql(t, "a", base.filters, cp, ce)}`;
    out.countParams = cp.values;
  }
  return out;
}

// ─── writes ──────────────────────────────────────────────────────────────────

function payloadColumns(t: Table, rows: Record<string, unknown>[], explicit?: string[]): string[] {
  const names = explicit ?? [...new Set(rows.flatMap((r) => Object.keys(r)))];
  if (names.length === 0) throw new PgrstError(400, "PGRST102", "Empty or invalid json");
  for (const n of names) {
    const c = column(t, n);
    if (c.generated) throw new PgrstError(400, "428C9", `cannot insert a non-DEFAULT value into column "${n}"`, `Column "${n}" is a generated column.`);
  }
  return names;
}

function representation(ctx: Ctx, t: Table, pq: ParsedQuery, prefer: Prefer, stripNulls: boolean): string {
  if (prefer.return !== "representation") return `select null::text as body, (select count(*)::int from _m) as n`;
  const { cols } = selectList(ctx, t, "a", pq.select, "");
  const base = pq.scopes.get("") ?? emptyScope;
  return aggregate(`select ${cols.join(", ") || "null"} from _m a${orderSql(t, "a", base.order)}`, stripNulls);
}

export function buildInsert(cat: Catalog, tableName: string, pq: ParsedQuery, prefer: Prefer, body: unknown, stripNulls: boolean): Built {
  const t = table(cat, tableName);
  if (prefer.missingDefault) throw new PgrstError(400, "PGRST100", "Prefer: missing=default is not supported by this gateway");
  const rows = (Array.isArray(body) ? body : [body]) as Record<string, unknown>[];
  if (!rows.every((r) => r && typeof r === "object" && !Array.isArray(r))) throw new PgrstError(400, "PGRST102", "Empty or invalid json");
  const p = new Params();
  const ctx: Ctx = { cat, p, scopes: pq.scopes, seq: { n: 0 } };
  if (rows.length === 0) {
    return { sql: `select '[]'::text as body, 0 as n`, params: [], offset: 0, shape: "array" };
  }
  const names = payloadColumns(t, rows, pq.columns);
  const list = names.map(q).join(", ");
  let conflict = "";
  if (prefer.resolution) {
    const target = pq.onConflict ?? t.pk;
    if (!target.length) throw new PgrstError(400, "PGRST100", "on_conflict needs columns (the table has no primary key)");
    target.forEach((c) => column(t, c));
    const updates = names.filter((n) => !target.includes(n)).map((n) => `${q(n)} = excluded.${q(n)}`);
    conflict = prefer.resolution === "ignore-duplicates" || updates.length === 0
      ? ` on conflict (${target.map(q).join(", ")}) do nothing`
      : ` on conflict (${target.map(q).join(", ")}) do update set ${updates.join(", ")}`;
  }
  const src = p.add(JSON.stringify(rows), "json");
  const write = `insert into public.${q(t.name)} as a (${list}) select ${list} from json_populate_recordset(null::public.${q(t.name)}, ${src}) _src${conflict} returning a.*`;
  return { sql: `with _m as (${write}) ${representation(ctx, t, pq, prefer, stripNulls)}`, params: p.values, offset: 0, shape: "array" };
}

export function buildUpdate(cat: Catalog, tableName: string, pq: ParsedQuery, prefer: Prefer, body: unknown, stripNulls: boolean): Built {
  const t = table(cat, tableName);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new PgrstError(400, "PGRST102", "Empty or invalid json");
  const p = new Params();
  const ctx: Ctx = { cat, p, scopes: pq.scopes, seq: { n: 0 } };
  const names = payloadColumns(t, [body as Record<string, unknown>]);
  const src = p.add(JSON.stringify(body), "json");
  const base = pq.scopes.get("") ?? emptyScope;
  const where = whereSql(t, "a", base.filters, p);
  const set = names.map((n) => `${q(n)} = _src.${q(n)}`).join(", ");
  const write = `update public.${q(t.name)} as a set ${set} from json_populate_record(null::public.${q(t.name)}, ${src}) _src${where} returning a.*`;
  return { sql: `with _m as (${write}) ${representation(ctx, t, pq, prefer, stripNulls)}`, params: p.values, offset: 0, shape: "array" };
}

export function buildDelete(cat: Catalog, tableName: string, pq: ParsedQuery, prefer: Prefer, stripNulls: boolean): Built {
  const t = table(cat, tableName);
  const p = new Params();
  const ctx: Ctx = { cat, p, scopes: pq.scopes, seq: { n: 0 } };
  const base = pq.scopes.get("") ?? emptyScope;
  const write = `delete from public.${q(t.name)} as a${whereSql(t, "a", base.filters, p)} returning a.*`;
  return { sql: `with _m as (${write}) ${representation(ctx, t, pq, prefer, stripNulls)}`, params: p.values, offset: 0, shape: "array" };
}

// ─── rpc ─────────────────────────────────────────────────────────────────────

function pickFunction(cat: Catalog, name: string, given: string[]): Fn {
  const list = cat.functions.get(name) ?? [];
  const fits = list.filter((f) => {
    const names = f.args.map((a) => a.name);
    return given.every((g) => names.includes(g)) && f.args.every((a) => a.hasDefault || given.includes(a.name));
  });
  if (fits.length === 1) return fits[0];
  if (fits.length > 1) {
    // Prefer the overload with the fewest extra (defaulted) arguments, as Postgres would.
    const best = [...fits].sort((a, b) => a.args.length - b.args.length);
    if (best[0].args.length !== best[1].args.length) return best[0];
    throw new PgrstError(300, "PGRST203", `Could not choose the best candidate function between: ${fits.map((f) => `public.${name}(${f.args.map((a) => `${a.name} => ${a.type}`).join(", ")})`).join(", ")}`);
  }
  throw new PgrstError(404, "PGRST202", `Could not find the function public.${name}${given.length ? `(${given.join(", ")})` : " without parameters"} in the schema cache`,
    `Searched for the function public.${name} with parameter${given.length === 1 ? "" : "s"} ${given.join(", ") || "none"} or with a single unnamed json/jsonb parameter, but no matches were found in the schema cache.`);
}

/** The rows a set/composite function returns, as a table the select/filter code understands. */
function resultTable(cat: Catalog, fn: Fn): Table | null {
  if (fn.resultColumns.length) {
    return { name: fn.name, kind: "view", columns: new Map(fn.resultColumns.map((c) => [c.name, c])), pk: [], uniques: [] };
  }
  return cat.tables.get(fn.retType) ?? null;
}

export function buildRpc(cat: Catalog, name: string, args: Record<string, unknown>, pq: ParsedQuery, opts: { stripNulls: boolean; count: boolean }): Built & { fn: Fn } {
  const given = Object.keys(args).filter((k) => args[k] !== undefined);
  const fn = pickFunction(cat, name, given);
  const p = new Params();
  const used = fn.args.filter((a) => given.includes(a.name));
  const call = `public.${q(fn.name)}(${used.map((a) => `${a.variadic ? "variadic " : ""}${q(a.name)} => _a.${q(a.name)}`).join(", ")})`;
  // Arguments arrive as one JSON object and are typed by json_to_record — the way PostgREST
  // does it — so arrays, json and enums convert with Postgres' own input functions.
  const argsFrom = used.length
    ? `json_to_record(${p.add(JSON.stringify(Object.fromEntries(used.map((a) => [a.name, args[a.name]]))), "json")}) as _a(${used.map((a) => `${q(a.name)} ${a.type}`).join(", ")})`
    : "";

  if (fn.returns === "void") {
    return { fn, sql: `select 'null'::text as body, 1 as n from (select ${call}${argsFrom ? ` from ${argsFrom}` : ""}) _v`, params: p.values, offset: 0, shape: "value" };
  }
  if (fn.returns === "scalar" && !fn.returnsSet) {
    return { fn, sql: `select to_json(${call})::text as body, 1 as n${argsFrom ? ` from ${argsFrom}` : ""}`, params: p.values, offset: 0, shape: "value" };
  }

  const base = pq.scopes.get("") ?? emptyScope;
  if (fn.returns === "scalar" && fn.returnsSet) {
    const sfrom = argsFrom ? `${argsFrom}, lateral ${call} as r(v)` : `${call} as r(v)`;
    const lim = ` limit ${Math.min(base.limit ?? MAX_ROWS, MAX_ROWS)}${base.offset ? ` offset ${base.offset}` : ""}`;
    return { fn, sql: `select coalesce(json_agg(_r.v), '[]'::json)::text as body, count(*)::int as n from (select r.v from ${sfrom}${lim}) _r`, params: p.values, offset: base.offset ?? 0, shape: "array" };
  }
  const from = argsFrom ? `${argsFrom}, lateral ${call} r` : `${call} r`;
  const rt = resultTable(cat, fn);
  const isStar = pq.select.length === 1 && pq.select[0].kind === "star";
  let cols: string;
  let where = "";
  let order = "";
  if (rt) {
    const ctx: Ctx = { cat, p, scopes: pq.scopes, seq: { n: 0 } };
    const sl = selectList(ctx, rt, "r", pq.select, "");
    cols = sl.cols.join(", ") || "null";
    where = whereSql(rt, "r", base.filters, p, sl.innerExists);
    order = orderSql(rt, "r", base.order);
  } else {
    if (!isStar || base.filters.length || base.order.length) {
      throw new PgrstError(400, "PGRST100", `public.${fn.name} returns an untyped record: only select=* without filters is supported`);
    }
    cols = "r.*";
  }
  const limit = fn.returnsSet ? ` limit ${Math.min(base.limit ?? MAX_ROWS, MAX_ROWS)}` : "";
  const offset = fn.returnsSet && base.offset ? ` offset ${base.offset}` : "";
  const query = `select ${cols} from ${from}${where}${order}${limit}${offset}`;
  if (!fn.returnsSet) {
    return { fn, sql: `select (select to_json(_r) from (${query}) _r limit 1)::text as body, 1 as n`, params: p.values, offset: 0, shape: "object" };
  }
  const out: Built & { fn: Fn } = { fn, sql: aggregate(query, opts.stripNulls), params: p.values, offset: base.offset ?? 0, shape: "array" };
  if (opts.count) {
    out.countSql = `select count(*)::int as total from (select ${cols} from ${from}${where}) _c`;
    out.countParams = p.values;
  }
  return out;
}
