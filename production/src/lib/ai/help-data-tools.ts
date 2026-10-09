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
import { drillHref } from "@/lib/navigation/drilldown";
import { fetchAllRows } from "@/lib/ops/fetch-all";
import { istToday } from "@/lib/dates/ist";
import { subscriptionSummary } from "@/lib/company/summary";
import { folderOf, daysToRenewal } from "@/lib/subscriptions/folders";
import { invoiceIsOverdue } from "@/lib/invoices/overdue";
import { invoiceBalance } from "@/lib/invoices/kpis";
import { rupee, num, formatDate } from "@/lib/utils";

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
}

interface ToolCtx { tenantId: string; now: Date }

interface ToolDef {
  /** What the model reads in the tool list. */
  describe: string;
  /** The page this number belongs to: the role must be able to open it, and the link goes here. */
  href: string;
  label: string;
  run: (c: Client, ctx: ToolCtx) => Promise<string>;
}

/** Lead stages that are still being worked (lead_stage enum minus won/lost). */
const LEAD_STAGES = ["new", "contact", "demo", "trial", "quote", "won", "lost"] as const;
/** Quote statuses that still wait on the customer (quote_status enum). */
const OPEN_QUOTE_STATUSES = ["draft", "sent", "viewed"] as const;

function plural(n: number, one: string, many: string): string {
  return `${num(n)} ${n === 1 ? one : many}`;
}

