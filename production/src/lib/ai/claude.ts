/**
 * R-1759 — Claude (Anthropic) as the second AI provider, behind the same `geminiJson` door.
 *
 * Why it exists (Pardeep, staging 22 Oct 2026): Gemini answered 429 "billing account has
 * exceeded its monthly spending cap" and every AI feature stopped — reading a bill PDF in
 * Expenses included. The cap could not be raised that day. So the server can now run on
 * Claude, and switch back to Gemini later by config alone:
 *
 *   AI_PROVIDER        "claude" | "gemini". Unset → whichever key exists (both → gemini,
 *                      which keeps the behaviour from before this card).
 *   ANTHROPIC_API_KEY  server key (Cloud Run secret). There is no per-workspace Claude key.
 *   ANTHROPIC_MODEL    default "claude-opus-5-5".
 *
 * The workspace's own Gemini key (Settings → Integrations → AI) applies only when the
 * provider is Gemini.
 *
 * Callers do not change: `resolveGeminiConfig` hands them the chosen provider's key and model,
 * and `geminiJson` sees which provider a key belongs to (it equals ANTHROPIC_API_KEY → Claude).
 *
 * Rules for claude-opus-5-5 (from the Claude API docs): never send `thinking` (thinking is
 * always on; `disabled` is a 400) and never `temperature` / `top_p` (400); depth is
 * `output_config.effort`, set to "low" — these are short extraction / draft calls. No
 * assistant prefill: JSON is asked for in words and parsed out of the reply.
 */
import Anthropic, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  AuthenticationError,
  InternalServerError,
  PermissionDeniedError,
  RateLimitError,
} from "@anthropic-ai/sdk";

export type AiProvider = "claude" | "gemini";

export const DEFAULT_CLAUDE_MODEL = "claude-opus-5-5";

/** Text calls get 30s, calls with a file 60s — Claude thinks before it answers, so 15s (Gemini) is too short. */
const CLAUDE_TEXT_TIMEOUT_MS = 30_000;
const CLAUDE_FILE_TIMEOUT_MS = 60_000;

function validKey(key: string | null | undefined): string | null {
  const k = key?.trim();
  if (!k || k === "..." || k.length < 10) return null;
  return k;
}

/** The server's Anthropic key, or null. */
export function anthropicEnvKey(): string | null {
  return validKey(process.env.ANTHROPIC_API_KEY);
}

export function anthropicModel(): string {
  return process.env.ANTHROPIC_MODEL?.trim() || DEFAULT_CLAUDE_MODEL;
}

/** True when this key is the server's Anthropic key — that is how geminiJson knows to call Claude. */
export function isClaudeKey(apiKey: string | null | undefined): boolean {
  const k = anthropicEnvKey();
  return Boolean(k && apiKey && apiKey.trim() === k);
}

/**
 * Which AI runs. `choice` is AI_PROVIDER; a chosen provider without a key gives way to the one
 * that has a key (better than switching AI off), and an unknown value counts as unset.
 */
export function resolveAiProvider(s: { choice: string | null | undefined; hasGemini: boolean; hasClaude: boolean }): AiProvider | null {
  const choice = s.choice?.trim().toLowerCase();
  if (choice === "claude" && s.hasClaude) return "claude";
  if (choice === "gemini" && s.hasGemini) return "gemini";
  if (s.hasGemini) return "gemini";
  if (s.hasClaude) return "claude";
  return null;
}

// ─── Breaker — Claude's own, so a Gemini outage never pauses Claude and vice versa ───
const BREAKER_THRESHOLD = 3;
const BREAKER_COOLDOWN_MS = 60_000;
const breaker = { failures: 0, openedAt: 0 };

function breakerOpen(now: number): boolean {
  if (breaker.failures < BREAKER_THRESHOLD) return false;
  if (now - breaker.openedAt < BREAKER_COOLDOWN_MS) return true;
  breaker.failures = 0;
  return false;
}
function recordFailure(now: number) {
  breaker.failures += 1;
  if (breaker.failures >= BREAKER_THRESHOLD) breaker.openedAt = now;
}

