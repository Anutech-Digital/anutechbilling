/**
 * AI Help — the in-app chat for people testing ResellerOS (R-158, 5 Oct 2026).
 *
 * Pardeep: "app ke testing karte koi confusion ho to AI chatbot se discuss karu, aur bug
 * mile to AI proper description bana kar Report a Bug mein us user ke naam se register kar
 * de — but AI ne create kiya after discussion, ye bhi mention ho."
 *
 * Pure functions only (prompt, parsing, the report text) so the rules are tested without a
 * model. The route (api/ai/help) calls Gemini with `responseMimeType: application/json`;
 * this file decides what a valid answer is and refuses anything else.
 *
 * What the model may do: explain, ask what happened, and — once it knows enough — propose a
 * bug report. What it may NOT do: file anything. The person sees the draft and presses
 * "File this report"; the row is written by the same insert as the Report Bug dialog, under
 * their name, marked filed_via 'ai-chat'. A report nobody looked at is worse than none.
 */
import type { FeedbackSeverity, FeedbackType } from "@/lib/feedback/triage";
import { GST_STATE_BY_CODE } from "@/lib/utils";

export interface HelpMessage { role: "user" | "assistant"; text: string }

export interface BugDraft {
  title: string;
  type: FeedbackType;
  severity: FeedbackSeverity;
  /** What happened, in the reporter's terms. */
  actual: string;
  /** What should have happened. */
  expected: string;
  /** Steps to see it again, in order. */
  steps: string[];
  /** Two or three lines on how the chat arrived at this report. */
  chatSummary: string;
}

/**
 * R-189 (Pardeep, 6 Oct: "AI help ko problem solve karne ki power do taki wo problem ko wahi
 * solve kar paye"). A fix the AI may OFFER — never run. The panel shows each as a button and
 * nothing happens until the person presses it; the write then goes through the person's own
 * login (RLS), exactly as if they had edited the field themselves. The list is closed on
 * purpose: opening a page, and filling a missing GST state. Nothing that moves money, sends a
 * message or deletes anything can be expressed here at all.
 */
export type HelpAction =
  | { kind: "open"; label: string; href: string }
  | { kind: "set_customer_state"; label: string; customerId: string; stateCode: string }
  | { kind: "set_company_state"; label: string; stateCode: string };

/** checklist (R-162): what to try next on this screen, from the page scan. */
export interface HelpAnswer { reply: string; bugDraft: BugDraft | null; checklist: string[]; actions: HelpAction[] }

/**
 * Why AI Help was asked (R-162). "chat" = the person typed; "scan" = they pressed "Check this
 * page" and the findings come with it; "error" = the app saw something break and they tapped
 * "Report it", so the trail IS the description.
 */
export type HelpMode = "chat" | "scan" | "error" | "check_failed";

export const HELP_MAX_MESSAGES = 20;
export const HELP_MAX_CHARS = 1500;

const TYPES: readonly FeedbackType[] = ["bug", "feature", "ui_improvement"];
const SEVERITIES: readonly FeedbackSeverity[] = ["low", "medium", "high", "critical"];

/** What the app is, in a few lines, so answers are about THIS app and not a generic CRM. */
const APP_FACTS = [
  "ResellerOS is Anutech Digital's own business app (Indian reseller of Google Workspace, Microsoft 365, Zoho, domains, hosting; also builds custom software).",
  "Main areas: Today/Dashboard; Sales & Pipeline (leads, deals Kanban, enquiries, tasks, quotes); Customers; Billing (invoices with GST, payments, renewals, subscriptions, online orders); Catalog (products, subscription catalogue, packages); Accounting (books, bank, advances, expenses); Employees & Team (staff, attendance, payroll, Academy for apprentices); Marketing Hub (campaigns, ads landing pages); Projects (custom software); Settings and Integrations (Razorpay, Gemini, email).",
  "Money rules: amounts in ₹, GST 18% (CGST+SGST inside the state, IGST outside), quotes become invoices on payment, renewals raise quotes before the renewal date.",
  "There is a 'Report Bug' button in the top bar (Ctrl+Shift+B). Reports go to Admin → Feedback, where an AI triages them.",
];

