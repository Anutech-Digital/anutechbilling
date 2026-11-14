/**
 * AI Help data tools (R-421, 7 Oct 2026).
 *
 * Pardeep asked AI Help on /leads "kitne subscription chal rahe hai" and got "go to Billing →
 * Subscriptions". The model only had a prompt and a page path — it could not read a number.
 * These are the READ-ONLY questions it may now ask the app, Gemini-JSON style (the help route
 * uses geminiJson with responseMimeType application/json, which does not combine with native
 * function calling): the first answer may be `{"tools": [...]}`, the route runs them and asks
 * again with the results.
 *
 * Three rules, each tested:
 *   1. Every read uses the PERSON's Supabase client (RLS) and an explicit tenant_id filter —
 *      never the admin client — so another company's rows cannot appear.
 *   2. A tool runs only when the person's role may open the page the number comes from
 *      (`canOpenRoute`, the same rule the menu and middleware use). Otherwise the result is
 *      "not allowed for your role" and nothing is read. Unknown role = not allowed.
 *   3. Numbers are computed by the SAME helpers the pages use (subscriptionSummary /
 *      folderOf, invoiceIsOverdue / invoiceBalance), and money is formatted by `rupee`
 *      (₹ with lakh/crore grouping), so the chat and the screen cannot disagree.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import type { HelpAction, HelpAnswer } from "@/lib/ai/app-help";
import { isUserRole } from "@/lib/auth/roles";
import { canOpenRoute } from "@/lib/nav";
import { DATA_TOOLS } from "@/lib/ai/help-tools/data-tools";
import { scopedReader } from "@/lib/ai/help-tools/reader";
import { runHelpTools } from "@/lib/ai/help-tools/runner";
import type { HelpSession } from "@/lib/ai/help-tools/session";
import type { HelpSourceRef } from "@/lib/ai/help-tools/types";

type Client = SupabaseClient<Database>;
type OpenAction = Extract<HelpAction, { kind: "open" }>;

export const HELP_DATA_TOOL_NAMES = [
  "active_subscriptions",
  "renewals_due",
  "overdue_invoices",
  "todays_followups",
  "open_quotes",
  "leads_by_stage",
] as const;
export type HelpDataToolName = (typeof HELP_DATA_TOOL_NAMES)[number];

/** At most this many tools per question — one question rarely needs more. */
export const HELP_TOOLS_MAX = 3;

export const NOT_ALLOWED = "not allowed for your role";

export interface HelpToolResult {
  tool: HelpDataToolName;
  ok: boolean;
  /** One short factual line (plus a short list for some tools), English, for the model. */
  text: string;
  /** The page that lists exactly these rows — becomes the answer's link button. */
  href: string | null;
  label: string | null;
  /** R-2774: where the facts came from (HELP_AI_V2 path only; H-04 shows them). */
  sources?: HelpSourceRef[];
}

/**
 * R-2774: the six tools now live in lib/ai/help-tools (registry contract: tenant-scoped reader,
 * no secret columns, typed output). This path keeps its R-421 role rule (any role that may open
 * the page) and its text, unchanged.
 */
const TOOLS = Object.fromEntries(DATA_TOOLS.map((t) => [t.name, t])) as Record<HelpDataToolName, (typeof DATA_TOOLS)[number]>;

/**
 * May this role read this tool? The same answer as "may this role open the page the number is
 * on". Fail-closed: no role, or a role this app does not know, may read nothing.
 */
export function helpToolAllowed(role: string | null | undefined, tool: HelpDataToolName): boolean {
  if (!isUserRole(role)) return false;
  return canOpenRoute(role, TOOLS[tool].page);
}

/** The model's tool request: known names only, no repeats, at most HELP_TOOLS_MAX. */
export function parseToolRequest(raw: unknown): HelpDataToolName[] {
  if (!raw || typeof raw !== "object") return [];
  const list = (raw as Record<string, unknown>).tools;
  if (!Array.isArray(list)) return [];
  const out: HelpDataToolName[] = [];
  for (const t of list) {
    if (typeof t !== "string") continue;
    const name = t.trim() as HelpDataToolName;
    if (!(HELP_DATA_TOOL_NAMES as readonly string[]).includes(name) || out.includes(name)) continue;
    out.push(name);
    if (out.length >= HELP_TOOLS_MAX) break;
  }
  return out;
}

