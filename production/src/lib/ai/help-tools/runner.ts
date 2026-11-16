/**
 * Help AI tool runner (R-2774 / H-01). Runs the model's tool calls — and refuses, without
 * reading anything, every call that breaks a rule:
 *
 *   1. Login: only a HelpSession from openHelpSession() (the person's cookie client, RLS). Any
 *      other object — or a service-role client — throws before a single call runs. A missing
 *      user id throws too (R-2879: the per-user limit cannot be skipped by leaving it out).
 *   2. Tenant: the tool gets a reader pinned to ctx.tenantId (tenant_id filter on every query,
 *      allowlisted tables, no secret columns in select or filters — reader.ts). It never sees
 *      the client.
 *   3. Role: unknown role, a role not in the tool's roles, or a role that cannot open the
 *      tool's page → "not allowed", nothing read (fail-closed).
 *   4. Tier: only `read` runs today; `safe` / `confirm` are refused until their cards (H-06 /
 *      H-07) add undo and the confirm card.
 *   5. Input: the tool's strict zod schema — unknown keys, wrong types → refused.
 *   6. Output: rows cut to the tool's cap (default 50, max 200) BEFORE the shape check, then
 *      checked against HELP_TOOL_OUTPUT (at most 20 plain columns a row, links are app paths);
 *      text, row values and source labels cleaned of control characters and marker look-alikes
 *      (untrusted.ts); the whole result kept under HELP_RESULT_BYTES_MAX (UTF-8 bytes) with "showing N of M";
 *      every OK result carries source refs (page link at least).
 *   7. Time and count: HELP_TOOL_TIMEOUT_MS per tool — the reads are ABORTED, not left running;
 *      at most HELP_TOOL_RATE calls per person (limits.ts — every call counts, refused ones
 *      too), HELP_CALLS_MAX per batch, and HELP_QUESTION_CALLS_MAX per question (counted on the
 *      session over all batches; unknown-tool and not-allowed calls use it up as well). Never
 *      throws for a tool.
 *
 * runOneTool (rules 4-6 and the timeout) is shared with the legacy R-421 path
 * (help-data-tools.ts), which keeps only its own role rule.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import type { UserRole } from "@/lib/auth/roles";
import { HELP_TOOL_OUTPUT, HELP_ROWS_DEFAULT, HELP_ROWS_MAX, HELP_RESULT_BYTES_MAX, isHelpToolDef, type HelpSourceRef, type HelpToolDef } from "./types";
import { HELP_TOOL_REGISTRY, helpToolAllowedFor, type HelpToolRegistry } from "./registry";
import { scopedReader } from "./reader";
import { assertNotServiceRole, sessionClient, takeHelpCalls, HelpSessionRefused, type HelpSession } from "./session";
import { HELP_QUESTION_CALLS_MAX, helpToolRateOk, isHelpUserId } from "./limits";
import { cleanHelpBlock, cleanHelpText } from "./untrusted";

export const HELP_CALLS_MAX = 20;
/** 10 s: a few thousand rows page through fetchAllRows (1,000 a page) well inside it. */
export const HELP_TOOL_TIMEOUT_MS = 10_000;
export const HELP_NOT_ALLOWED = "not allowed for your role";
export const HELP_RATE_LIMITED = "too many data lookups just now — wait a few minutes and ask again";

export type HelpCallRefusal = "unknown_tool" | "not_allowed" | "tier_not_enabled" | "bad_input" | "bad_output" | "failed" | "timeout" | "too_many_calls" | "rate_limited";

export interface HelpToolCall { name: string; input?: unknown }

type HelpRow = Record<string, string | number | boolean | null>;

export interface HelpToolCallResult {
  name: string;
  ok: boolean;
  refusal?: HelpCallRefusal;
  text: string;
  rows?: HelpRow[];
  /** Set when rows were cut: shown of total. */
  shown?: { shown: number; total: number };
  sources: HelpSourceRef[];
  /** The tool's page + label when OK (the answer's link). */
  href: string | null;
  label: string | null;
}

/** `userId`, `tenantId` and `role` are the signed-in person's — from the session, never from the model. */
export interface HelpRunCtx { userId: unknown; tenantId: string; role: unknown; now?: Date }

export const refusedResult = (name: string, refusal: HelpCallRefusal, text: string): HelpToolCallResult =>
  ({ name, ok: false, refusal, text: `${name}: ${text}.`, sources: [], href: null, label: null });

const TIMEOUT = "__help_timeout__";
/** Longest row cell (the same number HELP_TOOL_OUTPUT allows). */
const HELP_CELL_MAX = 500;
/** UTF-8 bytes of a value as JSON — what the result costs to send, whatever the script. */
const jsonBytes = (v: unknown): number => Buffer.from(JSON.stringify(v)).length;

/** Rows cut to the cap before anything walks them: a tool cannot make the runner check 50,000 rows. */
function cutRows(raw: unknown, cap: number): { raw: unknown; had: number } {
  if (typeof raw !== "object" || raw === null) return { raw, had: 0 };
  const rows = (raw as { rows?: unknown }).rows;
  if (!Array.isArray(rows) || rows.length <= cap) return { raw, had: Array.isArray(rows) ? rows.length : 0 };
  return { raw: { ...raw, rows: rows.slice(0, cap) }, had: rows.length };
}

/**
 * A row cell is somebody's typing (a name, a note): one line, no hidden characters or marker
 * look-alikes. It is a record value, so it is not cut below the schema's 500 characters and keeps
 * its [ ] (an invoice ref, a link) — the whole-result size bound is what limits rows.
 */
function cleanRow(row: HelpRow): HelpRow {
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === "string" ? cleanHelpText(v, HELP_CELL_MAX, { brackets: true }) : v]));
}