const TOOLS: Record<HelpDataToolName, ToolDef> = {
  active_subscriptions: {
    describe: "active subscriptions right now: count and MRR (monthly recurring revenue, ₹)",
    href: drillHref("subsActive"),
    label: "Open active subscriptions",
    async run(c, { tenantId, now }) {
      const rows = await fetchAllRows<{ status: string | null; renewal_date: string | null; mrr: number | null }>((from, to) =>
        c.from("subscriptions").select("status, renewal_date, mrr").eq("tenant_id", tenantId)
          .order("id", { ascending: true }).range(from, to));
      const s = subscriptionSummary(rows, now);
      return `Active subscriptions: ${num(s.activeCount)}. MRR: ${rupee(s.mrr)} a month.`;
    },
  },
  renewals_due: {
    describe: "renewals due in the next 30 days (incl. ones already past their date and not renewed): count and the next 5",
    href: drillHref("subsExpiring"),
    label: "Open renewals due",
    async run(c, { tenantId, now }) {
      const today = istToday(now);
      const rows = await fetchAllRows<{ customer_name: string | null; plan: string | null; status: string | null; renewal_date: string | null }>((from, to) =>
        c.from("subscriptions").select("customer_name, plan, status, renewal_date").eq("tenant_id", tenantId)
          .order("renewal_date", { ascending: true }).order("id", { ascending: true }).range(from, to));
      const due = rows.filter((r) => folderOf(r, today) === "expiring");
      const lapsed = due.filter((r) => (daysToRenewal(r.renewal_date, today) ?? 0) < 0).length;
      const lines = [`Renewals due in the next 30 days: ${num(due.length)}${lapsed ? ` (${num(lapsed)} already past the renewal date)` : ""}.`];
      for (const r of due.slice(0, 5)) {
        const d = daysToRenewal(r.renewal_date, today) ?? 0;
        const when = d < 0 ? `${-d} days late` : d === 0 ? "today" : `in ${d} days`;
        lines.push(`- ${r.customer_name || "Unnamed customer"} — ${r.plan || "plan not set"} — ${formatDate(r.renewal_date)} (${when})`);
      }
      return lines.join("\n");
    },
  },
  overdue_invoices: {
    describe: "overdue invoices: count and total still owed (₹)",
    href: drillHref("invoicesOverdue"),
    label: "Open overdue invoices",
    async run(c, { tenantId, now }) {
      const today = istToday(now);
      const rows = await fetchAllRows<{ status: string; due_date: string | null; amount: number; net_payable: number | null; paid_amount: number | null }>((from, to) =>
        c.from("invoices").select("status, due_date, amount, net_payable, paid_amount").eq("tenant_id", tenantId)
          .in("status", ["pending", "overdue"]).order("id", { ascending: true }).range(from, to));
      const overdue = rows.filter((r) => invoiceIsOverdue(r, today));
      const owed = overdue.reduce((s, r) => s + invoiceBalance(r), 0);
      return `Overdue invoices: ${num(overdue.length)}. Still owed on them: ${rupee(owed)}.`;
    },
  },
  todays_followups: {
    describe: "lead follow-ups due today (and how many are already overdue), with the first 5 company names",
    href: drillHref("leadsToday"),
    label: "Open today's follow-ups",
    async run(c, { tenantId, now }) {
      const today = istToday(now);
      const open = () => c.from("leads").select("id", { count: "exact", head: true })
        .eq("tenant_id", tenantId).eq("is_junk", false).not("stage", "in", "(won,lost)");
      const [due, late, top] = await Promise.all([
        open().eq("follow_up_date", today),
        open().lt("follow_up_date", today),
        c.from("leads").select("company").eq("tenant_id", tenantId).eq("is_junk", false)
          .not("stage", "in", "(won,lost)").eq("follow_up_date", today)
          .order("value", { ascending: false, nullsFirst: false }).limit(5),
      ]);
      for (const r of [due, late, top]) if (r.error) throw r.error;
      const lines = [`Follow-ups due today: ${num(due.count ?? 0)}. Already overdue (earlier dates): ${num(late.count ?? 0)}.`];
      for (const l of (top.data ?? []) as { company: string | null }[]) lines.push(`- ${l.company || "Unnamed lead"}`);
      return lines.join("\n");
    },
  },
  open_quotes: {
    describe: "open quotes (draft, sent or viewed, not yet invoiced): count and total value (₹)",
    href: "/quotes",
    label: "Open Quotes",
    async run(c, { tenantId }) {
      const rows = await fetchAllRows<{ status: string; amount: number | null }>((from, to) =>
        c.from("quotes").select("status, amount").eq("tenant_id", tenantId)
          .in("status", [...OPEN_QUOTE_STATUSES]).is("invoice_id", null)
          .order("id", { ascending: true }).range(from, to));
      const value = rows.reduce((s, r) => s + (r.amount ?? 0), 0);
      const byStatus = OPEN_QUOTE_STATUSES.map((st) => `${st} ${num(rows.filter((r) => r.status === st).length)}`).join(", ");
      return `Open quotes: ${num(rows.length)} (${byStatus}). Total value: ${rupee(value)}.`;
    },
  },
  leads_by_stage: {
    describe: "leads by pipeline stage (new, contact, demo, trial, quote, won, lost), junk left out",
    href: drillHref("leadsActive"),
    label: "Open Sales & Pipeline",
    async run(c, { tenantId }) {
      const counts = await Promise.all(LEAD_STAGES.map(async (stage) => {
        const r = await c.from("leads").select("id", { count: "exact", head: true })
          .eq("tenant_id", tenantId).eq("is_junk", false).eq("stage", stage);
        if (r.error) throw r.error;
        return [stage, r.count ?? 0] as const;
      }));
      const open = counts.filter(([s]) => s !== "won" && s !== "lost").reduce((n, [, k]) => n + k, 0);
      return `Open leads: ${plural(open, "lead", "leads")}. By stage: ${counts.map(([s, k]) => `${s} ${num(k)}`).join(", ")}.`;
    },
  },
};

/**
 * May this role read this tool? The same answer as "may this role open the page the number is
 * on". Fail-closed: no role, or a role this app does not know, may read nothing.
 */
export function helpToolAllowed(role: string | null | undefined, tool: HelpDataToolName): boolean {
  if (!isUserRole(role)) return false;
  return canOpenRoute(role, TOOLS[tool].href);
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
      return { tool, ok: true, text: await def.run(client, { tenantId: ctx.tenantId, now }), href: def.href, label: def.label };
    } catch (err) {
      console.error(`[ai/help] tool ${tool} failed:`, (err as Error)?.message);
      return { tool, ok: false, text: `${tool}: could not be read just now — try again in a minute.`, href: null, label: null };
    }
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
