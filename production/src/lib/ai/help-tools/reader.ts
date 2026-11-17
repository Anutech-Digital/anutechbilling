/**
 * The ONLY way a Help AI tool reads data (R-2774 / H-01).
 *
 * `scopedReader(client, tenantId)` wraps the signed-in person's own Supabase client (RLS) into
 * a reader that can do one thing: `read(table, columns)` — a SELECT with
 * `tenant_id = <this company>` already applied. It refuses (throws) when:
 *   - the table is not in HELP_READ_TABLES (fail-closed allowlist; compile-time: only tables
 *     with a tenant_id column can be listed), or is a credential table (HELP_NEVER_TABLES);
 *   - a column — in the select list OR in a filter / order — is `*`, an embedded resource, an
 *     alias or a cast, is in SECRET_COLUMNS, or its name looks like a credential (SECRET_NAME) —
 *     even when the owner's login could read it (no filter "oracle" on a secret either);
 *   - a not() operator is not a plain comparison operator;
 *   - the tenant id is empty.
 * The query it returns is a frozen, prototype-less object of closures exposing only filter /
 * order / range / limit and awaiting — no insert, update, delete, upsert, rpc, a second select,
 * and no way (descriptor, ownKeys, prototype) to reach the real builder's url / fetch / headers.
 * order() keeps only ascending / nullsFirst; limit() and range() ask for at most 1,000 rows.
 *
 * Tools never see the client itself. runner.ts builds the reader from a HelpSession (cookie
 * client only); the legacy R-421 path (help-data-tools.ts) builds it from the route's cookie
 * client. src/lib/security/help-tools-guard.test.ts keeps it that way.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { SECRET_COLUMNS, SECRET_NAME } from "@/lib/security/secret-columns";

type Tables = Database["public"]["Tables"];
/** Tables that carry a tenant_id column — the only ones a help tool may ever name. */
export type TenantTable = { [K in keyof Tables]: "tenant_id" extends keyof Tables[K]["Row"] ? K : never }[keyof Tables];

/** Tables help tools may read. Add a table here only with the tool that needs it. */
export const HELP_READ_TABLES = ["subscriptions", "invoices", "quotes", "leads", "customers"] as const satisfies readonly TenantTable[];
export type HelpReadTable = (typeof HELP_READ_TABLES)[number];

/** Credential tables: never readable by a help tool, even if someone adds them to the list above. */
export const HELP_NEVER_TABLES: readonly string[] = [...new Set([
  "tenant_secrets", "api_keys", "vault_passwords", "vault_access_log", "user_google_tokens",
  "personal_vault_pin", "phone_otps", "privacy_requests", "membership_invites", "team_invites",
  "email_verifications", "attendance_settings", "ad_accounts", "agent_tokens",
  // Whole tables that hold a SECRET_COLUMNS entry (e.g. employees.pin_hash): conservative on
  // purpose — a later card that needs one of them lifts it here with its own review.
  ...SECRET_COLUMNS.map((c) => c.split(".")[0]),
])];

const COLUMN = /^[a-z_][a-z0-9_]*$/;

export class HelpReadRefused extends Error {
  constructor(why: string) { super(`help reader refused: ${why}`); this.name = "HelpReadRefused"; }
}

/**
 * A like / ilike pattern made by containsPattern() / startsWithPattern() from ONE literal word
 * (R-2882, review of R-2879 note a). Opaque: the text lives in a private map, so a tool cannot
 * hand the reader its own "%…" — and a % _ * or  typed by the person matches only itself.
 */
export interface HelpLikePattern { readonly __helpLikePattern: unique symbol }

export interface HelpReadResult<Row> { data: Row[] | null; error: { message: string } | null; count: number | null }

