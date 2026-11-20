/**
 * The ONLY way MCP code reaches the database.
 *
 * ⚠️ Tenant isolation: every query runs on a Supabase client that carries a JWT minted for the
 * calling user (the same short-lived HS256 token the app mints for an Auth.js session —
 * src/server/auth/supabase-jwt.ts). So RLS (current_tenant_id()) decides what is visible, exactly
 * as in the app. No service-role client exists anywhere under src/lib/mcp
 * (src/lib/mcp/guard.test.ts fails the build if one appears).
 *
 * On top of RLS, McpDb adds a second lock: each table has a column allowlist, credential
 * columns are refused even if listed, and every select / update carries tenant_id = <caller's
 * tenant>. Tools see McpDb, never the client.
 */
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClientAsUser } from "@/lib/supabase/as-user";
import { SECRET_COLUMNS, SECRET_NAME } from "@/lib/security/secret-columns";

export type McpJson = string | number | boolean | null | McpJson[] | { [k: string]: McpJson };
export type McpRow = Record<string, unknown>;

export interface McpDbError { message: string; code?: string }
export interface McpResult<T> { data: T | null; error: McpDbError | null; count?: number | null }

/** Tables MCP may READ, with the columns it may name (select, filter, order). */
export const MCP_READ_COLUMNS = {
  leads: [
    "id", "company", "contact_name", "contact_email", "contact_phone", "stage", "pipeline", "source", "value",
    "seats", "plan", "owner_id", "follow_up_date", "expected_close_date", "created_at", "updated_at",
    "stage_changed_at", "requirement", "notes", "is_junk", "lost_reason", "lost_note", "enquiry_type", "priority",
    "domain", "customer_id", "billing_cycle",
  ],
  lead_activities: ["id", "lead_id", "kind", "detail", "created_at", "created_by"],
  inbound_emails: [
    "id", "from_name", "from_email", "subject", "status", "route", "created_at", "read_at", "lead_id",
    "ticket_id", "archived_at", "starred", "snoozed_until",
  ],
  tasks: [
    "id", "title", "kind", "status", "priority", "due_at", "owner_id", "lead_id", "customer_id", "quote_id",
    "subscription_id", "notes", "completed_at", "created_at", "reminder_minutes_before", "progress", "parent_task_id",
  ],
  customers: [
    "id", "name", "display_name", "customer_number", "customer_type", "contact_name", "contact_email",
    "contact_phone", "contact_mobile", "city", "state", "gstin", "is_active", "since", "payment_terms_days",
    "account_manager_id", "created_at",
  ],
  quotes: [
    "id", "customer_id", "customer_name", "lead_id", "status", "approval_status", "plan", "seats", "billing_cycle",
    "subtotal", "tax_rate", "amount", "discount_pct", "created_date", "expires_date", "invoice_id", "owner_id",
    "is_renewal", "currency", "payment_status", "revision_no",
  ],
  invoices: [
    "id", "customer_id", "customer_name", "invoice_date", "due_date", "status", "amount", "taxable_value",
    "tax_amount", "tax_rate", "net_payable", "paid_amount", "paid_date", "document_kind", "currency", "inter_state",
    "quote_id", "written_off_at", "created_at",
  ],
  payments: [
    "id", "customer_id", "invoice_id", "quote_id", "amount", "method", "status", "received_at", "refunded_at",
    "credit_applied", "receipt_voucher_no",
  ],
  subscriptions: [
    "id", "customer_id", "customer_name", "plan", "vendor", "seats", "mrr", "term_amount", "status", "billing_cycle",
    "renewal_date", "renewal_state", "auto_renew", "start_date", "term_months", "outstanding_amount", "domain",
    "written_off_at", "payment_due_date",
  ],
  bank_transactions: [
    "id", "bank_account_id", "txn_date", "description", "credit", "debit", "reference", "matched_at",
    "matched_to_type", "category",
  ],
  bank_accounts: ["id", "name", "bank_name", "account_number_last4", "is_active"],
  users: ["id", "full_name", "email", "phone", "role", "is_active", "manager_id", "employee_id", "created_at", "tenant_id", "access_ends_on"],
  employees: ["id", "name", "designation", "is_active", "joining_date", "exit_date"],
  attendance: ["id", "employee_id", "work_date", "check_in", "check_out", "source", "flags"],
  salary_payments: [
    "id", "employee_id", "period", "gross", "net", "paid_amount", "paid_status", "pay_date", "tds", "pf", "esi",
    "incentive", "lop_days", "lop_amount", "arrears", "advance_recovered", "other_deduction",
  ],
  support_tickets: [
    "id", "subject", "status", "priority", "category", "customer_id", "customer_name", "assigned_agent",
    "created_at", "sla_due_at", "resolved_at", "channel", "tier",
  ],
  support_ticket_notes: ["id", "ticket_id", "author_name", "body", "created_at"],
  mcp_oauth_grants: [
    "id", "user_id", "client_id", "client_name", "redirect_uri", "scope", "aal", "status", "code_hash",
    "code_challenge", "code_expires_at", "refresh_hash", "refresh_expires_at", "created_at", "last_used_at", "revoked_at",
  ],
  mcp_write_previews: [
    "id", "user_id", "tool", "input", "input_hash", "before_values", "idempotency_key", "status", "result",
    "created_at", "expires_at", "confirmed_at",
  ],
} as const satisfies Record<string, readonly string[]>;

