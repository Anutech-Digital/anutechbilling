/**
 * Parses the PostgREST request grammar that @supabase/postgrest-js produces into a plain
 * tree. No SQL here and no catalog lookups — build.ts validates every name against the
 * catalog and turns the tree into parameterised SQL.
 *
 * Grammar covered (what this codebase's 2,000 call sites use, measured 5 Oct 2026):
 *   select   a, alias:b, c::text, *, rel(...), alias:rel!fk_or_col(...), rel!inner(...)
 *   filters  col=[not.]op.value  for eq neq gt gte lt lte like ilike match imatch in is
 *            isdistinct cs cd ov — on the base table or `rel.col` for an embedded one
 *   logic    or=(a.eq.1,and(b.gt.2,c.is.null))   not.or=(...)   rel.or=(...)
 *   order    order=a.desc.nullslast,b    rel.order=...
 *   paging   limit, offset, rel.limit, rel.offset
 *   writes   columns, on_conflict
 * Anything else is rejected with a PostgREST-shaped error rather than guessed at.
 */

export class PgrstError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: unknown = null,
    readonly hint: string | null = null,
  ) {
    super(message);
    this.name = "PgrstError";
  }
}

const bad = (message: string, details: string | null = null) => new PgrstError(400, "PGRST100", message, details);

// ─── select ──────────────────────────────────────────────────────────────────

export type SelectItem =
  | { kind: "star" }
  | { kind: "column"; name: string; alias?: string; cast?: string }
  | { kind: "embed"; relation: string; alias?: string; hint?: string; inner: boolean; items: SelectItem[] };

/** Split on `sep` at nesting depth 0, ignoring separators inside "quotes". */
export function splitTop(s: string, sep = ","): string[] {
  const out: string[] = [];
  let depth = 0, quoted = false, cur = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\" && quoted && i + 1 < s.length) { cur += ch + s[++i]; continue; }
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === "(") depth++;
    else if (!quoted && ch === ")") depth--;
    if (!quoted && depth === 0 && ch === sep) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (depth !== 0 || quoted) throw bad("unbalanced parentheses or quotes", s);
  out.push(cur);
  return out;
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CAST = /^[a-z_][a-z0-9_ ]*(\[\])?$/;