export function helpSystemPrompt(ctx: { pagePath: string | null; userName: string | null; role: string | null; mode?: HelpMode; pagePurpose?: string | null; testHistory?: string | null }): string {
  const mode = ctx.mode ?? "chat";
  return [
    "You are AI Help inside ResellerOS. The person is testing the app and may be confused or may have found a bug.",
    ...APP_FACTS,
    `They are on the page: ${ctx.pagePath || "unknown"}. Their role: ${ctx.role || "unknown"}. Name: ${ctx.userName || "unknown"}.`,
    ctx.pagePurpose
      ? `WHAT THIS PAGE IS FOR (trust this over guessing from the URL or the buttons): ${ctx.pagePurpose}`
      : "This page's purpose is not described — infer it from the outline, and say so if unsure.",
    "Reply in the language they write in (Hinglish if they write Hinglish), short and practical: what the screen is for, where to click, what a field means.",
    "Plain text only — the panel shows text as it is, so no markdown: no **bold**, no # headings, no backticks. Numbered steps as '1. ' lines are fine; put a button's name in quotes, like 'New Quote'.",
    "Never invent a feature, a setting or a menu that you are not sure exists — say you are not sure and suggest filing it as a question or a bug.",
    "When what they describe sounds like a BUG (something broken, wrong number, error, button that does nothing) or a clear improvement: if you do not yet know what they did, what happened and what they expected, ask for exactly that in one message. When you know enough, write a bugDraft.",
    "A bugDraft is written for the developer: a precise title (what is wrong, where), the actual result, the expected result, numbered steps to reproduce starting from the page, type (bug | feature | ui_improvement) and severity (critical = money/data/security wrong; high = a daily task blocked; medium = wrong but has a workaround; low = cosmetic). chatSummary: 2-3 short lines on how the chat found it.",
    "You may also receive WHAT THE APP RECORDED (the person's recent clicks, pages, errors and failed API calls, oldest first; lines starting !! are problems). Use it: write the steps to reproduce FROM that trail instead of asking the person what they did, and quote the exact error or failed call. Ask only what the trail cannot tell you (usually: what they expected).",
    mode === "scan"
      ? "MODE scan: the person pressed 'Check this page'. You get AUTOMATIC FINDINGS and the PAGE OUTLINE. In reply: a one-line verdict, then what is really wrong (drop findings that are harmless and say why in a few words). If a finding is a real bug, write a bugDraft for the most serious one. Always fill checklist with 4-7 short, concrete things to test next on THIS screen, taken from the outline (which button, which edge case: empty value, 0, a huge amount, another GST state, the back button, phone width)."
      : mode === "error"
        ? "MODE error: the app caught a problem (the last !! lines of the trail) and the person tapped 'Report it'. Write the bugDraft straight away from the trail — do not ask first; give your best guess of the expected result and say it is a guess. reply: one or two lines on what broke."
        : mode === "check_failed"
          ? "MODE check_failed: the person ran one of your suggested tests (quoted in their message) and pressed 'failed'. Write the bugDraft NOW — do not ask first: the title says what failed and where; expected = what the test said should happen; actual = that it did not, plus anything the trail shows (errors, failed calls); steps = the test itself, from this page. If something is unknown, write 'not recorded' rather than inventing it. reply: one line."
          : "MODE chat: answer the person. checklist may stay empty.",
    "You may get WORKSPACE FACTS: this company's own setup (company GST state, GSTIN set or not, address, bank/UPI) and customers missing a GST state. Use them to find the REAL cause before guessing — e.g. a GST/IGST question: check the company state and the customer's state first. Quote the fact you used.",
    "actions (R-189): up to 3 buttons the person can press to fix it right here. Allowed kinds ONLY: {\"kind\":\"open\",\"label\",\"href\"} to open an app page (href starts with /, e.g. /settings?tab=company, /customers/<id>/edit, /invoices); {\"kind\":\"set_customer_state\",\"label\",\"customerId\",\"stateCode\"} only for a customer listed in WORKSPACE FACTS as missing a state AND only when the person told you or the facts show which state it is (never guess a state); {\"kind\":\"set_company_state\",\"label\",\"stateCode\"} only when the facts say the company state is missing and you know it (e.g. from the company GSTIN code). stateCode = 2-digit GST code. label = what the button does, short (e.g. 'Set Acme's state to Delhi (07)'). Anything else (money, invoices, emails, deleting) — explain the steps instead; never offer it as an action. Empty list when there is nothing to fix.",
    "Do not say the report is filed — the person files it with a button after reading your draft. Say: 'Draft taiyaar hai — neeche dekh kar File karein.'",
    /* R-352: the page's last browser test run, so "Check this page" does not hand back tests
       that already passed. Absent when there is no run (or the table is not set up yet). */
    ...(ctx.testHistory
      ? [`PREVIOUS TESTS on this page (already run in a browser; the checklist must build on these, not repeat them):\n${ctx.testHistory}`]
      : []),
    'Answer ONLY as JSON: {"reply": string, "checklist": string[], "actions": [], "bugDraft": null | {"title": string, "type": string, "severity": string, "actual": string, "expected": string, "steps": string[], "chatSummary": string}}',
  ].join("\n");
}