export type McpReadTable = keyof typeof MCP_READ_COLUMNS;

/** Tables MCP may WRITE (Phase A — outside Billing & Subscriptions — plus its own bookkeeping). */
export const MCP_WRITE_TABLES = [
  "leads", "tasks", "support_ticket_notes", "mcp_audit_log", "mcp_oauth_grants", "mcp_write_previews",
] as const;
export type McpWriteTable = (typeof MCP_WRITE_TABLES)[number];

/** RPCs MCP may call — all SECURITY INVOKER or RLS-checked reads, plus the lead activity log. */
export const MCP_RPCS = ["today_inbox", "report_pnl", "log_lead_activity", "find_lead_duplicates"] as const;
export type McpRpc = (typeof MCP_RPCS)[number];

export class McpDbRefused extends Error {
  constructor(why: string) { super(`mcp db refused: ${why}`); this.name = "McpDbRefused"; }
}

const SECRETS = new Set(SECRET_COLUMNS);

export function assertColumn(table: McpReadTable, column: string): void {
  const allowed: readonly string[] = MCP_READ_COLUMNS[table];
  if (!allowed.includes(column)) throw new McpDbRefused(`${table}.${column} is not readable`);
  if (SECRETS.has(`${table}.${column}`)) throw new McpDbRefused(`${table}.${column} is a secret column`);
  /* The hashes on MCP's own bookkeeping tables (code / refresh / input hashes) are compared,
     never shown; on every other table a name that looks like a credential is refused. */
  if (SECRET_NAME.test(column) && !table.startsWith("mcp_")) throw new McpDbRefused(`${table}.${column} looks like a credential`);
}

/** Plain text for an ilike search: letters, digits, space and . @ - only (no PostgREST syntax, no LIKE wildcards). */
export function searchText(raw: string): string {
  return raw.normalize("NFKC").replace(/[^\p{L}\p{N} @.-]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 80);
}

export interface McpQuery<Row> extends PromiseLike<McpResult<Row[]>> {
  eq(column: string, value: string | number | boolean): McpQuery<Row>;
  neq(column: string, value: string | number | boolean): McpQuery<Row>;
  in(column: string, values: readonly (string | number)[]): McpQuery<Row>;
  is(column: string, value: null | boolean): McpQuery<Row>;
  not_null(column: string): McpQuery<Row>;
  gte(column: string, value: string | number): McpQuery<Row>;
  lte(column: string, value: string | number): McpQuery<Row>;
  lt(column: string, value: string | number): McpQuery<Row>;
  gt(column: string, value: string | number): McpQuery<Row>;
  /** ilike '%text%' on ANY of the columns; text is cleaned by searchText(). */
  search(columns: readonly string[], text: string): McpQuery<Row>;
  order(column: string, opts?: { ascending?: boolean }): McpQuery<Row>;
  page(offset: number, limit: number): McpQuery<Row>;
}

export interface McpDb {
  readonly tenantId: string;
  select<Row = McpRow>(table: McpReadTable, columns: readonly string[], opts?: { count?: boolean }): McpQuery<Row>;
  insert<Row = McpRow>(table: McpWriteTable, row: Record<string, McpJson>, returning: readonly string[]): Promise<McpResult<Row>>;
  /** Update ONE row of this tenant by id. */
  updateById<Row = McpRow>(table: McpWriteTable, id: string, patch: Record<string, McpJson>, returning: readonly string[]): Promise<McpResult<Row>>;
  /** Conditional update (compare-and-set) — returns the rows it changed. */
  updateWhere<Row = McpRow>(table: McpWriteTable, match: Record<string, string>, patch: Record<string, McpJson>, returning: readonly string[]): Promise<McpResult<Row[]>>;
  rpc<T = unknown>(fn: McpRpc, args?: Record<string, McpJson>): Promise<McpResult<T>>;
}

type Filterable = {
  eq(c: string, v: unknown): Filterable; neq(c: string, v: unknown): Filterable; in(c: string, v: readonly unknown[]): Filterable;
  is(c: string, v: null | boolean): Filterable; not(c: string, op: string, v: unknown): Filterable;
  gte(c: string, v: unknown): Filterable; lte(c: string, v: unknown): Filterable; lt(c: string, v: unknown): Filterable; gt(c: string, v: unknown): Filterable;
  or(f: string): Filterable; order(c: string, o?: { ascending?: boolean; nullsFirst?: boolean }): Filterable; range(a: number, b: number): Filterable;
} & PromiseLike<{ data: unknown; error: { message: string; code?: string } | null; count?: number | null }>;

