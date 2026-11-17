/**
 * R-2775 / H-02 — one round of Claude native tool use for the Help AI loop.
 *
 * The loop itself (rounds, tool runs, untrusted wrapping) is lib/ai/help-tools/loop.ts; this file
 * is only the Anthropic side: it turns the loop's steps into Messages API turns and the reply
 * back into a LoopReply. Request shape, from the Claude API docs for claude-opus-5-5:
 *   - model = ANTHROPIC_MODEL (claude.ts), no `thinking`, no `temperature` / `top_p` (400s);
 *     depth is output_config.effort "low";
 *   - tools with `strict: true` and tool_choice "auto" (forced tool_choice is a 400 on this model);
 *   - server-side fallbacks "default" (beta server-side-fallback-2026-07-01) for refusals;
 *   - the model's own message (thinking blocks included) is replayed UNCHANGED next round, and all
 *     tool_result blocks of a round go back in ONE user message.
 * stop_reason refusal / max_tokens come back as such, never as text. A failed call throws — the
 * loop turns that into a plain fallback answer.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { claudeClient, errorResult } from "@/lib/ai/claude";
import type { LoopAsk, LoopReply, LoopStop } from "@/lib/ai/help-tools/loop";

/** The part of the Anthropic client this file uses (so a test can hand in a mock). */
export interface ClaudeToolClient {
  beta: { messages: { create: (body: Record<string, unknown>, opts?: Record<string, unknown>) => Promise<Anthropic.Beta.Messages.BetaMessage> } };
}

export const CLAUDE_TOOLS_MAX_TOKENS = 16_000;
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

function stopOf(reason: string | null | undefined): LoopStop {
  switch (reason) {
    case "end_turn": case "stop_sequence": return "end";
    case "tool_use": return "tool_use";
    case "refusal": return "refusal";
    case "max_tokens": return "max_tokens";
    default: return "other";
  }
}

/** The Messages API turns for the question so far: the user's text, then each round's replay + results. */
export function toolMessages(user: string, steps: LoopAsk["steps"]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [{ role: "user", content: user }];
  for (const s of steps) {
    out.push({ role: "assistant", content: s.raw });
    out.push({ role: "user", content: s.results.map((r) => ({ type: "tool_result", tool_use_id: r.id, content: r.text, ...(r.isError ? { is_error: true } : {}) })) });
  }
  return out;
}

export function claudeToolAsk(cfg: { apiKey: string; model: string; system: string; user: string; client?: ClaudeToolClient; label?: string }): (ask: LoopAsk) => Promise<LoopReply> {
  const client = cfg.client ?? (claudeClient(cfg.apiKey) as unknown as ClaudeToolClient);
  const label = cfg.label ?? "ai/help";
  return async (ask) => {
    try {
      const res = await client.beta.messages.create(
        {
          model: cfg.model,
          max_tokens: CLAUDE_TOOLS_MAX_TOKENS,
          system: cfg.system,
          output_config: { effort: "low" },
          tools: ask.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema, strict: true })),
          tool_choice: { type: "auto" },
          betas: [FALLBACK_BETA],
          fallbacks: "default",
          messages: toolMessages(cfg.user, ask.steps),
        },
        { timeout: ask.timeoutMs, maxRetries: 0 },
      );
      return {
        stop: stopOf(res.stop_reason),
        text: res.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim(),
        calls: res.content.flatMap((b) => (b.type === "tool_use" ? [{ id: b.id, name: b.name, input: b.input }] : [])),
        raw: res.content,
        usage: res.usage ? { inputTokens: res.usage.input_tokens ?? 0, outputTokens: res.usage.output_tokens ?? 0 } : undefined,
      };
    } catch (err) {
      const r = errorResult(err, ask.timeoutMs, cfg.model);
      console.error(`[${label}] Claude tool call failed — ${r.code}: ${r.reason}`);
      throw new Error(`claude ${r.code}`);
    }
  };
}