/** A read-only query: filters, order, paging, then await. Nothing else exists on it. */
export interface HelpQuery<Row> extends PromiseLike<HelpReadResult<Row>> {
  eq(column: string, value: unknown): HelpQuery<Row>;
  neq(column: string, value: unknown): HelpQuery<Row>;
  in(column: string, values: readonly unknown[]): HelpQuery<Row>;
  is(column: string, value: null | boolean): HelpQuery<Row>;
  lt(column: string, value: unknown): HelpQuery<Row>;
  lte(column: string, value: unknown): HelpQuery<Row>;
  gt(column: string, value: unknown): HelpQuery<Row>;
  gte(column: string, value: unknown): HelpQuery<Row>;
  /** `pattern` comes from containsPattern() / startsWithPattern() — a raw string is refused (R-2882). */
  ilike(column: string, pattern: HelpLikePattern): HelpQuery<Row>;
  not(column: string, operator: string, value: unknown): HelpQuery<Row>;
  order(column: string, options?: { ascending?: boolean; nullsFirst?: boolean }): HelpQuery<Row>;
  range(from: number, to: number): HelpQuery<Row>;
  limit(n: number): HelpQuery<Row>;
}

export interface HelpDb {
  read<Row = Record<string, unknown>>(table: HelpReadTable, columns: string, options?: { count?: "exact"; head?: boolean }): HelpQuery<Row>;
}

/** Filter methods passed through as (column, value) — the column is checked first. */
type ScalarOp = "eq" | "neq" | "lt" | "lte" | "gt" | "gte";

/** Most rows one limit() / range() may ask for (one fetchAllRows page). */
export const HELP_READ_PAGE_MAX = 1000;

/**
 * R-2776 (checker finding 2): per-table COLUMN allowlist for tables that hold personal data. A table listed here
 * can be read only through these columns — in a select list, a filter or an order — so no later tool can select
 * customers.pan / gstin / tan / phone / e-mail / address by adding a column to its string. A table not listed
 * keeps the old rule (any plain, non-secret column). Add a column here only with the tool that needs it.
 * (payments: add its entry in the same change as its tool, R-2885.)
 */
const HELP_COLUMN_ALLOWLIST: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["customers", new Set(["id", "name", "customer_number", "customer_type", "state", "is_active", "since"])],
]);
/** The allowed columns of a table with a column allowlist, or null when it has none. */
export function helpAllowedColumns(table: string): readonly string[] | null {
  const set = HELP_COLUMN_ALLOWLIST.get(table);
  return set ? [...set] : null;
}

/** One column, refused if it is not a plain, non-secret column of this table. */
export function assertReadableColumn(table: string, c: unknown): void {
  if (typeof c !== "string" || !COLUMN.test(c)) throw new HelpReadRefused(`${table}: '${String(c)}' is not a plain column (no *, joins, aliases or casts)`);
  if (SECRET_COLUMNS.includes(`${table}.${c}`) || SECRET_NAME.test(c)) throw new HelpReadRefused(`${table}.${c} is a secret column`);
  const only = HELP_COLUMN_ALLOWLIST.get(table);
  if (only && !only.has(c)) throw new HelpReadRefused(`${table}.${c} is not on this table's column allowlist`);
}

/**
 * Every column in a select list; returns the checked list — the ONLY string sent to select().
 * `columns` must be a primitive string: an object with its own split() / toString() could pass
 * the check and then send something else (rev2 #1).
 */
export function assertReadableColumns(table: string, columns: unknown): string {
  if (typeof columns !== "string") throw new HelpReadRefused(`${table}: columns must be a string`);
  const cols = columns.split(",").map((c) => c.trim());
  if (!cols.length || cols.some((c) => !c)) throw new HelpReadRefused(`${table}: empty column in '${columns}'`);
  for (const c of cols) assertReadableColumn(table, c);
  return cols.join(",");
}

/** Longest literal search word for a pattern. */
export const HELP_LIKE_WORD_MAX = 100;

const PATTERN_TEXT = new WeakMap<object, string>();

/**
 * `word` as plain text inside a like / ilike pattern: \ % _ and * each get a backslash, so none is
 * a wildcard (PostgREST also reads * as %). The backslash is escaped in the same pass, so an
 * escape is never escaped again.
 */
