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
export const HELP_READ_TABLES = ["subscriptions", "invoices", "quotes", "leads"] as const satisfies readonly TenantTable[];
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
  ilike(column: string, pattern: string): HelpQuery<Row>;
  not(column: string, operator: string, value: unknown): HelpQuery<Row>;
  order(column: string, options?: { ascending?: boolean; nullsFirst?: boolean }): HelpQuery<Row>;
  range(from: number, to: number): HelpQuery<Row>;
  limit(n: number): HelpQuery<Row>;
}

export interface HelpDb {
  read<Row = Record<string, unknown>>(table: HelpReadTable, columns: string, options?: { count?: "exact"; head?: boolean }): HelpQuery<Row>;
}

/** Filter methods passed through as (column, ...values) — the column is checked first. */
const FILTERS = ["eq", "neq", "in", "is", "lt", "lte", "gt", "gte", "ilike"] as const;

/** Most rows one limit() / range() may ask for (one fetchAllRows page). */
export const HELP_READ_PAGE_MAX = 1000;

/** One column, refused if it is not a plain, non-secret column of this table. */
export function assertReadableColumn(table: string, c: unknown): void {
  if (typeof c !== "string" || !COLUMN.test(c)) throw new HelpReadRefused(`${table}: '${String(c)}' is not a plain column (no *, joins, aliases or casts)`);
  if (SECRET_COLUMNS.includes(`${table}.${c}`) || SECRET_NAME.test(c)) throw new HelpReadRefused(`${table}.${c} is a secret column`);
}

/** Every column in a select list. */
export function assertReadableColumns(table: string, columns: string): void {
  const cols = columns.split(",").map((c) => c.trim());
  if (!cols.length || cols.some((c) => !c)) throw new HelpReadRefused(`${table}: empty column in '${columns}'`);
  for (const c of cols) assertReadableColumn(table, c);
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

/** The postgrest builder calls the closures make — never handed to a tool. */
type Builder = Record<string, (...a: unknown[]) => Builder> & PromiseLike<unknown>;

/**
 * Wrap the real builder in a plain, frozen, prototype-less object of arrow functions. The builder
 * lives only in this closure: no Proxy, so no descriptor / ownKeys / prototype trick can reach its
 * url, fetch, headers or method (review M1). Each call checks its arguments and wraps the next
 * builder the same way.
 */
function restrict<Row>(table: string, builder: Builder): HelpQuery<Row> {
  const next = (b: Builder) => restrict<Row>(table, b);
  const q: Record<string, unknown> = Object.create(null);
  for (const m of FILTERS) {
    q[m] = (column: unknown, value: unknown) => {
      assertReadableColumn(table, column);
      return next(builder[m](column, value));
    };
  }
  q.not = (column: unknown, operator: unknown, value: unknown) => {
    assertReadableColumn(table, column);
    if (typeof operator !== "string" || !NOT_OPERATORS.has(operator)) throw new HelpReadRefused(`${table}: not() operator '${String(operator)}'`);
    return next(builder.not(column, operator, value));
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
  q.then = (onOk?: (v: unknown) => unknown, onErr?: (e: unknown) => unknown) => builder.then(onOk, onErr);
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
      assertReadableColumns(table, columns);
      const selectOpts = options ? { ...(options.count ? { count: "exact" as const } : {}), ...(options.head ? { head: true } : {}) } : undefined;
      type Q = { eq: (c: string, v: string) => Q; abortSignal?: (s: AbortSignal) => Q };
      let q = (client.from(table) as unknown as { select: (c: string, o?: object) => Q })
        .select(columns, selectOpts).eq("tenant_id", tenantId);
      /* Aborted when the runner's timeout fires, so a slow read does not keep paging. */
      if (opts.signal && typeof q.abortSignal === "function") q = q.abortSignal(opts.signal);
      return restrict<Row>(table, q as unknown as Builder);
    },
  });
}