function wrapQuery<Row>(table: McpReadTable, start: Filterable): McpQuery<Row> {
  let q = start;
  const col = (c: string) => { assertColumn(table, c); return c; };
  const self: McpQuery<Row> = {
    eq(c, v) { q = q.eq(col(c), v); return self; },
    neq(c, v) { q = q.neq(col(c), v); return self; },
    in(c, v) { q = q.in(col(c), v); return self; },
    is(c, v) { q = q.is(col(c), v); return self; },
    not_null(c) { q = q.not(col(c), "is", null); return self; },
    gte(c, v) { q = q.gte(col(c), v); return self; },
    lte(c, v) { q = q.lte(col(c), v); return self; },
    lt(c, v) { q = q.lt(col(c), v); return self; },
    gt(c, v) { q = q.gt(col(c), v); return self; },
    search(cols, text) {
      const t = searchText(text);
      if (!t) return self;
      q = q.or(cols.map((c) => `${col(c)}.ilike.%${t}%`).join(","));
      return self;
    },
    order(c, o) { q = q.order(col(c), { ascending: o?.ascending ?? true, nullsFirst: false }); return self; },
    page(offset, limit) {
      const from = Math.max(0, Math.floor(offset));
      const n = Math.min(Math.max(1, Math.floor(limit)), 200);
      q = q.range(from, from + n - 1);
      return self;
    },
    then(onOk, onErr) {
      return q.then((r) => ({
        data: (r.data as Row[] | null) ?? null,
        error: r.error ? { message: r.error.message, code: r.error.code } : null,
        count: r.count ?? null,
      })).then(onOk, onErr);
    },
  };
  return self;
}

function asFilterable(x: unknown): Filterable {
  return x as Filterable;
}

function errOf(e: { message: string; code?: string } | null): McpDbError | null {
  return e ? { message: e.message, code: e.code } : null;
}

function cols(table: McpReadTable | McpWriteTable, columns: readonly string[]): string {
  if (columns.length === 0) throw new McpDbRefused("an explicit column list is required");
  if (table in MCP_READ_COLUMNS) for (const c of columns) assertColumn(table as McpReadTable, c);
  return columns.join(",");
}

/** McpDb over a raw supabase-js client. Exported for the identity step (which has no tenant yet). */
export function mcpDbFromClient(client: SupabaseClient, tenantId: string): McpDb {
  if (!tenantId) throw new McpDbRefused("no tenant");
  return {
    tenantId,
    select(table, columns, opts) {
      if (!(table in MCP_READ_COLUMNS)) throw new McpDbRefused(`${table} is not readable`);
      const q = asFilterable(client.from(table).select(cols(table, columns), opts?.count ? { count: "exact" } : undefined));
      /* users has tenant_id too; every readable table does — the filter is never optional. */
      return wrapQuery(table, q.eq("tenant_id", tenantId));
    },
    async insert(table, row, returning) {
      if (!(MCP_WRITE_TABLES as readonly string[]).includes(table)) throw new McpDbRefused(`${table} is not writable`);
      const r = await client.from(table).insert({ ...row, tenant_id: tenantId }).select(returning.join(",")).single();
      return { data: (r.data as never) ?? null, error: errOf(r.error) };
    },
    async updateById(table, id, patch, returning) {
      if (!(MCP_WRITE_TABLES as readonly string[]).includes(table)) throw new McpDbRefused(`${table} is not writable`);
      if ("tenant_id" in patch || "id" in patch) throw new McpDbRefused("id / tenant_id cannot be changed");
      const r = await client.from(table).update(patch).eq("id", id).eq("tenant_id", tenantId).select(returning.join(",")).maybeSingle();
      return { data: (r.data as never) ?? null, error: errOf(r.error) };
    },
    async updateWhere(table, match, patch, returning) {
      if (!(MCP_WRITE_TABLES as readonly string[]).includes(table)) throw new McpDbRefused(`${table} is not writable`);
      if ("tenant_id" in patch || "id" in patch) throw new McpDbRefused("id / tenant_id cannot be changed");
      let q = asFilterable(client.from(table).update(patch).eq("tenant_id", tenantId));
      for (const [k, v] of Object.entries(match)) q = q.eq(k, v);
      const r = await asFilterable((q as unknown as { select(c: string): unknown }).select(returning.join(",")));
      return { data: (r.data as never) ?? null, error: errOf(r.error) };
    },
    async rpc(fn, args) {
      if (!(MCP_RPCS as readonly string[]).includes(fn)) throw new McpDbRefused(`${fn} is not callable`);
      const r = await client.rpc(fn, args ?? {});
      return { data: (r.data as never) ?? null, error: errOf(r.error) };
    },
  };
}

/** The caller's identity row, read as the caller (RLS lets a user read their own users row). */
export async function readSelf(userId: string, email: string, aal: "aal1" | "aal2"): Promise<{
  client: SupabaseClient;
  row: { id: string; tenant_id: string; role: string | null; is_active: boolean | null; full_name: string | null; access_ends_on: string | null } | null;
  error: McpDbError | null;
}> {
  const client = createClientAsUser(userId, email, aal);
  const r = await client.from("users").select("id, tenant_id, role, is_active, full_name, access_ends_on").eq("id", userId).maybeSingle();
  return { client, row: (r.data as never) ?? null, error: errOf(r.error) };
}