/** Test-only. */
export function __resetClaudeBreaker() {
  breaker.failures = 0;
  breaker.openedAt = 0;
}

const clients = new Map<string, Anthropic>();
function clientFor(apiKey: string): Anthropic {
  let c = clients.get(apiKey);
  if (!c) {
    c = new Anthropic({ apiKey, maxRetries: 1 });
    clients.set(apiKey, c);
  }
  return c;
}

/** Result of one Claude call. `switchable` = the other provider is worth one try (auth / credit / rate limit / overloaded). */
export type ClaudeResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string; switchable: boolean; code: string };

type Attachment = { mimeType: string; base64: string };

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

function blockFor(a: Attachment): Anthropic.ContentBlockParam | null {
  const mt = a.mimeType.toLowerCase().replace("image/jpg", "image/jpeg");
  if (mt === "application/pdf") {
    return { type: "document", source: { type: "base64", media_type: "application/pdf", data: a.base64 } };
  }
  if (IMAGE_TYPES.has(mt)) {
    return { type: "image", source: { type: "base64", media_type: mt as "image/jpeg" | "image/png" | "image/gif" | "image/webp", data: a.base64 } };
  }
  return null;
}

/**
 * JSON out of a text reply: strip ``` fences, then try the whole thing, then the outermost
 * {...} or [...]. Returns undefined when nothing parses.
 */
export function parseJsonReply(raw: string): unknown {
  const cleaned = raw.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, "").trim();
  try { return JSON.parse(cleaned); } catch { /* look inside */ }
  for (const [open, close] of [["{", "}"], ["[", "]"]] as const) {
    const start = cleaned.indexOf(open);
    const end = cleaned.lastIndexOf(close);
    if (start >= 0 && end > start) {
      try { return JSON.parse(cleaned.slice(start, end + 1)); } catch { /* next */ }
    }
  }
  return undefined;
}

const JSON_ONLY = "\n\nReply with only the JSON value asked for above — no other words, no Markdown code fences.";

function errorResult(err: unknown, timeoutMs: number, model: string): { reason: string; switchable: boolean; code: string } {
  // Most specific first: APIConnectionTimeoutError extends APIConnectionError extends APIError.
  if (err instanceof APIConnectionTimeoutError) {
    return { reason: `Claude timed out after ${Math.round(timeoutMs / 1000)} seconds. Please try again in a little while.`, switchable: false, code: "timeout" };
  }
  if (err instanceof APIConnectionError) {
    return { reason: `Could not reach Claude — ${err.message || "network error"}.`, switchable: false, code: "network" };
  }
  if (err instanceof AuthenticationError) {
    return { reason: "Claude API key was refused (401). Check ANTHROPIC_API_KEY on the server.", switchable: true, code: "401" };
  }
  if (err instanceof PermissionDeniedError) {
    return { reason: "Claude refused this API key's access (403). Check the key's organization and workspace in the Anthropic Console.", switchable: true, code: "403" };
  }
  if (err instanceof RateLimitError) {
    return { reason: "Claude is rate-limited / out of credit (429). Add credit in the Anthropic Console, or wait a minute.", switchable: true, code: "429" };
  }
  if (err instanceof InternalServerError) {
    if (err.status === 529) {
      return { reason: "Claude is overloaded (529). Nothing is misconfigured; it clears on its own.", switchable: true, code: "529" };
    }
    return { reason: `Claude is temporarily unavailable (${err.status}). Nothing is misconfigured; it clears on its own.`, switchable: true, code: String(err.status) };
  }
  if (err instanceof APIError) {
    if (err.status === 402) {
      return { reason: "Claude billing problem (402) — add credit in the Anthropic Console.", switchable: true, code: "402" };
    }
    if (err.status === 404) {
      return { reason: `Claude does not have the model "${model}" for this key (404). Check ANTHROPIC_MODEL.`, switchable: false, code: "404" };
    }
    const msg = (err.message ?? "").split(/\r?\n/)[0].trim();
    return { reason: `Claude rejected the request (${err.status ?? "error"})${msg ? ` — ${msg}` : ""}.`, switchable: false, code: String(err.status ?? "error") };
  }
  return { reason: `Claude call failed — ${(err as Error)?.message || "no reason given"}.`, switchable: false, code: "error" };
}

