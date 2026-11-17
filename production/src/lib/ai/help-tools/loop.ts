/**
 * Help AI tool-use loop driver (R-2775 / H-02). The model-agnostic part of the loop: it asks the
 * model, runs the tool calls the model makes through the checked runner, hands the results back
 * and repeats until the model answers or a bound is hit. It holds NO network, key or client code:
 * the model call (`askModel`) and the runner (`runTools`) are handed in by lib/ai/help-data-tools.ts
 * (the one file the guard lets call runHelpTools), so this file lives under help-tools' own rules.
 *
 * What the loop adds on top of the runner (which already refuses an unknown / not-allowed tool,
 * checks input against the tool's strict parser, caps the calls per question and per person):
 *   - the model is offered ONLY the tools it was given (`tools` = helpToolsFor(role));
 *   - at most HELP_LOOP_ROUNDS_MAX rounds and HELP_LOOP_TOTAL_MS in all; a malformed tool request
 *     (no id, repeated id, no calls) ends the loop without running anything;
 *   - EVERY result goes back to the model inside the untrusted markers (untrusted.ts) — a refusal
 *     too. The line outside the markers names the tool from OUR list (never the model's text), and
 *     a refusal's sentence is ours, chosen by the refusal code;
 *   - one fresh marker id per round: text read in round 1 cannot know the id of round 2;
 *   - a result never starts anything by itself: the loop only runs what the MODEL asked for, the
 *     tools are read-only, and the final text is parsed by the route (parseHelpAnswer).
 * It never throws: a model that fails, times out or loops ends as an outcome, and the route turns
 * every outcome into a plain answer.
 */
import type { HelpToolDef, JsonSchema } from "./types";
import type { HelpToolCallResult } from "./runner";
import { newUntrustedId, wrapUntrusted } from "./untrusted";
import { HELP_QUESTION_CALLS_MAX } from "./limits";
import { HELP_CALLS_MAX } from "./runner";

export const HELP_LOOP_ROUNDS_MAX = 8;
/** Everything — model calls and tool runs — for ONE question. */
export const HELP_LOOP_TOTAL_MS = 60_000;
/** What one round's tool results may take in all (split over its results). */
export const HELP_LOOP_ROUND_CHARS = 12_000;
const MIN_LEFT_MS = 1_500;

export interface LoopToolSpec { name: string; description: string; input_schema: JsonSchema }
export interface LoopCall { id: string; name: string; input: unknown }
export interface LoopResult { id: string; text: string; isError: boolean }
/** One round: what the model asked (raw = its message, kept to replay it), what we answered. */
export interface LoopStep { calls: LoopCall[]; results: LoopResult[]; raw: unknown }
export interface LoopAsk { steps: readonly LoopStep[]; tools: readonly LoopToolSpec[]; timeoutMs: number }
export type LoopStop = "end" | "tool_use" | "refusal" | "max_tokens" | "other";
export interface LoopReply {
  stop: LoopStop;
  text: string;
  /** Straight from the model: nothing here is trusted until the loop has checked it. */
  calls: readonly { id: unknown; name: unknown; input: unknown }[];
  raw: unknown;
  usage?: { inputTokens: number; outputTokens: number };
}
export type LoopOutcome = "answer" | "refusal" | "max_tokens" | "rounds" | "calls_cap" | "rate_limited" | "time" | "model_error" | "malformed";
export interface LoopRun {
  outcome: LoopOutcome;
  /** The model's final text (outcome "answer" only). */
  text: string;
  /** Every OK tool result so far — the numbers a fallback answer can still give. */
  results: HelpToolCallResult[];
  rounds: number;
  toolCalls: number;
  tokensIn: number;
  tokensOut: number;
}

export interface LoopDeps {
  /** helpToolsFor(role): the tools this person's role may use — the model sees these and no others. */
  tools: readonly HelpToolDef[];
  askModel: (ask: LoopAsk) => Promise<LoopReply>;
  /** Runs one round's calls as the signed-in person, ONE session for every round. */
  runTools: (calls: { name: string; input: unknown }[]) => Promise<HelpToolCallResult[]>;
  maxRounds?: number;
  totalMs?: number;
}

const EMPTY_INPUT: JsonSchema = Object.freeze({ type: "object", properties: Object.freeze({}), required: Object.freeze([]), additionalProperties: false });
const CALL_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The sentence a refusal becomes. OURS — chosen by the code, never copied from the model's text. */
function refusalSentence(code: string | undefined): string {
  switch (code) {
    case "unknown_tool": return "no such tool — use only the tools in your tool list.";
    case "not_allowed": return "not allowed for this person's role.";
    case "bad_input": return "the input did not match this tool's input schema, so nothing was run. Fix the input, or answer without this tool.";
    case "timeout": return "took too long.";
    case "tier_not_enabled": return "this kind of tool is not switched on.";
    case "too_many_calls": return "too many tool calls for this question.";
    case "rate_limited": return "too many data lookups just now.";
    default: return "could not be read just now.";
  }
}

