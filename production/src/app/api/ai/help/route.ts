/**
 * POST /api/ai/help — the in-app AI Help chat (R-158, 5 Oct 2026), now a test co-pilot (R-162).
 *
 * Signed-in staff only. Takes the chat so far and the page the person is on; returns a
 * reply and, when the chat has found a bug, a draft report. It files NOTHING — the person
 * reads the draft and files it from the panel (lib/ai/app-help.ts explains why).
 *
 * R-162 adds three optional inputs from the panel: `trail` (what the app recorded in this
 * tab), `findings` + `outline` (the "Check this page" scan), and `mode` (chat | scan | error).
 * Every recorded string is PII-masked here as well as in the browser — emails, phone
 * numbers, GSTIN and PAN never reach the model. With a draft, open reports in this
 * workspace that look like the same bug come back as `similar`, so nobody files it twice.
 *
 * Gemini through geminiJson (timeout + circuit breaker, null on every failure). With no
 * key or a failed call it says so plainly and points at the Report Bug button — the chat is
 * a help, never the only way to report.
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { resolveGeminiConfig, geminiJson } from "@/lib/ai/gemini";
import { rateLimit } from "@/lib/security/rate-limit";
import { maskPII } from "@/lib/ux/signals";
import { pagePurpose } from "@/lib/ai/page-purpose";
import { helpFacts } from "@/lib/ai/help-facts";
import { loadLastPageTestRun, testHistoryForPrompt } from "@/lib/ai/page-test-runs";
import { helpSystemPrompt, helpUserTurn, parseHelpAnswer, HELP_MAX_CHARS, HELP_MAX_MESSAGES } from "@/lib/ai/app-help";
import { trailForPrompt, findingsForPrompt, looksLikeSameBug, TRAIL_MAX, FINDINGS_MAX, type TrailEvent, type Finding } from "@/lib/ai/test-trail";

const bodySchema = z.object({
  messages: z.array(z.object({ role: z.enum(["user", "assistant"]), text: z.string().trim().min(1).max(HELP_MAX_CHARS * 2) })).max(HELP_MAX_MESSAGES * 2).default([]),
  pagePath: z.string().max(300).nullable().optional(),
  mode: z.enum(["chat", "scan", "error", "check_failed"]).default("chat"),
  /** check_failed: the "Test next" line the person marked as failed. */
  failedCheck: z.string().trim().max(300).optional(),
  trail: z.array(z.object({
    kind: z.enum(["page", "click", "error", "api_fail", "toast_error", "input_needed"]),
    at: z.number(),
    text: z.string().max(400),
    path: z.string().max(300),
  })).max(TRAIL_MAX).optional(),
  findings: z.array(z.object({
    kind: z.enum(["bad_text", "broken_image", "overflow", "unnamed_button", "api_fail", "js_error", "slow"]),
    detail: z.string().max(400),
  })).max(FINDINGS_MAX).optional(),
  outline: z.string().max(2000).optional(),
  /** R-189: one screenshot with this message (page capture or pasted), JPEG/PNG base64, ≤ ~1.5 MB. */
  image: z.object({
    mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]),
    base64: z.string().max(2_000_000).regex(/^[A-Za-z0-9+/=]+$/),
  }).optional(),
});

const UNAVAILABLE = "AI Help abhi jawab nahi de pa raha. Bug ho to upar 'Report Bug' button (Ctrl+Shift+B) se seedha bhej dijiye.";
/** R-190 (6 Oct 2026): another company had no AI key and was told only "not available".
    Say what is missing and where to add it. */
const NO_KEY = "Is company ke liye AI (Gemini) key nahi lagi hai, isliye AI Help jawab nahi de sakta. Owner Settings → Integrations → Gemini me key daal de (/settings?tab=integrations). Tab tak bug ho to 'Report Bug' button (Ctrl+Shift+B) se bhej dijiye.";

/** What the person "said" when they pressed a button instead of typing. */
const MODE_PROMPT = { scan: "Is page ko jaancho.", error: "Abhi jo error aaya, uski report banao." } as const;

