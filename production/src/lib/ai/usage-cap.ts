/**
 * R-1877 (24 Oct 2026) — per-company AI usage counter + monthly call cap.
 *
 * Every company shares the server's AI key (Claude: ANTHROPIC_API_KEY, lib/ai/claude.ts; or the
 * server's GEMINI_API_KEY). Pardeep (epic R-1874): "Claude, one server key + per-company monthly
 * cap". geminiJson / geminiGroundedText (lib/ai/gemini.ts) — the one door every AI call goes
 * through — call reserveAiCall BEFORE asking the provider, and recordAiTokens after.
 *
 *   - The count and the cap live in the database (migration 20261024220000_r1877_ai_usage_cap):
 *     ai_usage_reserve is atomic per company, so two calls racing at the last slot cannot both
 *     get through. The default cap lives ONLY in SQL ai_monthly_call_cap(); a company's own
 *     limit is a tenant_ai_limits row (platform-only — a company cannot raise its own cap).
 *   - Month = calendar month in India time (Asia/Kolkata), in SQL; istMonthStart mirrors it for
 *     the "resets on 1 Nov" line.
 *   - A company running on its OWN Gemini key (Settings → Integrations → AI) pays for it, so its
 *     calls are counted but never refused (enforce = false).
 *   - If the counter itself cannot be reached (DB blip, migration not applied yet) the call is
 *     ALLOWED and the error logged: a broken counter must not switch off bill reading and
 *     the sales agent for every company. Recorded as a decision on the card.
 *
 * Service role through a bare no-store client (same as lib/automation/gate.server.ts): the
 * functions are server-only, and the tables are not in the generated Database type.
 */
import "server-only";
import { createBareClient } from "@/lib/supabase/bare";

export interface AiCapState {
  used: number;
  cap: number;
  /** First day of the IST month, YYYY-MM-01. */
  month: string;
}

export type AiReserveResult =
  | ({ allowed: true } & AiCapState)
  | ({ allowed: false; message: string } & AiCapState);

export interface AiUsageSummary extends AiCapState {
  inputTokens: number;
  outputTokens: number;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const IST_OFFSET_MS = 330 * 60_000;

/** First day of the month in India time, as YYYY-MM-01 — the same month the SQL counts in. */
export function istMonthStart(now: Date = new Date()): string {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  return `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

/** "1 Nov" — the day the count starts again after `month` (YYYY-MM-01). */
export function resetDayLabel(month: string): string {
  const m = Number(month.slice(5, 7)); // 1..12; next month index = m % 12
  return `1 ${MONTHS[m % 12]}`;
}

/** What a person reads when the company's AI calls for this month are used up. */
export function aiCapMessage(s: AiCapState): string {
  return `Your company has used this month's AI limit (${s.used} of ${s.cap} AI calls). ` +
    `It starts again on ${resetDayLabel(s.month)}. To raise the limit, contact Anutech support.`;
}

/**
 * Settings → Integrations → AI. The card is narrow (a third of the row at 1280), so the line
 * is short — "12 / 1,000 AI calls this month" — and the full sentence goes on hover.
 */
export function aiUsageLine(s: AiCapState): { line: string; detail: string } {
  const n = (v: number) => v.toLocaleString("en-IN");
  const full = s.used >= s.cap ? " The limit is reached — AI features use their basic version until then." : "";
  return {
    line: `${n(s.used)} / ${n(s.cap)} AI calls this month`,
    detail: `Your company has used ${n(s.used)} of its ${n(s.cap)} AI calls this month. The count starts again on ${resetDayLabel(s.month)}.${full}`,
  };
}

function db() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) return null;
  return createBareClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (u, o) => fetch(u, { ...o, cache: "no-store" }) },
  });
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Count one AI call for this company, or refuse it when the month's cap is used up.
 * `enforce` = false when the company's own key pays (counted, never refused).
 * Never throws; a counter that cannot be reached allows the call (see the file comment).
 */
export async function reserveAiCall(tenantId: string, feature: string, enforce: boolean): Promise<AiReserveResult> {
  const open = (): AiReserveResult => ({ allowed: true, used: 0, cap: 0, month: istMonthStart() });
  try {
    const client = db();
    if (!client) {
      console.error(`[ai-cap] no service key — ${feature} not counted`);
      return open();
    }
    const { data, error } = await client.rpc("ai_usage_reserve", { p_tenant_id: tenantId, p_feature: feature, p_enforce: enforce });
    if (error || !data) {
      console.error(`[ai-cap] could not count ${feature} for ${tenantId} — allowing:`, error?.message ?? "no data");
      return open();
    }
    const d = data as { allowed?: boolean; used?: unknown; cap?: unknown; month?: unknown };
    const state: AiCapState = { used: num(d.used), cap: num(d.cap), month: String(d.month ?? istMonthStart()) };
    if (d.allowed === false) return { allowed: false, message: aiCapMessage(state), ...state };
    return { allowed: true, ...state };
  } catch (err) {
    console.error(`[ai-cap] could not count ${feature} for ${tenantId} — allowing:`, (err as Error)?.message);
    return open();
  }
}

/** Add the tokens the provider reported. Never throws, never blocks. */
export async function recordAiTokens(
  tenantId: string,
  feature: string,
  usage: { inputTokens: number; outputTokens: number },
): Promise<void> {
  const input = Math.max(0, Math.round(num(usage.inputTokens)));
  const output = Math.max(0, Math.round(num(usage.outputTokens)));
  if (!input && !output) return;
  try {
    const client = db();
    if (!client) return;
    const { error } = await client.rpc("ai_usage_add_tokens", { p_tenant_id: tenantId, p_feature: feature, p_input: input, p_output: output });
    if (error) console.error(`[ai-cap] could not add tokens for ${feature}:`, error.message);
  } catch (err) {
    console.error(`[ai-cap] could not add tokens for ${feature}:`, (err as Error)?.message);
  }
}

/** This month's usage for Settings → Integrations → AI. Null when it cannot be read. */
export async function aiUsageSummary(tenantId: string): Promise<AiUsageSummary | null> {
  try {
    const client = db();
    if (!client) return null;
    const { data, error } = await client.rpc("ai_usage_summary", { p_tenant_id: tenantId });
    if (error || !data) return null;
    const d = data as Record<string, unknown>;
    return {
      month: String(d.month ?? istMonthStart()),
      used: num(d.used),
      cap: num(d.cap),
      inputTokens: num(d.input_tokens),
      outputTokens: num(d.output_tokens),
    };
  } catch {
    return null;
  }
}
