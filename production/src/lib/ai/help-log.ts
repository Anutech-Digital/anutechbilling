/**
 * Help AI assistant log (R-2778 / H-05, G-HELPAI) — every question and every tool run is
 * noted, so the owner can see what the AI was asked, which tools it ran and what came of it.
 *
 * How it is written (and why it is safe):
 *   - ONE database function, log_ai_assistant_event(), called with the person's own cookie client
 *     (the route's createClient(), the same login R-2774's openHelpSession wraps). A service-role
 *     client would write nothing: the function returns when auth.uid() is null. Tenant and user
 *     come from the login inside the
 *     function — this file has no argument for either, so it cannot write for someone else.
 *   - Only names, counts and times: a tool row has the tool name, tier, outcome, row COUNT and
 *     milliseconds. Result rows, result text and error messages are never written; the question
 *     is masked (maskPII: emails, GSTIN, PAN, phone and long numbers) and cut to 500 characters.
 *   - It never throws into an answer: a failing log is a console line, nothing more.
 *   - Reading is owner / manager of the same company only (RLS on the table).
 *
 * The runner tells us about each call through runHelpTools' ctx.onCall (refusals and rate-limit
 * refusals too); the route hands log.tool to runHelpDataToolsV2 so each call lands in THAT
 * request's log. help-tools/ does not import this file (the tool graph stays small, and the
 * guard allows no other export to be imported from outside).
 *
 * "AI on behalf of <person>" (activity_log.via = 'ai'): an AI write that runs with the person's
 * session sends aiActorHeaders(conversationId) on its Supabase request. The database
 * (audit_ai_via) honours them only for a conversation this person logged in the last 24 hours —
 * the question row written first by log.question() is that proof. Read-only tools write no
 * audit rows, so today nothing carries the header; H-06 (add_followup / add_note) is the first
 * caller.
 */
import { randomUUID } from "node:crypto";
import { maskPII } from "@/lib/ux/signals";
import type { HelpToolResult } from "@/lib/ai/help-data-tools";
import type { HelpCallInfo, HelpToolCallResult } from "./help-tools/runner";

export const HELP_VIA_HEADER = "x-actor-via";
export const HELP_CONVERSATION_HEADER = "x-actor-conversation";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The two headers that mark a write as "the AI did this for the signed-in person". Empty unless the id is a uuid. */
export function aiActorHeaders(conversationId: string | null | undefined): Record<string, string> {
  const id = (conversationId ?? "").trim();
  return UUID_RE.test(id) ? { [HELP_VIA_HEADER]: "ai", [HELP_CONVERSATION_HEADER]: id.toLowerCase() } : {};
}

export type HelpLogOutcome = "started" | "did" | "held" | "refused" | "failed" | "timeout";
export type HelpLogKind = "question" | "tool" | "answer";

export interface HelpLogRow {
  kind: HelpLogKind;
  tool?: string;
  tier?: "read" | "safe" | "confirm" | null;
  /** question text (kind question) or a short note: the refusal code (kind tool). */
  text?: string | null;
  outcome: HelpLogOutcome;
  rowIds?: string[];
  rowCount?: number | null;
  durationMs?: number | null;
  model?: string | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
}

/** ok → did · tier switched off → held · timeout → timeout · failed / bad output → failed · any other refusal → refused. */
export function outcomeOf(r: Pick<HelpToolCallResult, "ok" | "refusal">): HelpLogOutcome {
  if (r.ok) return "did";
  switch (r.refusal) {
    case "tier_not_enabled": return "held";
    case "timeout": return "timeout";
    case "unknown_tool": case "not_allowed": case "bad_input": case "too_many_calls": case "rate_limited": return "refused";
    default: return "failed"; // failed, bad_output, or no reason at all
  }
}

/** One tool call as a log row: name, tier, outcome, how many rows (a count), ms. Never the rows or the text. */
export function toolLogRow(info: HelpCallInfo): HelpLogRow {
  const r = info.result;
  const count = r.shown?.total ?? r.rows?.length;
  return {
    kind: "tool", tool: info.name, tier: info.tier, outcome: outcomeOf(r),
    text: r.ok ? null : (r.refusal ?? "failed"),
    rowCount: typeof count === "number" ? count : null,
    durationMs: Math.max(0, Math.round(info.ms)),
  };
}

