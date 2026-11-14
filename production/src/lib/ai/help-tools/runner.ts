/**
 * Help AI tool runner (R-2774 / H-01). Runs the model's tool calls — and refuses, without
 * reading anything, every call that breaks a rule:
 *
 *   1. Login: only a HelpSession from openHelpSession() (the person's cookie client, RLS). Any
 *      other object — or a service-role client — throws before a single call runs.
 *   2. Tenant: the tool gets a reader pinned to ctx.tenantId (tenant_id filter on every query,
 *      allowlisted tables, no secret columns in select or filters — reader.ts). It never sees
 *      the client.
 *   3. Role: unknown role, a role not in the tool's roles, or a role that cannot open the
 *      tool's page → "not allowed", nothing read (fail-closed).
 *   4. Tier: only `read` runs today; `safe` / `confirm` are refused until their cards (H-06 /
 *      H-07) add undo and the confirm card.
 *   5. Input: the tool's strict zod schema — unknown keys, wrong types → refused.
 *   6. Output: checked against HELP_TOOL_OUTPUT; rows cut to the tool's cap (default 50, max
 *      200) with "showing N of M"; every OK result carries source refs (page link at least).
 *   7. Time: HELP_TOOL_TIMEOUT_MS per tool — the reads are ABORTED, not left running; at most
 *      HELP_CALLS_MAX calls per batch. Never throws for a tool.
 *
 * runOneTool (rules 4-7) is shared with the legacy R-421 path (help-data-tools.ts), which keeps
 * only its own role rule.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import type { UserRole } from "@/lib/auth/roles";
import { HELP_TOOL_OUTPUT, HELP_ROWS_DEFAULT, HELP_ROWS_MAX, type HelpSourceRef, type HelpToolDef } from "./types";
import { HELP_TOOL_REGISTRY, helpToolAllowedFor, type HelpToolRegistry } from "./registry";
import { scopedReader } from "./reader";
import { sessionClient, type HelpSession } from "./session";

export const HELP_CALLS_MAX = 20;
/** 10 s: a few thousand rows page through fetchAllRows (1,000 a page) well inside it. */
export const HELP_TOOL_TIMEOUT_MS = 10_000;
export const HELP_NOT_ALLOWED = "not allowed for your role";

export type HelpCallRefusal = "unknown_tool" | "not_allowed" | "tier_not_enabled" | "bad_input" | "bad_output" | "failed" | "timeout" | "too_many_calls";

export interface HelpToolCall { name: string; input?: unknown }

export interface HelpToolCallResult {
  name: string;
  ok: boolean;
  refusal?: HelpCallRefusal;
  text: string;
  rows?: Record<string, string | number | boolean | null>[];
  /** Set when rows were cut: shown of total. */
  shown?: { shown: number; total: number };
  sources: HelpSourceRef[];
  /** The tool's page + label when OK (the answer's link). */
  href: string | null;
  label: string | null;
}

export interface HelpRunCtx { tenantId: string; role: unknown; now?: Date }

export const refusedResult = (name: string, refusal: HelpCallRefusal, text: string): HelpToolCallResult =>
  ({ name, ok: false, refusal, text: `${name}: ${text}.`, sources: [], href: null, label: null });

const TIMEOUT = "__help_timeout__";

/**
 * Run ONE tool whose role check the caller has already passed: tier, strict input, abortable
 * timeout, output shape, row cap, sources. `client` is the person's own cookie client.
 */
export async function runOneTool(
  tool: HelpToolDef,
  input: unknown,
  ctx: { client: SupabaseClient<Database>; tenantId: string; role: UserRole; now: Date; timeoutMs: number },
): Promise<HelpToolCallResult> {
  const name = tool.name;
  if (tool.tier !== "read") return refusedResult(name, "tier_not_enabled", `${tool.tier} tools are not switched on yet`);
  const parsed = tool.input.safeParse(input ?? {});
  if (!parsed.success) return refusedResult(name, "bad_input", "the request did not match this tool's inputs");

  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let raw: unknown;
  try {
    const db = scopedReader(ctx.client, ctx.tenantId, { signal: abort.signal });
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { abort.abort(); reject(new Error(TIMEOUT)); }, ctx.timeoutMs);
    });
    raw = await Promise.race([tool.run(parsed.data, { db, tenantId: ctx.tenantId, role: ctx.role, now: ctx.now }), timedOut]);
  } catch (err) {
    const isTimeout = (err as Error)?.message === TIMEOUT;
    console.error(`[ai/help] tool ${name} ${isTimeout ? "timed out" : "failed"}:`, (err as Error)?.message);
    return isTimeout ? refusedResult(name, "timeout", "took too long — try again in a minute")
      : refusedResult(name, "failed", "could not be read just now — try again in a minute");
  } finally {
    clearTimeout(timer);
  }

  const out = HELP_TOOL_OUTPUT.safeParse(raw);
  if (!out.success) {
    console.error(`[ai/help] tool ${name} returned a bad shape`);
    return refusedResult(name, "bad_output", "could not be read just now — try again in a minute");
  }
  const cap = Math.min(tool.maxRows ?? HELP_ROWS_DEFAULT, HELP_ROWS_MAX);
  let text = out.data.text;
  let rows = out.data.rows;
  let shown: HelpToolCallResult["shown"];
  if (rows) {
    const total = Math.max(out.data.total ?? rows.length, rows.length);
    if (rows.length > cap) rows = rows.slice(0, cap);
    if (total > rows.length) {
      shown = { shown: rows.length, total };
      text = `${text}\n(showing ${rows.length} of ${total})`;
    }
  }
  const sources = out.data.sources.length ? out.data.sources : [{ table: null, ids: [], href: tool.page, label: tool.label }];
  return { name, ok: true, text, ...(rows ? { rows } : {}), ...(shown ? { shown } : {}), sources, href: tool.page, label: tool.label };
}

/**
 * Run tool calls as the signed-in person. Throws ONLY for a bad session or a missing tenant
 * (nothing may run then); every per-tool problem comes back as a refused result.
 */
export async function runHelpTools(
  session: HelpSession,
  ctx: HelpRunCtx,
  calls: readonly HelpToolCall[],
  registry: HelpToolRegistry = HELP_TOOL_REGISTRY,
  opts: { timeoutMs?: number } = {},
): Promise<HelpToolCallResult[]> {
  const client = sessionClient(session);
  scopedReader(client, ctx.tenantId); // no tenant → throws before any call
  const role = ctx.role;
  const now = ctx.now ?? new Date();
  const timeoutMs = opts.timeoutMs ?? HELP_TOOL_TIMEOUT_MS;

  return Promise.all(calls.map(async (call, i): Promise<HelpToolCallResult> => {
    const name = typeof call?.name === "string" ? call.name.slice(0, 64) : "unknown";
    if (i >= HELP_CALLS_MAX) return refusedResult(name, "too_many_calls", `more than ${HELP_CALLS_MAX} tool calls in one go`);
    const tool: HelpToolDef | undefined = registry.get(name);
    if (!tool) return refusedResult(name, "unknown_tool", "no such tool");
    if (!helpToolAllowedFor(role, tool)) return refusedResult(name, "not_allowed", HELP_NOT_ALLOWED);
    return runOneTool(tool, call.input, { client, tenantId: ctx.tenantId, role, now, timeoutMs });
  }));
}
