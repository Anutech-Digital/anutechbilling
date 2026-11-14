/**
 * The ONLY way a Help AI tool reads data (R-2774 / H-01).
 *
 * `scopedReader(client, tenantId)` wraps the signed-in person's own Supabase client (RLS) into
 * a reader that can do one thing: `read(table, columns)` — a SELECT with
 * `tenant_id = <this company>` already applied. It refuses (throws) when:
 *   - the table is not in HELP_READ_TABLES (fail-closed allowlist; compile-time: only tables
 *     with a tenant_id column can be listed), or is a credential table (HELP_NEVER_TABLES);
 *   - a column is `*`, an embedded resource, an alias or a cast, is in SECRET_COLUMNS, or its
 *     name looks like a credential (SECRET_NAME) — even when the owner's login could read it;
 *   - the tenant id is empty.
 * The query it returns is a proxy exposing only filter / order / range / limit and awaiting —
 * no insert, update, delete, upsert, rpc, a second select or anything else, at runtime too.
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
export const HELP_NEVER_TABLES: readonly string[] = [
  "tenant_secrets", "api_keys", "vault_passwords", "vault_access_log", "user_google_tokens",
  "personal_vault_pin", "phone_otps", "privacy_requests", "membership_invites", "team_invites",
  "email_verifications", "attendance_settings", "ad_accounts", "agent_tokens",
  ...SECRET_COLUMNS.map((c) => c.split(".")[0]),
];

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

/** Methods the proxy lets through (each returns the proxy again), plus awaiting. */
const CHAIN = new Set(["eq", "neq", "in", "is", "lt", "lte", "gt", "gte", "ilike", "not", "order", "range", "limit"]);

/** Every column in a select list, refused if it is not a plain, non-secret column of this table. */
export function assertReadableColumns(table: string, columns: string): void {
  const cols = columns.split(",").map((c) => c.trim());
  if (!cols.length || cols.some((c) => !c)) throw new HelpReadRefused(`${table}: empty column in '${columns}'`);
  for (const c of cols) {
    if (!COLUMN.test(c)) throw new HelpReadRefused(`${table}: '${c}' is not a plain column (no *, joins, aliases or casts)`);
    if (SECRET_COLUMNS.includes(`${table}.${c}`) || SECRET_NAME.test(c)) throw new HelpReadRefused(`${table}.${c} is a secret column`);
  }
}

export function assertReadableTable(table: string): asserts table is HelpReadTable {
  if (HELP_NEVER_TABLES.includes(table)) throw new HelpReadRefused(`${table} is a credential table`);
  if (!(HELP_READ_TABLES as readonly string[]).includes(table)) throw new HelpReadRefused(`${table} is not a help-readable table`);
}

function restrict<Row>(builder: object): HelpQuery<Row> {
  return new Proxy(builder, {
    get(target, prop) {
      if (prop === "then") {
        const then = (target as PromiseLike<unknown>).then;
        return then.bind(target);
      }
      if (typeof prop === "string" && CHAIN.has(prop)) {
        return (...args: unknown[]) => restrict<Row>((target as Record<string, (...a: unknown[]) => object>)[prop](...args));
      }
      return undefined;
    },
    set() { return false; },
  }) as unknown as HelpQuery<Row>;
}

/**
 * The tenant-scoped reader. `client` must be the person's own cookie client — callers are
 * runner.ts (HelpSession) and the legacy help-data-tools.ts only (guard test).
 */
export function scopedReader(client: SupabaseClient<Database>, tenantId: string): HelpDb {
  if (typeof tenantId !== "string" || !tenantId.trim()) throw new HelpReadRefused("no tenant");
  return Object.freeze({
    read<Row>(table: HelpReadTable, columns: string, options?: { count?: "exact"; head?: boolean }): HelpQuery<Row> {
      assertReadableTable(table);
      assertReadableColumns(table, columns);
      const opts = options ? { ...(options.count ? { count: "exact" as const } : {}), ...(options.head ? { head: true } : {}) } : undefined;
      const q = (client.from(table) as unknown as { select: (c: string, o?: object) => { eq: (c: string, v: string) => object } })
        .select(columns, opts).eq("tenant_id", tenantId);
      return restrict<Row>(q);
    },
  });
}