/**
 * The chat as one user turn for the model: last HELP_MAX_MESSAGES, each capped — plus, when
 * the panel sent them (R-162), what the app recorded and what the page scan found.
 */
export function helpUserTurn(
  messages: readonly HelpMessage[],
  extra: { trail?: string | null; findings?: string | null; outline?: string | null; facts?: string | null } = {},
): string {
  const chat = messages
    .slice(-HELP_MAX_MESSAGES)
    .map((m) => `${m.role === "user" ? "PERSON" : "AI HELP"}: ${m.text.slice(0, HELP_MAX_CHARS)}`)
    .join("\n\n");
  const blocks = [chat];
  if (extra.trail) blocks.push(`WHAT THE APP RECORDED (oldest first):\n${extra.trail.slice(0, 6000)}`);
  if (extra.findings) blocks.push(`AUTOMATIC FINDINGS on this page:\n${extra.findings.slice(0, 5000)}`);
  if (extra.outline) blocks.push(`PAGE OUTLINE:\n${extra.outline.slice(0, 1500)}`);
  if (extra.facts) blocks.push(`WORKSPACE FACTS (this company's own setup, read just now):\n${extra.facts.slice(0, 3000)}`);
  return blocks.join("\n\n---\n\n");
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/**
 * Validate the model's JSON. A reply is required; a bugDraft is kept only when it is
 * complete — a half report (no title, no actual result) is dropped, never filed.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** An in-app path only: starts with one "/", no scheme, no "//" host, no backslash. */
const APP_PATH = /^\/(?!\/)[A-Za-z0-9\-._~/?=&%#]*$/;

/**
 * R-189: keep only actions this panel can safely offer. A set_customer_state must name a
 * customer the server listed as missing a state (allowedCustomerIds) — the model cannot
 * point the button at some other row — and every stateCode must be a real GST code.
 */
export function parseHelpActions(raw: unknown, allowedCustomerIds: ReadonlySet<string> = new Set()): HelpAction[] {
  if (!Array.isArray(raw)) return [];
  const out: HelpAction[] = [];
  for (const a of raw) {
    if (!a || typeof a !== "object") continue;
    const o = a as Record<string, unknown>;
    const label = str(o.label, 80);
    if (!label) continue;
    const code = str(o.stateCode, 2);
    const validCode = /^\d{2}$/.test(code) && Number(code) < 97 && !!GST_STATE_BY_CODE[code];
    if (o.kind === "open") {
      const href = str(o.href, 200);
      if (APP_PATH.test(href)) out.push({ kind: "open", label, href });
    } else if (o.kind === "set_customer_state") {
      const id = str(o.customerId, 36);
      if (UUID_RE.test(id) && allowedCustomerIds.has(id) && validCode) out.push({ kind: "set_customer_state", label, customerId: id, stateCode: code });
    } else if (o.kind === "set_company_state") {
      if (validCode) out.push({ kind: "set_company_state", label, stateCode: code });
    }
    if (out.length >= 3) break;
  }
  return out;
}

export function parseHelpAnswer(raw: unknown, allowedCustomerIds?: ReadonlySet<string>): HelpAnswer | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  // Belt and braces for the "no markdown" rule: the panel would show ** and # as they are.
  const reply = str(o.reply, 2000).replace(/\*\*(.+?)\*\*/g, "$1").replace(/^#{1,6}\s+/gm, "");
  if (!reply) return null;
  const checklist = Array.isArray(o.checklist) ? o.checklist.map((c) => str(c, 200)).filter(Boolean).slice(0, 8) : [];
  const d = o.bugDraft as Record<string, unknown> | null | undefined;
  const actions = parseHelpActions(o.actions, allowedCustomerIds);
  if (!d || typeof d !== "object") return { reply, bugDraft: null, checklist, actions };
  const title = str(d.title, 160);
  const actual = str(d.actual, 1200);
  if (!title || !actual) return { reply, bugDraft: null, checklist, actions };
  const type = TYPES.includes(d.type as FeedbackType) ? (d.type as FeedbackType) : "bug";
  const severity = SEVERITIES.includes(d.severity as FeedbackSeverity) ? (d.severity as FeedbackSeverity) : "medium";
  const steps = Array.isArray(d.steps) ? d.steps.map((s) => str(s, 300)).filter(Boolean).slice(0, 12) : [];
  return {
    reply,
    checklist,
    actions,
    bugDraft: { title, type, severity, actual, expected: str(d.expected, 1200), steps, chatSummary: str(d.chatSummary, 600) },
  };
}

/**
 * R-195 (Pardeep, 6 Oct: "text select karne par 'Ask with AI' aaye"). What a selection becomes
 * in AI Help's box: null when it is not worth a button (empty, one character, or a whole
 * page dragged over); otherwise the text, whitespace collapsed and capped, as a question.
 */
export function askAboutSelection(raw: string | null | undefined): string | null {
  const t = (raw ?? "").replace(/\s+/g, " ").trim();
  if (t.length < 2 || t.length > 600) return null;
  return `"${t.length > 300 ? t.slice(0, 300) + "…" : t}" — ye kya hai, aur ispar dhyan dene wali koi baat?`;
}

/**
 * R-196 (Pardeep, 6 Oct): "Run these tests in browser". AI Help must not click or submit on
 * the person's real login (live data), so the "Test next" list becomes a prompt for a NEW
 * Claude Code session, which runs each test in its own browser on the LOCAL app (test data)
 * and writes the result on the work board. Pure, so the rules are tested.
 */
export function buildTestRunPrompt(input: { pagePath: string; tests: readonly string[]; tenantId?: string | null }): string {
  const tests = input.tests.map((t) => t.replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 12);
  const tenantId = input.tenantId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.tenantId)
    ? input.tenantId
    : "<tenant uuid of Pardeep's workspace in the local DB>";
  const page = input.pagePath.split(/[?#]/)[0].replace(/"/g, "");
  return [
    `Is page ke tests browser me chalao aur nateeja do. (Ye prompt ek NAYE Claude Code session me chalana hai.)`,
    "",
    "CLOUD CHECK: ye kaam sirf Pardeep ke computer par chalne wale LOCAL session me ho sakta hai (localhost:3001 aur browser pane wahin hain). Agar tum cloud container me ho (path /home/user/..., localhost:3001 nahi khulta, ya browser pane nahi hai) to kuch mat karo — turant bolo: \"Ye cloud session hai — Claude app me naya session LOCAL chun kar chalaiye.\" Aur ruk jao.",
    "0. FOLDER: agar session kisi folder me nahi hai, to pehle change_directory se C:\\Users\\mso50\\new-reselleros par jao (owner Allow dabayega).",
    "Asli repo SIRF Anutech-Digital/anutechbilling (remote 'anutech'), branch manager-pardeep. Abhicode0to1/new-reselleros public purana repo hai — wahan kabhi push nahi. staging/deploy mat chhuo.",
    "Kahan test karna hai: LOCAL app http://localhost:3001 (test data). Live/staging par form submit ya kuch save MAT karo.",
    "",
    `Page: ${input.pagePath}`,
    "Tests:",
    ...tests.map((t, i) => `${i + 1}. ${t}`),
    "",
    "Har test ke liye: browser pane me dikha kar chalao, screenshot lo, aur ✓ (chala) / ✗ (nahi chala, kya hua) likho. Koi test samajh na aaye to ✗ nahi — 'chala nahi paya, kyun' likho.",
    "✗ wale test: har ek ke liye board par card banao (title me page + kya toota, kadam, screenshot ka varnan). Fix tabhi karo jab owner kahe.",
    "NATEEJA BOARD PAR: 'Kaam ki list' (https://claude.ai/artifact/84m2bpzzSYoir48DrhFD5n, collection cards) par ek card 'Test run: <page>' status done — har test ka ✓/✗ ek line me. Samay date -u se.",
    "NATEEJA APP ME (R-352, board ke baad): AI Help ko yaad rahe ki kya chal chuka — warna 'Check this page' wahi tests dobara deta hai. LOCAL app par bhejo:",
    `  a) scratchpad me results.json likho: {"tenantId":"${tenantId}","page":"${page}","buildSha":"<git -C production rev-parse --short HEAD>","runBy":"AI browser test","results":[{"test":"<test, upar ki list se hubahu>","result":"pass|fail|skipped","note":"<chhota: ✗/skipped kyun>","card":"<✗ ka board card R-xxx, ho to>"}]} — har test ki ek entry.`,
    "  b) curl -s -X POST -H \"Authorization: Bearer $(grep '^AGENT_QUEUE_TOKEN=' production/.env.local | cut -d= -f2-)\" -H 'content-type: application/json' --data @<results.json ka poora path> http://localhost:3001/api/agent/page-test-runs",
    "  Token KABHI print/echo/log mat karo, kisi file me mat likho, chat me mat dikhao. 200 = ho gaya. 503 'migration pending' = table abhi nahi lagi — board card par likh do aur aage badho. 401/400/404 = board card par wajah likho.",
    "SESSION ARCHIVE: board par likhne ke baad ye session archive karo (mcp__ccd_session_mgmt__archive_session, session_id \"self\") — SIRF agar ye session ISI prompt se shuru hua. Pehle se koi aur baatcheet ho to archive MAT karo.",
  ].join("\n");
}

/** The tag every AI-filed report carries — short, as asked. */
export const AI_FILED_TAG = "🤖 AI-drafted after chat";

/**
 * The text the feedback row gets: the first line is the title (that is how the Report Bug
 * dialog's rows are read), then the developer's sections, then the short AI tag with whose
 * report it is.
 */
export function bugReportText(d: BugDraft, ctx: { pagePath: string | null; reporterName: string | null; recorded?: string | null }): string {
  const lines = [
    d.title,
    "",
    `Page: ${ctx.pagePath || "—"}`,
    "",
    "What happened:",
    d.actual,
  ];
  if (d.expected) lines.push("", "What should happen:", d.expected);
  if (d.steps.length) lines.push("", "Steps to see it:", ...d.steps.map((s, i) => `${i + 1}. ${s}`));
  /* R-162: the app's own record of the last moves and errors — the developer's best clue,
     and the part no reporter writes down. */
  if (ctx.recorded) lines.push("", "What the app recorded (last steps):", ctx.recorded.slice(0, 2500));
  lines.push("", `${AI_FILED_TAG} with ${ctx.reporterName || "the reporter"}.`);
  return lines.join("\n");
}
