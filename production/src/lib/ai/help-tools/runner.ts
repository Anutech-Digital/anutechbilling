/**
 * Help AI tool runner (R-2774 / H-01). Runs the model's tool calls — and refuses, without
 * reading anything, every call that breaks a rule:
 *
 *   1. Login: only a HelpSession from openHelpSession() (the person's cookie client, RLS). Any
 *      other object — or a service-role client — throws before a single call runs.
 *   2. Tenant: the tool gets a reader pinned to ctx.tenantId (tenant_id filter on every query,
 *      allowlisted tables, no secret columns — reader.ts). It never sees the client.
 *   3. Role: unknown role, a role not in the tool's roles, or a role that cannot open the
 *      tool's page → "not allowed", nothing read (fail-closed).
 *   4. Tier: only `read` runs today; `safe` / `confirm` are refused until their cards (H-06 /
 *      H-07) add undo and the confirm card.
 *   5. Input: the tool's strict zod schema — unknown keys, wrong types → refused.
 *   6. Output: checked against HELP_TOOL_OUTPUT; rows cut to the tool's cap (default 50, max
 *      200) with "showing N of M"; every OK result carries source refs (page link at least).
 *   7. Time: 5 s per tool; at most HELP_CALLS_MAX calls per batch. Never throws for a tool.
 */
import { HELP_TOOL_OUTPUT, HELP_ROWS_DEFAULT, HELP_ROWS_MAX, type HelpSourceRef, type HelpToolDef } from "./types";
import { HELP_TOOL_REGISTRY, helpToolAllowedFor, type HelpToolRegistry } from "./registry";
import { scopedReader } from "./reader";
import { sessionClient, type HelpSession } from "./session";

export const HELP_CALLS_MAX = 20;
export const HELP_TOOL_TIMEOUT_MS = 5_000;
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

const refused = (name: string, refusal: HelpCallRefusal, text: string): HelpToolCallResult =>
  ({ name, ok: false, refusal, text: `${name}: ${text}.`, sources: [], href: null, label: null });

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const timer = new Promise<never>((_, reject) => { t = setTimeout(() => reject(new Error("__help_timeout__")), ms); });
  return Promise.race([p, timer]).finally(() => clearTimeout(t));
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
  const db = scopedReader(sessionClient(session), ctx.tenantId);
  const now = ctx.now ?? new Date();
  const timeoutMs = opts.timeoutMs ?? HELP_TOOL_TIMEOUT_MS;

  return Promise.all(calls.map(async (call, i): Promise<HelpToolCallResult> => {
    const name = typeof call?.name === "string" ? call.name.slice(0, 64) : "unknown";
    if (i >= HELP_CALLS_MAX) return refused(name, "too_many_calls", `more than ${HELP_CALLS_MAX} tool calls in one go`);
    const tool: HelpToolDef | undefined = registry.get(name);
    if (!tool) return refused(name, "unknown_tool", "no such tool");
    if (!helpToolAllowedFor(ctx.role, tool)) return refused(name, "not_allowed", HELP_NOT_ALLOWED);
    if (tool.tier !== "read") return refused(name, "tier_not_enabled", `${tool.tier} tools are not switched on yet`);
    const input = tool.input.safeParse(call.input ?? {});
    if (!input.success) return refused(name, "bad_input", "the request did not match this tool's inputs");

    let raw: unknown;
    try {
      raw = await withTimeout(tool.run(input.data, { db, tenantId: ctx.tenantId, role: ctx.role, now }), timeoutMs);
    } catch (err) {
      const timedOut = (err as Error)?.message === "__help_timeout__";
      console.error(`[ai/help] tool ${name} ${timedOut ? "timed out" : "failed"}:`, (err as Error)?.message);
      return timedOut ? refused(name, "timeout", "took too long — try again in a minute")
        : refused(name, "failed", "could not be read just now — try again in a minute");
    }

    const out = HELP_TOOL_OUTPUT.safeParse(raw);
    if (!out.success) {
      console.error(`[ai/help] tool ${name} returned a bad shape`);
      return refused(name, "bad_output", "could not be read just now — try again in a minute");
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
  }));
}