export function likeLiteral(word: unknown): string {
  if (typeof word !== "string" || !word.length || word.length > HELP_LIKE_WORD_MAX || hasControlChar(word)) {
    throw new HelpReadRefused(`a search word must be 1-${HELP_LIKE_WORD_MAX} characters of plain text`);
  }
  return word.replace(/[\\%_*]/g, "\\$&");
}

function makePattern(text: string): HelpLikePattern {
  const p = Object.freeze(Object.create(null)) as HelpLikePattern;
  PATTERN_TEXT.set(p, text);
  return p;
}
/** Matches rows whose column CONTAINS the word (case-insensitive with ilike). */
export function containsPattern(word: unknown): HelpLikePattern { return makePattern(`%${likeLiteral(word)}%`); }
/** Matches rows whose column STARTS WITH the word. */
export function startsWithPattern(word: unknown): HelpLikePattern { return makePattern(`${likeLiteral(word)}%`); }

function patternText(table: string, p: unknown): string {
  const text = typeof p === "object" && p !== null ? PATTERN_TEXT.get(p) : undefined;
  if (text === undefined) throw new HelpReadRefused(`${table}: a like / ilike pattern must be made with containsPattern() or startsWithPattern()`);
  return text;
}

/** Operators not() may use — plain comparisons, no free-form filter text. */
const NOT_OPERATORS = new Set(["eq", "neq", "in", "is", "lt", "lte", "gt", "gte", "like", "ilike"]);

export function assertReadableTable(table: string): asserts table is HelpReadTable {
  if (HELP_NEVER_TABLES.includes(table)) throw new HelpReadRefused(`${table} is a credential table`);
  if (!(HELP_READ_TABLES as readonly string[]).includes(table)) throw new HelpReadRefused(`${table} is not a help-readable table`);
}

function rowIndex(table: string, what: string, n: unknown): number {
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) throw new HelpReadRefused(`${table}: ${what} '${String(n)}' is not a whole number ≥ 0`);
  return n;
}

/* ── R-2879 / H-01b finding 4: filter VALUES ────────────────────────────────────────────────
   postgrest-js does not escape a double quote inside an in() value (`in("stage", ['a",b'])` was
   sent as stage=in.("a",b") — one more list item), and not(col, "in", text) passed any text
   through. So: a value is a plain string / number / boolean; a LIST item may also not hold
   " ( ) , \ ; or a control character (refused, not escaped — ids and enum values never need
   them); lists are copied item by item, so what was checked is what is sent. */

/** Longest plain filter value / list item / ilike pattern, and most items in one list. */
export const HELP_VALUE_MAX = 500;
export const HELP_LIST_ITEM_MAX = 200;
export const HELP_LIST_MAX = 200;
export const HELP_PATTERN_MAX = 200;

type Scalar = string | number | boolean;

function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

/** A plain comparison value: string (bounded), finite number or boolean — never an object, array or null. */
function filterScalar(table: string, what: string, v: unknown): Scalar {
  if (typeof v === "boolean") return v;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.length <= HELP_VALUE_MAX && !hasControlChar(v)) return v;
  throw new HelpReadRefused(`${table}: ${what}() value must be a plain string (at most ${HELP_VALUE_MAX} characters), number or true / false`);
}

function filterIs(table: string, v: unknown): null | boolean {
  if (v === null || typeof v === "boolean") return v;
  throw new HelpReadRefused(`${table}: is() takes only null, true or false`);
}

