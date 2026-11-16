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
import { runHelpTools, runOneTool, HELP_NOT_ALLOWED, HELP_RATE_LIMITED, type HelpCallInfo } from "@/lib/ai/help-tools/runner";
import type { HelpSession } from "@/lib/ai/help-tools/session";
import type { HelpSourceRef } from "@/lib/ai/help-tools/types";
import { helpToolRateOk } from "@/lib/ai/help-tools/limits";
import { wrapUntrusted, newUntrustedId, cleanHelpBlock, HELP_UNTRUSTED_RULE } from "@/lib/ai/help-tools/untrusted";

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

export const NOT_ALLOWED = HELP_NOT_ALLOWED;

/** The legacy path never had a per-tool timeout; this one only stops a read that hangs. */
const LEGACY_TIMEOUT_MS = 60_000;

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
 * the page) and its text, unchanged. The name list above is FROZEN to the R-421 six (test): a new
 * tool goes only on the registry path, so its `roles` always apply.
 */
/* R-2882 round 3: a Map, not an object read by a computed key — `get` answers only a real tool name. */
const TOOLS = new Map<HelpDataToolName, (typeof DATA_TOOLS)[number]>();
for (const n of HELP_DATA_TOOL_NAMES) {
  const def = DATA_TOOLS.find((t) => t.name === n);
  if (!def) throw new Error(`help-data-tools: ${n} is not in lib/ai/help-tools/data-tools.ts`);
  TOOLS.set(n, def);
}
function toolDef(tool: HelpDataToolName): (typeof DATA_TOOLS)[number] {
  const def = TOOLS.get(tool);
  if (!def) throw new Error(`help-data-tools: unknown tool ${String(tool)}`);
  return def;
}
/** The tool name a result carries, taken from OUR list (never cast from text). */
function toolNameOf(name: string): HelpDataToolName {
  for (const n of HELP_DATA_TOOL_NAMES) if (n === name) return n;
  throw new Error(`help-data-tools: unknown tool ${name}`);
}

/**
 * May this role read this tool? The same answer as "may this role open the page the number is
 * on". Fail-closed: no role, or a role this app does not know, may read nothing.
 */