/**
 * One Claude call that must come back as JSON. Never throws. The caller (geminiJson) decides
 * about falling back to Gemini and about calling onFailure.
 */
export async function claudeJson<T>(args: {
  apiKey: string;
  model: string;
  system?: string;
  user: string;
  attachment?: Attachment;
  attachments?: readonly Attachment[];
  timeoutMs?: number;
  label: string;
  /** R-1877: the tokens Claude reported for this call (billed even when the reply is unusable). */
  onUsage?: (u: { inputTokens: number; outputTokens: number }) => void;
}): Promise<ClaudeResult<T>> {
  const now = Date.now();
  if (breakerOpen(now)) {
    console.warn(`[${args.label}] Claude circuit breaker open`);
    return { ok: false, reason: "Claude failed repeatedly just now, so calls are paused for a minute. It retries on its own.", switchable: true, code: "breaker" };
  }

  /* A caller may pass a Gemini model name of its own (extract-statement's second try). On
     Claude that would be a 404, so anything that is not a Claude model becomes ANTHROPIC_MODEL. */
  const model = /^claude/i.test(args.model) ? args.model : anthropicModel();

  const files = [...(args.attachment ? [args.attachment] : []), ...(args.attachments ?? [])];
  const blocks: Anthropic.ContentBlockParam[] = [];
  for (const f of files) {
    const b = blockFor(f);
    if (!b) {
      return { ok: false, reason: `Claude cannot read this file type (${f.mimeType}). Use a PDF, JPG, PNG or WebP.`, switchable: true, code: "file-type" };
    }
    blocks.push(b);
  }
  const timeoutMs = Math.max(args.timeoutMs ?? 0, files.length ? CLAUDE_FILE_TIMEOUT_MS : CLAUDE_TEXT_TIMEOUT_MS);

  try {
    const res = await clientFor(args.apiKey).messages.create(
      {
        model,
        max_tokens: 16000,
        ...(args.system ? { system: args.system } : {}),
        output_config: { effort: "low" },
        // Files first, then the instruction text.
        messages: [{ role: "user", content: [...blocks, { type: "text", text: args.user + JSON_ONLY }] }],
      },
      { timeout: timeoutMs, maxRetries: 1 },
    );
    if (res.usage) args.onUsage?.({ inputTokens: res.usage.input_tokens ?? 0, outputTokens: res.usage.output_tokens ?? 0 });

    if (res.stop_reason === "refusal") {
      recordFailure(now);
      console.error(`[${args.label}] Claude refused`);
      return { ok: false, reason: "Claude declined to answer this request.", switchable: false, code: "refusal" };
    }
    if (res.stop_reason === "max_tokens") {
      recordFailure(now);
      console.error(`[${args.label}] Claude hit max_tokens`);
      return { ok: false, reason: "Claude's reply was cut off before it finished (too long).", switchable: false, code: "max_tokens" };
    }

    const raw = res.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
    if (!raw) {
      recordFailure(now);
      return { ok: false, reason: "Claude answered but the reply was empty.", switchable: false, code: "empty" };
    }
    const parsed = parseJsonReply(raw);
    if (parsed === undefined) {
      recordFailure(now);
      console.error(`[${args.label}] Claude reply was not JSON`);
      return { ok: false, reason: "Claude answered, but the reply was not valid JSON.", switchable: false, code: "bad-json" };
    }
    breaker.failures = 0;
    return { ok: true, value: parsed as T };
  } catch (err) {
    recordFailure(now);
    const r = errorResult(err, timeoutMs, model);
    console.error(`[${args.label}] Claude call failed — ${r.code}: ${r.reason}`);
    return { ok: false, ...r };
  }
}
