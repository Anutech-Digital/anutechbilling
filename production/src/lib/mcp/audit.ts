/**
 * mcp_audit_log — one row per tool call: who, which connection, which tool, the input (long
 * text capped), the outcome, and before/after for writes.
 *
 * Written as the caller (RLS: own tenant, own user id). An audit insert that fails does not
 * hide the tool's answer, but it is logged loudly — a missing audit row is an incident, not a
 * detail (AGENTS.md L102: refusals AND successes are recorded).
 */
import type { McpContext } from "@/lib/mcp/context";
import type { McpJson } from "@/lib/mcp/db";

export type AuditStatus = "ok" | "preview" | "replay" | "denied" | "invalid" | "not_found" | "error" | "rate_limited";

function cap(v: unknown, depth = 0): McpJson {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v.length > 500 ? `${v.slice(0, 499)}…` : v;
  if (typeof v === "number" || typeof v === "boolean") return v;
  if (depth > 4) return "[nested]";
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => cap(x, depth + 1));
  if (typeof v === "object") {
    const out: Record<string, McpJson> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, 60)) out[k] = cap(x, depth + 1);
    return out;
  }
  return String(v);
}

export async function writeAudit(ctx: McpContext, row: {
  tool: string; input: unknown; status: AuditStatus; error?: string | null; before?: unknown; after?: unknown; ms: number;
}): Promise<void> {
  const r = await ctx.db.insert("mcp_audit_log", {
    user_id: ctx.userId,
    grant_id: ctx.grantId,
    client_name: ctx.clientName.slice(0, 100),
    tool: row.tool.slice(0, 64),
    input: cap(row.input),
    status: row.status,
    error: row.error ? row.error.slice(0, 500) : null,
    before_values: row.before === undefined ? null : cap(row.before),
    after_values: row.after === undefined ? null : cap(row.after),
    duration_ms: Math.max(0, Math.round(row.ms)),
  }, ["id"]);
  if (r.error) console.error(`[mcp] audit insert failed for ${row.tool} (${row.status}): ${r.error.message}`);
}