export async function POST(request: NextRequest) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  if (!rateLimit(`ai-help:${user.id}`, { limit: 30, windowMs: 10 * 60_000 }).ok) {
    return NextResponse.json({ error: "Thoda ruk kar poochhiye — 10 minute mein 30 sawaal ki seema hai." }, { status: 429 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Message samajh nahi aaya — dobara likhiye." }, { status: 400 });
  const { pagePath, mode, outline } = parsed.data;
  const messages = [...parsed.data.messages];
  if (mode === "check_failed") {
    if (!parsed.data.failedCheck) return NextResponse.json({ error: "Which test failed?" }, { status: 400 });
    messages.push({ role: "user", text: `Ye test fail hua: "${parsed.data.failedCheck}". Iski bug report banao.` });
  } else if (mode !== "chat") messages.push({ role: "user", text: MODE_PROMPT[mode] });
  if (!messages.length || messages[messages.length - 1].role !== "user") return NextResponse.json({ error: "Last message must be yours." }, { status: 400 });
  const image = parsed.data.image;
  if (image) {
    const last = messages[messages.length - 1];
    messages[messages.length - 1] = { ...last, text: `${last.text}

[Screenshot attached: the screen the person is looking at. Read it — labels, numbers, errors — and use it in your answer.]` };
  }

  const trail: TrailEvent[] = (parsed.data.trail ?? []).map((e) => ({ ...e, text: maskPII(e.text, 200) ?? "", path: e.path }));
  const findings: Finding[] = (parsed.data.findings ?? []).map((f) => ({ ...f, detail: maskPII(f.detail, 300) ?? "" }));

  // RLS scopes these reads to the caller's own row and tenant.
  const { data: me } = await supabase.from("users").select("tenant_id, full_name, role").eq("id", user.id).maybeSingle();
  const gemini = await resolveGeminiConfig(supabase, me?.tenant_id ?? null);
  if (!gemini.apiKey) return NextResponse.json({ reply: NO_KEY, bugDraft: null, checklist: [], followUps: [], ai: false, reason: "no_key" });

  /* R-189: the company's own setup, read with the person's login (RLS) — not for error
     reports, which are about what just broke. */
  const facts = me?.tenant_id && mode !== "error" ? await helpFacts(supabase, me.tenant_id).catch(() => null) : null;

  /* R-352: the page's last browser test run (owner/manager, RLS) so "Check this page" does
     not hand back tests that already passed. No table yet / no run / no access → null, and
     the prompt is what it was before. */
  const lastRun = me?.tenant_id && (mode === "scan" || mode === "chat")
    ? await loadLastPageTestRun(supabase, me.tenant_id, pagePath ?? null)
    : null;
  const testHistory = testHistoryForPrompt(lastRun, process.env.BUILD_SHA?.trim() || "dev");

  let failure = "";
  const raw = await geminiJson<unknown>({
    apiKey: gemini.apiKey,
    model: gemini.model,
    system: helpSystemPrompt({ pagePath: pagePath ?? null, userName: me?.full_name ?? null, role: me?.role ?? null, mode, pagePurpose: pagePurpose(pagePath), testHistory }),
    user: helpUserTurn(messages, {
      trail: trail.length ? trailForPrompt(trail) : null,
      findings: mode === "scan" ? findingsForPrompt(findings) : null,
      outline: mode === "scan" && outline ? maskPII(outline, 1500) : null,
      facts: facts?.text ?? null,
    }),
    temperature: 0.3,
    timeoutMs: image ? 40_000 : 25_000,
    ...(image ? { attachment: { mimeType: image.mimeType, base64: image.base64 } } : {}),
    label: "ai/help",
    onFailure: (r) => { failure = r; },
  });
  const answer = parseHelpAnswer(raw, facts?.customerIds);
  if (!answer) {
    if (failure) console.error("[ai/help] no answer:", failure);
    return NextResponse.json({ reply: UNAVAILABLE, bugDraft: null, checklist: [], followUps: [], ai: false });
  }

  // Same bug already open in this workspace? RLS limits the read to the caller's tenant.
  let similar: { id: string; title: string }[] = [];
  if (answer.bugDraft && me?.tenant_id) {
    const { data: open } = await supabase
      .from("feedback")
      .select("id, title, page_path")
      .eq("tenant_id", me.tenant_id)
      .in("status", ["open", "agent_queued"])
      .order("created_at", { ascending: false })
      .limit(100);
    similar = (open ?? [])
      .filter((r) => looksLikeSameBug({ title: answer.bugDraft!.title, pagePath: pagePath ?? null }, r))
      .slice(0, 3)
      .map((r) => ({ id: r.id, title: r.title }));
  }
  return NextResponse.json({ ...answer, similar, ai: true });
}