const LIST_UNSAFE = /["(),\\;]/;

function listItem(table: string, v: unknown): Scalar {
  const s = filterScalar(table, "in", v);
  if (typeof s === "string" && (!s.length || s.length > HELP_LIST_ITEM_MAX || LIST_UNSAFE.test(s))) {
    throw new HelpReadRefused(`${table}: a list value may not be empty, longer than ${HELP_LIST_ITEM_MAX} characters, or hold " ( ) , \\ ;`);
  }
  return s;
}

/** in(): a real array of at most HELP_LIST_MAX checked items, copied (each item is read exactly once). May be empty. */
function filterList(table: string, values: unknown): Scalar[] {
  if (!Array.isArray(values)) throw new HelpReadRefused(`${table}: in() takes an array of values`);
  const out: Scalar[] = [];
  for (const v of values) {
    if (out.length >= HELP_LIST_MAX) throw new HelpReadRefused(`${table}: in() takes at most ${HELP_LIST_MAX} values`);
    out.push(listItem(table, v));
  }
  return out;
}

/** One item of a not-in list written as text: an id, a number or an enum word — nothing else. */
const LIST_TOKEN = /^[A-Za-z0-9_.:-]+$/;

/**
 * not(col, "in", …): an array (checked like in()) or the text "(a,b,c)" of plain tokens. Returns the
 * text sent, or null for an empty array ("not in nothing" filters nothing out).
 */
function notInList(table: string, value: unknown): string | null {
  if (Array.isArray(value)) {
    const items = filterList(table, value);
    return items.length ? `(${items.join(",")})` : null;
  }
  if (typeof value !== "string" || value.length > HELP_LIST_MAX * 40 || !value.startsWith("(") || !value.endsWith(")")) {
    throw new HelpReadRefused(`${table}: not(…, "in", …) takes an array or "(a,b,c)"`);
  }
  const items = value.slice(1, -1).split(",");
  if (items.length > HELP_LIST_MAX || items.some((t) => t.length > HELP_LIST_ITEM_MAX || !LIST_TOKEN.test(t))) {
    throw new HelpReadRefused(`${table}: not(…, "in", …) list items must be plain ids, numbers or words`);
  }
  return `(${items.join(",")})`;
}

/** The postgrest builder calls the closures make — never handed to a tool. */
type Builder = Record<string, (...a: unknown[]) => Builder> & PromiseLike<unknown>;

/** The builder call of one scalar filter — a switch, so the method name is never computed (R-2882 round 3). */
function scalarCall(op: ScalarOp, b: Builder, column: unknown, value: Scalar): Builder {
  switch (op) {
    case "eq": return b.eq(column, value);
    case "neq": return b.neq(column, value);
    case "lt": return b.lt(column, value);
    case "lte": return b.lte(column, value);
    case "gt": return b.gt(column, value);
    case "gte": return b.gte(column, value);
  }
}

/**
 * Wrap the real builder in a plain, frozen, prototype-less object of arrow functions. The builder
 * lives only in this closure: no Proxy, so no descriptor / ownKeys / prototype trick can reach its
 * url, fetch, headers or method (review M1). Each call checks its arguments and wraps the next
 * builder the same way.
 */
function restrict<Row>(table: string, builder: Builder, nothing = false): HelpQuery<Row> {
  /* `nothing`: an in() list was empty, so no row can match — the query still checks every later
     call, but answers with an empty result and sends no request. */
  const next = (b: Builder, none = nothing) => restrict<Row>(table, b, none);
  const q: Record<string, unknown> = Object.create(null);
  /* R-2879: values are checked as well as columns — only plain scalars reach the builder. R-2882 round 3: one
     named property per filter and a switch for the builder call — no computed method name anywhere. */
  const scalar = (op: ScalarOp) => (column: unknown, value: unknown) => {
    assertReadableColumn(table, column);
    return next(scalarCall(op, builder, column, filterScalar(table, op, value)));
  };
  q.eq = scalar("eq");
  q.neq = scalar("neq");
  q.lt = scalar("lt");
  q.lte = scalar("lte");
  q.gt = scalar("gt");
  q.gte = scalar("gte");
  q.in = (column: unknown, values: unknown) => {
    assertReadableColumn(table, column);
    const list = filterList(table, values);
    return list.length ? next(builder.in(column, list)) : next(builder, true);
  };
  q.is = (column: unknown, value: unknown) => {
    assertReadableColumn(table, column);
    return next(builder.is(column, filterIs(table, value)));
  };
  q.ilike = (column: unknown, pattern: unknown) => {
    assertReadableColumn(table, column);
    return next(builder.ilike(column, patternText(table, pattern)));
  };
  q.not = (column: unknown, operator: unknown, value: unknown) => {
    assertReadableColumn(table, column);
    if (typeof operator !== "string" || !NOT_OPERATORS.has(operator)) throw new HelpReadRefused(`${table}: not() operator '${String(operator)}'`);
    /* The reader writes the list itself — free text never becomes `not.in.(…)` (R-2879 finding 4). */
    const checked = operator === "in" ? notInList(table, value)
      : operator === "is" ? filterIs(table, value)
      : operator === "like" || operator === "ilike" ? patternText(table, value)
      : filterScalar(table, `not ${operator}`, value);
    if (operator === "in" && checked === null) return next(builder);
    return next(builder.not(column, operator, checked));
  };
  /* Only ascending / nullsFirst — no referencedTable / foreignTable (review L5). */
  q.order = (column: unknown, options?: unknown) => {
    assertReadableColumn(table, column);
    if (options !== undefined && (typeof options !== "object" || options === null)) throw new HelpReadRefused(`${table}: order() options`);
    const o = (options ?? {}) as { ascending?: unknown; nullsFirst?: unknown };
    const clean: { ascending?: boolean; nullsFirst?: boolean } = {};
    if (typeof o.ascending === "boolean") clean.ascending = o.ascending;
    if (typeof o.nullsFirst === "boolean") clean.nullsFirst = o.nullsFirst;
    return next(builder.order(column, clean));
  };
  /* At most HELP_READ_PAGE_MAX rows per request (review L5). */
  q.limit = (n: unknown) => next(builder.limit(Math.min(rowIndex(table, "limit", n), HELP_READ_PAGE_MAX)));
  q.range = (from: unknown, to: unknown) => {
    const f = rowIndex(table, "range from", from);
    const t = rowIndex(table, "range to", to);
    if (t < f) throw new HelpReadRefused(`${table}: range ${f}-${t}`);
    return next(builder.range(f, Math.min(t, f + HELP_READ_PAGE_MAX - 1)));
  };
  q.then = (onOk?: (v: unknown) => unknown, onErr?: (e: unknown) => unknown) => (nothing
    ? Promise.resolve({ success: true, error: null, data: [], count: 0, status: 200, statusText: "OK" }).then(onOk, onErr)
    : builder.then(onOk, onErr));
  return Object.freeze(q) as unknown as HelpQuery<Row>;
}

/**
 * The tenant-scoped reader. `client` must be the person's own cookie client — callers are
 * runner.ts (HelpSession) and the legacy help-data-tools.ts only (guard test).
 */
export function scopedReader(client: SupabaseClient<Database>, tenantId: string, opts: { signal?: AbortSignal } = {}): HelpDb {
  if (typeof tenantId !== "string" || !tenantId.trim()) throw new HelpReadRefused("no tenant");
  return Object.freeze({
    read<Row>(table: HelpReadTable, columns: string, options?: { count?: "exact"; head?: boolean }): HelpQuery<Row> {
      assertReadableTable(table);
      const checked = assertReadableColumns(table, columns);
      const selectOpts = options ? { ...(options.count ? { count: "exact" as const } : {}), ...(options.head ? { head: true } : {}) } : undefined;
      type Q = { eq: (c: string, v: string) => Q; limit: (n: number) => Q; abortSignal?: (s: AbortSignal) => Q };
      /* R-2879 (finding 7 of R-2774): every read asks for at most HELP_READ_PAGE_MAX rows even
         when the tool forgets limit() / range() — those only replace this with something smaller. */
      let q = (client.from(table) as unknown as { select: (c: string, o?: object) => Q })
        .select(checked, selectOpts).eq("tenant_id", tenantId).limit(HELP_READ_PAGE_MAX);
      /* Aborted when the runner's timeout fires, so a slow read does not keep paging. */
      if (opts.signal && typeof q.abortSignal === "function") q = q.abortSignal(opts.signal);
      return restrict<Row>(table, q as unknown as Builder);
    },
  });
}