const emptyRun = (outcome: LoopOutcome, run: Omit<LoopRun, "outcome" | "text">, text = ""): LoopRun => ({ outcome, text, ...run });

export async function runToolLoop(deps: LoopDeps): Promise<LoopRun> {
  const byName = new Map<string, HelpToolDef>(deps.tools.map((t) => [t.name, t]));
  const specs: LoopToolSpec[] = deps.tools.map((t) => ({ name: t.name, description: t.describe, input_schema: t.inputSchema ?? EMPTY_INPUT }));
  const maxRounds = Math.max(1, Math.min(deps.maxRounds ?? HELP_LOOP_ROUNDS_MAX, HELP_LOOP_ROUNDS_MAX));
  const totalMs = Math.max(1, Math.min(deps.totalMs ?? HELP_LOOP_TOTAL_MS, HELP_LOOP_TOTAL_MS));
  const started = Date.now();
  const steps: LoopStep[] = [];
  const gathered: HelpToolCallResult[] = [];
  const run = { results: gathered, rounds: 0, toolCalls: 0, tokensIn: 0, tokensOut: 0 };

  for (let round = 0; round < maxRounds; round++) {
    const left = totalMs - (Date.now() - started);
    if (left < MIN_LEFT_MS) return emptyRun("time", run);

    let reply: LoopReply;
    try {
      reply = await deps.askModel({ steps, tools: specs, timeoutMs: left });
    } catch (err) {
      console.error("[ai/help] model call failed:", (err as Error)?.message);
      return emptyRun("model_error", run);
    }
    run.rounds = round + 1;
    run.tokensIn += reply.usage?.inputTokens ?? 0;
    run.tokensOut += reply.usage?.outputTokens ?? 0;

    if (reply.stop === "refusal") return emptyRun("refusal", run);
    if (reply.stop === "max_tokens") return emptyRun("max_tokens", run);
    if (reply.stop === "end") return emptyRun(reply.text.trim() ? "answer" : "malformed", run, reply.text);
    if (reply.stop !== "tool_use") return emptyRun("malformed", run);

    /* A tool request must be well formed before ANYTHING runs: at least one call, each with a plain
       id, no id twice. Anything else ends the loop — the model gets no second try at a broken turn. */
    const asked = reply.calls;
    const ids = asked.map((c) => (typeof c.id === "string" && CALL_ID.test(c.id) ? c.id : ""));
    if (!asked.length || ids.some((id) => !id) || new Set(ids).size !== ids.length) return emptyRun("malformed", run);
    /* R-2776 (finding 3 of R-2775): a turn that asks for more calls than ONE question may make (or than are
       left of it) is refused BEFORE the runner counts a single call — otherwise 50 calls spent 50 of the
       person's 120 although only 20 would run. The results already read still reach the answer. */
    if (asked.length > HELP_CALLS_MAX || run.toolCalls + asked.length > HELP_QUESTION_CALLS_MAX) return emptyRun("calls_cap", run);
    const calls: LoopCall[] = asked.map((c, i) => ({ id: ids.at(i) ?? "", name: typeof c.name === "string" ? c.name : "", input: c.input }));

    run.toolCalls += calls.length;
    let results: HelpToolCallResult[];
    try {
      results = await deps.runTools(calls.map((c) => ({ name: c.name, input: c.input })));
    } catch (err) {
      console.error("[ai/help] tools refused:", (err as Error)?.message);
      return emptyRun("model_error", run);
    }
    if (results.length !== calls.length) return emptyRun("malformed", run);

    const nonce = newUntrustedId();
    const share = Math.floor(HELP_LOOP_ROUND_CHARS / calls.length);
    const out: LoopResult[] = calls.map((c, i) => {
      const r = results.at(i);
      const tool = byName.get(c.name);
      const ok = !!r?.ok && !!tool;
      /* The header is ours: the registry's name and page. A name the model made up never appears outside the markers. */
      const header = ok && tool ? `[${tool.name}] (link: ${tool.page})` : `[${tool?.name ?? "unknown_tool"}]`;
      /* A tool that is not on this role's list is "no such tool" whatever the runner said — we never tell the model what exists beyond its list. */
      const body = ok && r ? r.text : refusalSentence(tool ? r?.refusal : "unknown_tool");
      return { id: c.id, isError: !ok, text: `${header}\n${wrapUntrusted(body, { max: share, nonce })}` };
    });
    for (const r of results) if (r.ok && byName.has(r.name)) gathered.push(r);
    steps.push({ calls, results: out, raw: reply.raw });

    /* The question (or the person) is out of calls: stop here rather than let the model spin. */
    if (results.some((r) => r.refusal === "too_many_calls")) return emptyRun("calls_cap", run);
    if (results.some((r) => r.refusal === "rate_limited")) return emptyRun("rate_limited", run);
  }
  return emptyRun("rounds", run);
}