/** Source refs: cleaned labels and ids; at most HELP_ROWS_MAX ids over all of them. */
function cleanSources(sources: readonly HelpSourceRef[], fallbackLabel: string): HelpSourceRef[] {
  let left = HELP_ROWS_MAX;
  return sources.map((s) => {
    const ids = s.ids.map((id) => cleanHelpText(id, 80)).filter(Boolean).slice(0, left);
    left -= ids.length;
    return { table: s.table, ids, href: s.href, label: cleanHelpText(s.label, 120) || fallbackLabel };
  });
}

/**
 * Run ONE tool whose role check the caller has already passed: tier, strict input, abortable
 * timeout, output shape, row cap, cleaning, size, sources. `client` is the person's own cookie client.
 */
export async function runOneTool(
  tool: HelpToolDef,
  input: unknown,
  ctx: { client: SupabaseClient<Database>; tenantId: string; role: UserRole; now: Date; timeoutMs: number },
): Promise<HelpToolCallResult> {
  /* R-2879: only a tool made by defineHelpTool runs — a look-alike object has skipped every registration check. */
  if (!isHelpToolDef(tool)) {
    console.error("[ai/help] refused a tool that was not made by defineHelpTool");
    return refusedResult("unknown", "unknown_tool", "no such tool");
  }
  const name = tool.name;
  /* Second lock for the legacy caller, which hands in the route's client (review L4): a
     service-role key or fixed bearer reads nothing. A refused result, so that path never throws. */
  try {
    assertNotServiceRole(ctx.client);
  } catch (err) {
    console.error(`[ai/help] tool ${name} refused:`, (err as Error)?.message);
    return refusedResult(name, "failed", "could not be read just now — try again in a minute");
  }
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

  const cap = Math.min(tool.maxRows ?? HELP_ROWS_DEFAULT, HELP_ROWS_MAX);
  const cut = cutRows(raw, cap);
  const out = HELP_TOOL_OUTPUT.safeParse(cut.raw);
  if (!out.success) {
    console.error(`[ai/help] tool ${name} returned a bad shape`);
    return refusedResult(name, "bad_output", "could not be read just now — try again in a minute");
  }
  const body = cleanHelpBlock(out.data.text, 8000);
  if (!body.trim()) {
    console.error(`[ai/help] tool ${name} returned no readable text`);
    return refusedResult(name, "bad_output", "could not be read just now — try again in a minute");
  }
  const sources = cleanSources(out.data.sources.length ? out.data.sources : [{ table: null, ids: [], href: tool.page, label: tool.label }], tool.label);
  let rows = out.data.rows?.map(cleanRow);
  const total = rows ? Math.max(out.data.total ?? cut.had, cut.had, rows.length) : 0;
  const build = (): HelpToolCallResult => {
    const shown = rows && total > rows.length ? { shown: rows.length, total } : undefined;
    const text = shown ? `${body}\n(showing ${shown.shown} of ${shown.total})` : body;
    return { name, ok: true, text, ...(rows ? { rows } : {}), ...(shown ? { shown } : {}), sources, href: tool.page, label: tool.label };
  };
  let result = build();
  /* Whole-result size in bytes: rows go from the end until it fits (counted in "showing N of M").
     Each row is measured once; the last loop only trims the row or two the estimate missed. */
  if (rows && rows.length && jsonBytes(result) > HELP_RESULT_BYTES_MAX) {
    const all = rows;
    rows = [];
    let used = jsonBytes(build()) + 64; // without rows, plus room for the "(showing N of M)" line
    let keep = 0;
    for (const r of all) {
      used += jsonBytes(r) + 1;
      if (used > HELP_RESULT_BYTES_MAX) break;
      keep++;
    }
    rows = all.slice(0, keep);
    result = build();
    while (rows.length && jsonBytes(result) > HELP_RESULT_BYTES_MAX) {
      rows = rows.slice(0, rows.length - 1);
      result = build();
    }
  }
  return result;
}

/**
 * Run tool calls as the signed-in person. Throws ONLY for a bad session, a missing tenant or a
 * missing user id (nothing may run then); every per-tool problem comes back as a refused result.
 * `registry` is for help-tools tests only — the guard lets no other file pass a 4th argument.
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
  const userId = ctx.userId;
  if (!isHelpUserId(userId)) throw new HelpSessionRefused("no user");
  const role = ctx.role;
  const now = ctx.now ?? new Date();
  const timeoutMs = opts.timeoutMs ?? HELP_TOOL_TIMEOUT_MS;

  return Promise.all(calls.map(async (call, i): Promise<HelpToolCallResult> => {
    const name = typeof call?.name === "string" ? cleanHelpText(call.name, 64) || "unknown" : "unknown";
    /* R-2879: EVERY call counts for the person (also ones refused below), then the batch cap,
       then the question's total over all batches. */
    if (!helpToolRateOk(userId)) return refusedResult(name, "rate_limited", HELP_RATE_LIMITED);
    if (i >= HELP_CALLS_MAX) return refusedResult(name, "too_many_calls", `more than ${HELP_CALLS_MAX} tool calls in one go`);
    if (!takeHelpCalls(session)) return refusedResult(name, "too_many_calls", `more than ${HELP_QUESTION_CALLS_MAX} tool calls for one question`);
    const tool: HelpToolDef | undefined = registry.get(typeof call?.name === "string" ? call.name : "");
    if (!tool) return refusedResult(name, "unknown_tool", "no such tool");
    if (!helpToolAllowedFor(role, tool)) return refusedResult(name, "not_allowed", HELP_NOT_ALLOWED);
    return runOneTool(tool, call.input, { client, tenantId: ctx.tenantId, role, now, timeoutMs });
  }));
}