type RpcClient = { rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ error: { message?: string } | null }> };

export interface HelpLog {
  readonly conversationId: string;
  /** Writes the question row NOW (awaited): it is also the proof the "AI on behalf of" marker looks for. */
  question(text: string): Promise<void>;
  /** Queue a tool row (pass as runHelpDataToolsV2's onCall; flushed by finish). */
  tool(info: HelpCallInfo): void;
  /** The R-421 path (flag off): its results become tool rows. */
  legacy(results: readonly HelpToolResult[], ms: number): void;
  /** Writes the queued tool rows, then the answer row. */
  finish(a: { ok: boolean; ms: number; model?: string | null; tokensIn?: number | null; tokensOut?: number | null; loopOutcome?: string | null }): Promise<void>;
}

/** A log for one question. `openClient` returns the person's own client; it is called on the first write (a refused or service-role client = no log, no error). */
/** A write waits at most this long: a slow log must never hold the answer back. */
export const HELP_LOG_BOUND_MS = 1000;

export function createHelpLog(openClient: () => unknown, opts: { conversationId?: string; boundMs?: number } = {}): HelpLog {
  const boundMs = opts.boundMs ?? HELP_LOG_BOUND_MS;
  const conversationId = opts.conversationId && UUID_RE.test(opts.conversationId) ? opts.conversationId.toLowerCase() : randomUUID();
  const queue: HelpLogRow[] = [];
  let client: RpcClient | null | undefined;

  const getClient = (): RpcClient | null => {
    if (client !== undefined) return client;
    try {
      client = openClient() as RpcClient;
    } catch (err) {
      console.error("[ai/help-log] no client, nothing logged:", (err as Error)?.message);
      client = null;
    }
    return client;
  };

  const write = async (row: HelpLogRow): Promise<void> => {
    const c = getClient();
    if (!c) return;
    try {
      const call = Promise.resolve(c.rpc("log_ai_assistant_event", {
        p_conversation_id: conversationId,
        p_kind: row.kind,
        p_tool: row.tool ?? null,
        p_tier: row.tier ?? null,
        p_text: row.text ?? null,
        p_outcome: row.outcome,
        p_row_ids: row.rowIds ?? null,
        p_row_count: row.rowCount ?? null,
        p_duration_ms: row.durationMs ?? null,
        p_model: row.model ?? null,
        p_tokens_in: row.tokensIn ?? null,
        p_tokens_out: row.tokensOut ?? null,
      }));
      /* bounded: after boundMs the answer goes on (the write may still land in the background) */
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<null>((r) => { timer = setTimeout(() => r(null), boundMs); });
      const done = await Promise.race([call, late]).finally(() => clearTimeout(timer));
      if (done === null) console.error("[ai/help-log] slow, not waiting for it");
      else if (done.error) console.error("[ai/help-log] not written:", done.error.message);
      call.catch(() => {}); // a late failure is not an unhandled rejection
    } catch (err) {
      console.error("[ai/help-log] not written:", (err as Error)?.message);
    }
  };

  return {
    conversationId,
    async question(text) {
      await write({ kind: "question", text: maskPII(text, 500) ?? "", outcome: "started" });
    },
    tool(info) { queue.push(toolLogRow(info)); },
    legacy(results, ms) {
      for (const r of results) {
        queue.push({
          kind: "tool", tool: String(r.tool).slice(0, 64), tier: "read",
          outcome: r.ok ? "did" : /not allowed/i.test(r.text) ? "refused" : "failed",
          text: r.ok ? null : /not allowed/i.test(r.text) ? "not_allowed" : "failed",
          durationMs: Math.max(0, Math.round(ms)),
        });
      }
    },
    async finish(a) {
      const rows = queue.splice(0, queue.length);
      await Promise.allSettled(rows.map(write));
      await write({
        kind: "answer", outcome: a.ok ? "did" : "failed", durationMs: Math.max(0, Math.round(a.ms)),
        /* R-2776: how the tool loop ended (answer / model_error / refusal / calls_cap …) — a fixed word, never model text. */
        text: typeof a.loopOutcome === "string" && /^[a-z_]{1,30}$/.test(a.loopOutcome) ? a.loopOutcome : null,
        model: a.model ?? null, tokensIn: a.tokensIn ?? null, tokensOut: a.tokensOut ?? null,
      });
    },
  };
}