export function helpToolAllowed(role: string | null | undefined, tool: HelpDataToolName): boolean {
  if (!isUserRole(role)) return false;
  return canOpenRoute(role, toolDef(tool).page);
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

/**
 * Run the requested tools with the person's own client. Never throws.
 * R-2879: `userId` (the signed-in person, from the route's session) counts EVERY call — also one
 * refused for the role — against the same per-person tool limit as the registry path; over it, or
 * with no user id, nothing is read.
 */
export async function runHelpDataTools(
  client: Client,
  ctx: { userId: string; tenantId: string; role: string | null | undefined; now?: Date },
  names: readonly HelpDataToolName[],
): Promise<HelpToolResult[]> {
  const now = ctx.now ?? new Date();
  return Promise.all(names.slice(0, HELP_TOOLS_MAX).map(async (tool): Promise<HelpToolResult> => {
    const def = toolDef(tool);
    if (!helpToolRateOk(ctx.userId)) return { tool, ok: false, text: `${tool}: ${HELP_RATE_LIMITED}.`, href: null, label: null };
    if (!helpToolAllowed(ctx.role, tool)) return { tool, ok: false, text: `${tool}: ${NOT_ALLOWED}.`, href: null, label: null };
    if (!isUserRole(ctx.role)) return { tool, ok: false, text: `${tool}: ${NOT_ALLOWED}.`, href: null, label: null };
    /* R-2774: same checked runner as the registry path (tenant-scoped reader, strict input,
       output shape) — only the role rule above is R-421's. */
    const r = await runOneTool(def as unknown as Parameters<typeof runOneTool>[0], {}, { client, tenantId: ctx.tenantId, role: ctx.role, now, timeoutMs: LEGACY_TIMEOUT_MS });
    return { tool, ok: r.ok, text: r.text, href: r.href, label: r.label };
  }));
}

/**
 * R-2774 — HELP_AI_V2 (owner): the same tools through the registry runner — only the person's own
 * session (openHelpSession), registry role/tier/input/output rules, source refs on each result.
 * Same result shape as runHelpDataTools, so the R-421 prompt and links work unchanged.
 */
export async function runHelpDataToolsV2(
  session: HelpSession,
  ctx: { userId: string; tenantId: string; role: string | null | undefined; now?: Date },
  names: readonly HelpDataToolName[],
  /** R-2778: hears every call (name, tier, outcome, ms) — the assistant log. */
  onCall?: (info: HelpCallInfo) => void,
): Promise<HelpToolResult[]> {
  const list = names.slice(0, HELP_TOOLS_MAX);
  const res = await runHelpTools(session, { ...ctx, onCall }, list.map((name) => ({ name, input: {} })));
  return res.map((r) => ({
    tool: toolNameOf(r.name),
    ok: r.ok,
    text: r.text,
    href: r.href,
    label: r.label,
    sources: r.sources,
  }));
}

/** The tool list for the system prompt (first pass, chat mode only). */
export function helpDataToolsPrompt(): string {
  return [
    "DATA TOOLS (R-421): you cannot see this company's live numbers unless you ask. When the person asks HOW MANY / HOW MUCH / WHICH about their own business data (e.g. 'kitne subscription chal rahe hai', 'kitna paisa overdue hai', 'aaj kiske follow-up hai', 'kitne quote khule hai'), do NOT tell them to go to a page and do NOT guess a number. Answer ONLY {\"tools\": [\"<name>\", ...]} (instead of the reply JSON below) with 1-3 names from this list; the app reads the numbers with their own login and asks you again with the results:",
    ...HELP_DATA_TOOL_NAMES.map((n) => `- ${n}: ${toolDef(n).describe}`),
    "For how-to questions (where to click, what a field means) answer normally as described above and leave tools out.",
  ].join("\n");
}

/** The second-pass rule: answer from the results, number first. */
export const HELP_TOOL_RESULTS_RULE =
  "DATA TOOL RESULTS are in the message: live numbers just read with the person's own login. Answer from them ONLY: the number first, then at most one short line. Do not ask for tools again and do not send them to a page instead of the number. If a result says '" + NOT_ALLOWED + "', say plainly that their role cannot see that number. Copy ₹ amounts exactly as written (Indian grouping). Add one action {\"kind\":\"open\"} to the link given with each result. " + HELP_UNTRUSTED_RULE;

/** The route's user turn keeps at most 4,000 characters of tool results (helpUserTurn) — the block must fit whole. */
export const HELP_TOOL_RESULTS_MAX = 3900;

/**
 * The results as one block for the model's user turn — both paths (R-421 and HELP_AI_V2).
 * R-2879 (L6): per result, the app's own line (`[tool] (link: …)`) stays OUTSIDE and the tool's
 * text — which can hold names and notes typed by anyone — goes INSIDE the UNTRUSTED DATA markers
 * (one one-time id for the request, body cleaned so it cannot hold a marker). A refusal ("not
 * allowed for your role") is the app's own sentence and stays outside too. Everything is cut to
 * fit HELP_TOOL_RESULTS_MAX with every end marker kept: each text gets an equal share, and if
 * there are far too many results, whole results are dropped from the end. HELP_TOOL_RESULTS_RULE
 * tells the model that what is inside the markers is data, never instructions.
 */
export function toolResultsForPrompt(results: readonly HelpToolResult[]): string {
  const id = newUntrustedId();
  const head = (r: HelpToolResult) => `[${r.tool}]${r.ok && r.href ? ` (link: ${r.href})` : ""}`;
  const refusal = (r: HelpToolResult) => `${head(r)} ${cleanHelpBlock(r.text, 300).replace(/\n/g, " ")}`;
  const fixed = results.reduce((n, r) => n + (r.ok ? head(r).length + 3 : refusal(r).length + 2), 0);
  const okCount = results.filter((r) => r.ok).length;
  const share = Math.floor((HELP_TOOL_RESULTS_MAX - fixed) / Math.max(1, okCount));
  const parts = results.map((r) => (r.ok ? `${head(r)}\n${wrapUntrusted(r.text, { max: share, nonce: id })}` : refusal(r)));
  while (parts.length > 1 && parts.join("\n\n").length > HELP_TOOL_RESULTS_MAX) parts.pop();
  return parts.join("\n\n");
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