export function parseSelect(raw: string | null): SelectItem[] {
  if (raw === null || raw.trim() === "") return [{ kind: "star" }];
  return splitTop(raw.replace(/\s+(?=([^"]*"[^"]*")*[^"]*$)/g, "")).filter(Boolean).map(parseItem);
}

function parseItem(item: string): SelectItem {
  if (item === "*") return { kind: "star" };
  const paren = item.indexOf("(");
  if (paren >= 0) {
    if (!item.endsWith(")")) throw bad("bad embedded resource", item);
    let head = item.slice(0, paren);
    const inner = item.slice(paren + 1, -1);
    let alias: string | undefined;
    const colon = head.indexOf(":");
    if (colon >= 0) { alias = head.slice(0, colon); head = head.slice(colon + 1); }
    const [relation, ...mods] = head.split("!");
    let hint: string | undefined;
    let isInner = false;
    for (const m of mods) {
      if (m === "inner") isInner = true;
      else if (m === "left") isInner = false;
      else hint = m;
    }
    for (const n of [relation, alias, hint]) if (n !== undefined && !IDENT.test(n)) throw bad("bad name in embedded resource", item);
    return { kind: "embed", relation, alias, hint, inner: isInner, items: parseSelect(inner) };
  }
  let rest = item;
  let alias: string | undefined;
  const aliasMatch = rest.match(/^([A-Za-z_][A-Za-z0-9_]*):(?!:)(.*)$/);
  if (aliasMatch) { alias = aliasMatch[1]; rest = aliasMatch[2]; }
  let cast: string | undefined;
  const castAt = rest.indexOf("::");
  if (castAt >= 0) { cast = rest.slice(castAt + 2); rest = rest.slice(0, castAt); }
  if (rest.includes("->")) throw bad("JSON paths in select are not supported by this gateway", item);
  if (!IDENT.test(rest) || (cast !== undefined && !CAST.test(cast))) throw bad("bad column in select", item);
  return { kind: "column", name: rest, alias, cast };
}

// ─── filters ─────────────────────────────────────────────────────────────────

export const OPERATORS = ["eq", "neq", "gt", "gte", "lt", "lte", "like", "ilike", "match", "imatch", "in", "is", "isdistinct", "cs", "cd", "ov"] as const;
export type Operator = (typeof OPERATORS)[number];

export interface Condition {
  kind: "cond";
  column: string;
  negate: boolean;
  op: Operator;
  /** Raw text after the operator. For `in` the parsed list; for `is` one of null/true/false/unknown. */
  value: string | string[];
}
export interface Logic {
  kind: "logic";
  op: "and" | "or";
  negate: boolean;
  items: Filter[];
}
export type Filter = Condition | Logic;

/** "not.eq.5" → { negate, op, value }. `inLogic`: the condition sits inside or()/and(). */
export function parseOpValue(column: string, raw: string, inLogic = false): Condition {
  let s = raw;
  let negate = false;
  if (s.startsWith("not.")) { negate = true; s = s.slice(4); }
  const dot = s.indexOf(".");
  if (dot < 0) throw bad(`"failed to parse filter (${raw})"`, `filter for ${column}`);
  const op = s.slice(0, dot) as Operator;
  const raw2 = s.slice(dot + 1);
  if (!(OPERATORS as readonly string[]).includes(op)) throw bad(`unsupported operator "${op}"`, `filter for ${column}`);
  // Inside or()/and() a whole value may be "double-quoted" (so it can hold , . ( ) ); like
  // PostgREST, the quotes are syntax and \" \\ inside are unescaped. R-467: without this,
  // or=(name.ilike."%sharma%") searched for the text WITH the quotes and found nothing.
  const rest = inLogic && op !== "in" ? unquote(raw2) : raw2;
  if (op === "in") {
    if (!rest.startsWith("(") || !rest.endsWith(")")) throw bad("in() needs a parenthesised list", raw);
    const body = rest.slice(1, -1);
    const list = body === "" ? [] : parseInList(body);
    return { kind: "cond", column, negate, op, value: list };
  }
  if (op === "is" && !["null", "true", "false", "unknown"].includes(rest.toLowerCase())) {
    throw bad(`is.${rest} — only null, true, false, unknown`, raw);
  }
  return { kind: "cond", column, negate, op, value: op === "is" ? rest.toLowerCase() : rest };
}

/**
 * in.(a,"b,c",d"e) — like PostgREST, a quote only opens a quoted element at the START of the
 * element (backslash escapes inside it); anywhere else it is an ordinary character.
 */
function parseInList(body: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i <= body.length) {
    if (body[i] === '"') {
      let v = "";
      i++;
      while (i < body.length && body[i] !== '"') {
        if (body[i] === "\\" && i + 1 < body.length) i++;
        v += body[i++];
      }
      if (body[i] !== '"') throw bad("unterminated quoted value in in()", body);
      i++;
      out.push(v);
      if (i < body.length && body[i] !== ",") throw bad("expected , after quoted value in in()", body);
      i++;
    } else {
      const next = body.indexOf(",", i);
      const end = next < 0 ? body.length : next;
      out.push(body.slice(i, end));
      i = end + 1;
    }
  }
  return out;
}

function unquote(v: string): string {
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1).replace(/\\(.)/g, "$1");
  return v;
}

/** "(a.eq.1,and(b.gt.2,c.is.null))" → Logic tree. */
export function parseLogic(op: "and" | "or", negate: boolean, raw: string): Logic {
  if (!raw.startsWith("(") || !raw.endsWith(")")) throw bad(`${op} needs a parenthesised list`, raw);
  const items = splitTop(raw.slice(1, -1)).map((part): Filter => {
    const m = part.match(/^(not\.)?(and|or)(\(.*\))$/s);
    if (m) return parseLogic(m[2] as "and" | "or", Boolean(m[1]), m[3]);
    const dot = part.indexOf(".");
    if (dot < 0) throw bad("bad condition in logic tree", part);
    const column = part.slice(0, dot);
    if (!IDENT.test(column)) throw bad("bad column in logic tree", part);
    return parseOpValue(column, part.slice(dot + 1), true);
  });
  return { kind: "logic", op, negate, items };
}

// ─── order ───────────────────────────────────────────────────────────────────

export interface OrderTerm {
  column: string;
  dir: "asc" | "desc";
  nulls?: "first" | "last";
}

export function parseOrder(raw: string): OrderTerm[] {
  return splitTop(raw).filter(Boolean).map((t) => {
    const [column, ...mods] = t.split(".");
    if (!IDENT.test(column)) throw bad("bad column in order", t);
    const term: OrderTerm = { column, dir: "asc" };
    for (const m of mods) {
      if (m === "asc" || m === "desc") term.dir = m;
      else if (m === "nullsfirst") term.nulls = "first";
      else if (m === "nullslast") term.nulls = "last";
      else throw bad(`bad order modifier "${m}"`, t);
    }
    return term;
  });
}

// ─── the whole query string ──────────────────────────────────────────────────

/** Filters / order / paging that apply at one level: the base table ("") or an embed path ("rel", "rel.child"). */
export interface Scope {
  filters: Filter[];
  order: OrderTerm[];
  limit?: number;
  offset?: number;
}

export interface ParsedQuery {
  select: SelectItem[];
  scopes: Map<string, Scope>;
  columns?: string[];
  onConflict?: string[];
}

function scope(map: Map<string, Scope>, path: string): Scope {
  let s = map.get(path);
  if (!s) { s = { filters: [], order: [] }; map.set(path, s); }
  return s;
}

function int(name: string, v: string): number {
  if (!/^\d+$/.test(v)) throw bad(`${name} must be a non-negative integer`, v);
  return Number(v);
}

/** `keys` are PostgREST's own; everything else is a filter. `skip` = rpc argument names (GET rpc). */
export function parseQuery(params: URLSearchParams, skip: ReadonlySet<string> = new Set()): ParsedQuery {
  const scopes = new Map<string, Scope>();
  const out: ParsedQuery = { select: parseSelect(params.get("select")), scopes };
  scope(scopes, "");
  for (const [key, value] of params) {
    if (key === "select" || skip.has(key)) continue;
    if (key === "columns") { out.columns = splitTop(value).map((c) => unquote(c.trim())); continue; }
    if (key === "on_conflict") { out.onConflict = splitTop(value).map((c) => c.trim()); continue; }
    const parts = key.split(".");
    const last = parts[parts.length - 1];
    // logic: or / and / not.or / not.and — possibly prefixed by an embed path
    const negLogic = parts.length >= 2 && parts[parts.length - 2] === "not" && (last === "or" || last === "and");
    if (last === "or" || last === "and") {
      const path = parts.slice(0, negLogic ? -2 : -1).join(".");
      scope(scopes, path).filters.push(parseLogic(last, negLogic, value));
      continue;
    }
    if (last === "order" || last === "limit" || last === "offset") {
      const s = scope(scopes, parts.slice(0, -1).join("."));
      if (last === "order") s.order.push(...parseOrder(value));
      else if (last === "limit") s.limit = int("limit", value);
      else s.offset = int("offset", value);
      continue;
    }
    const column = last;
    if (!IDENT.test(column)) throw bad(`bad filter key "${key}"`);
    scope(scopes, parts.slice(0, -1).join(".")).filters.push(parseOpValue(column, value));
  }
  return out;
}

// ─── Prefer / Accept ─────────────────────────────────────────────────────────

export interface Prefer {
  return: "representation" | "minimal" | "headers-only";
  count?: "exact" | "planned" | "estimated";
  resolution?: "merge-duplicates" | "ignore-duplicates";
  missingDefault: boolean;
}

export function parsePrefer(header: string | null): Prefer {
  const p: Prefer = { return: "minimal", missingDefault: false };
  for (const part of (header ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const [k, v] = part.split("=").map((s) => s.trim());
    if (k === "return" && (v === "representation" || v === "minimal" || v === "headers-only")) p.return = v;
    else if (k === "count" && (v === "exact" || v === "planned" || v === "estimated")) p.count = v;
    else if (k === "resolution" && (v === "merge-duplicates" || v === "ignore-duplicates")) p.resolution = v;
    else if (k === "missing" && v === "default") p.missingDefault = true;
  }
  return p;
}

/** application/vnd.pgrst.object+json → exactly one row as an object. `nulls=stripped` drops null keys. */
export function parseAccept(header: string | null): { single: boolean; stripNulls: boolean } {
  const h = (header ?? "").toLowerCase();
  return { single: h.includes("vnd.pgrst.object"), stripNulls: h.includes("nulls=stripped") };
}