/** Run the requested tools with the person's own client. Never throws. */
export async function runHelpDataTools(
  client: Client,
  ctx: { tenantId: string; role: string | null | undefined; now?: Date },
  names: readonly HelpDataToolName[],
): Promise<HelpToolResult[]> {
  const now = ctx.now ?? new Date();
  return Promise.all(names.slice(0, HELP_TOOLS_MAX).map(async (tool): Promise<HelpToolResult> => {
    const def = TOOLS[tool];
    if (!helpToolAllowed(ctx.role, tool)) return { tool, ok: false, text: `${tool}: ${NOT_ALLOWED}.`, href: null, label: null };
    try {
      const db = scopedReader(client, ctx.tenantId);
      const role = ctx.role as Parameters<typeof def.run>[1]["role"];
      const out = await def.run({}, { db, tenantId: ctx.tenantId, role, now });
      return { tool, ok: true, text: out.text, href: def.page, label: def.label };
    } catch (err) {
      console.error(`[ai/help] tool ${tool} failed:`, (err as Error)?.message);
      return { tool, ok: false, text: `${tool}: could not be read just now — try again in a minute.`, href: null, label: null };
    }
  }));
}

/**
 * R-2774 — HELP_AI_V2 (owner): the same tools through the registry runner — only the person's own
 * session (openHelpSession), registry role/tier/input/output rules, source refs on each result.
 * Same result shape as runHelpDataTools, so the R-421 prompt and links work unchanged.
 */
export async function runHelpDataToolsV2(
  session: HelpSession,
  ctx: { tenantId: string; role: string | null | undefined; now?: Date },
  names: readonly HelpDataToolName[],
): Promise<HelpToolResult[]> {
  const list = names.slice(0, HELP_TOOLS_MAX);
  const res = await runHelpTools(session, ctx, list.map((name) => ({ name, input: {} })));
  return res.map((r, i) => ({
    tool: list[i],
    ok: r.ok,
    text: r.refusal === "not_allowed" ? `${list[i]}: ${NOT_ALLOWED}.` : r.text,
    href: r.href,
    label: r.label,
    sources: r.sources,
  }));
}

/** The tool list for the system prompt (first pass, chat mode only). */
export function helpDataToolsPrompt(): string {
  return [
    "DATA TOOLS (R-421): you cannot see this company's live numbers unless you ask. When the person asks HOW MANY / HOW MUCH / WHICH about their own business data (e.g. 'kitne subscription chal rahe hai', 'kitna paisa overdue hai', 'aaj kiske follow-up hai', 'kitne quote khule hai'), do NOT tell them to go to a page and do NOT guess a number. Answer ONLY {\"tools\": [\"<name>\", ...]} (instead of the reply JSON below) with 1-3 names from this list; the app reads the numbers with their own login and asks you again with the results:",
    ...HELP_DATA_TOOL_NAMES.map((n) => `- ${n}: ${TOOLS[n].describe}`),
    "For how-to questions (where to click, what a field means) answer normally as described above and leave tools out.",
  ].join("\n");
}

/** The second-pass rule: answer from the results, number first. */
export const HELP_TOOL_RESULTS_RULE =
  "DATA TOOL RESULTS are in the message: live numbers just read with the person's own login. Answer from them ONLY: the number first, then at most one short line. Do not ask for tools again and do not send them to a page instead of the number. If a result says '" + NOT_ALLOWED + "', say plainly that their role cannot see that number. Copy ₹ amounts exactly as written (Indian grouping). Add one action {\"kind\":\"open\"} to the link given with each result.";

/** The results as one block for the model's user turn. */
export function toolResultsForPrompt(results: readonly HelpToolResult[]): string {
  return results.map((r) => `[${r.tool}]${r.href ? ` (link: ${r.href})` : ""}\n${r.text}`).join("\n\n");
}

/** The link buttons for these results — open actions to the page each number came from. */
export function toolActions(results: readonly HelpToolResult[]): OpenAction[] {
  const out: OpenAction[] = [];
  for (const r of results) if (r.ok && r.href && r.label) out.push({ kind: "open", label: r.label, href: r.href });
  return out;
}

/**
 * Make sure the answer carries the link to each number's page (the model is asked to add it,
 * this guarantees it), deduped by href, at most 3 actions in all.
 */
export function withToolLinks(answer: HelpAnswer, results: readonly HelpToolResult[]): HelpAnswer {
  const actions = [...answer.actions];
  for (const a of toolActions(results)) {
    if (actions.some((x) => x.kind === "open" && x.href.split(/[?#]/)[0] === a.href.split(/[?#]/)[0])) continue;
    actions.unshift(a);
  }
  return { ...answer, actions: actions.slice(0, 3) };
}

/** When the second model call fails, the numbers still reach the person — plainly. */
export function toolFallbackAnswer(results: readonly HelpToolResult[]): HelpAnswer {
  return {
    reply: results.map((r) => r.text).join("\n"),
    bugDraft: null,
    checklist: [],
    actions: toolActions(results).slice(0, 3),
    followUps: [],
  };
}
