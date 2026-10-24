/**
 * POST /api/public/agent/chat — the website's live AI sales agent.
 *
 * Anonymous, so everything about it is bounded: message count and length are capped
 * (lib/ai/public-sales-chat.ts), the model receives a hand-picked page of PUBLIC facts
 * rather than any database access, and every reply passes the money guard before a
 * visitor sees it. The full design argument lives in public-sales-chat.ts.
 *
 * Gemini goes through the ONE gateway (lib/ai/gemini.ts — timeout, circuit breaker,
 * retry, stated failure reasons). When the gateway cannot answer — no key, breaker open,
 * quota — the visitor gets the honest fallback: quote page + WhatsApp, never an error
 * page and never a made-up answer.
 */
import { NextResponse, NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { resolveGeminiConfig, geminiJson } from "@/lib/ai/gemini";
import { publicWorkspaceCatalog } from "@/lib/catalog/public-workspace";
import {
  sanitizeMessages,
  buildFacts,
  systemPrompt,
  guardReply,
  fallbackReply,
  leadDetailsAppearInTranscript,
  sanitizeLearning,
  reflectionPrompt,
  promisesDelivery,
  honestNoDeliveryReply,
  leadNotSavedReply,
  type PublicChatReply,
} from "@/lib/ai/public-sales-chat";
import { POST as generalEnquiry } from "@/app/api/public/enquiry/general/route";
import { POST as workspaceEnquiry } from "@/app/api/public/enquiry/workspace/route";
import { passThroughHeaders, type LocalHandler } from "@/site/lib/app-forward";
import { markTrustedInternalCall, turnstileRefusalFor } from "@/lib/security/turnstile-guard";
import { siteVisitorLimit } from "@/lib/security/rate-limit";
import { redactContacts } from "@/lib/security/redact-contact";
import { loadAutonomyPolicy, logAiAction } from "@/lib/ai/autonomy.server";
import { createBareClient } from "@/lib/supabase/bare";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveAutonomy } from "@/lib/ai/autonomy";
import { websiteTenantId, websiteTenantMissingBody } from "@/lib/website-tenant";
import {
  approvedLessons,
  escapeIlike,
  LESSON_ACTION,
  LESSON_DECISION_ENTITY,
  LESSON_ENTITY,
  type LessonLogRow,
} from "@/lib/ai/public-chat-lessons";

/* R-1499: the website tenant is read per request (websiteTenantId) — outside production an unset
   BUY_PAGE_TENANT_ID refuses with a clear message, never the live tenant. */

export const dynamic = "force-dynamic";

/* ai_action_log typed Database schema me nahi hai — wahi untyped bare() jo
   performance.server.ts aur autonomy.server.ts use karte hain, wahi yahan. */
function bareLog(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) return null;
  return createBareClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (u, o) => fetch(u, { ...o, cache: "no-store" }) },
  });
}

/** R-727: how long one email counts as "already a lead" for the chat. */
const LEAD_DEDUP_MS = 24 * 60 * 60_000;

/**
 * R-727: does this workspace already have a lead for this email from the last day? Decided
 * from the leads table, never from the browser. A failed read answers "no" — losing a real
 * lead is worse, and the per-email limit (siteVisitorLimit) still bounds repeats.
 */
async function emailHasRecentLead(
  admin: ReturnType<typeof createAdminClient>,
  tenantId: string,
  email: string,
): Promise<boolean> {
  try {
    const since = new Date(Date.now() - LEAD_DEDUP_MS).toISOString();
    const { data, error } = await admin
      .from("leads")
      .select("id")
      .eq("tenant_id", tenantId)
      .ilike("contact_email", escapeIlike(email.trim()))
      .gte("created_at", since)
      .limit(1);
    if (error) return false;
    return (data ?? []).length > 0;
  } catch {
    return false;
  }
}

export async function POST(request: NextRequest) {
  const BUY_PAGE_TENANT_ID = websiteTenantId();
  if (!BUY_PAGE_TENANT_ID) return NextResponse.json(websiteTenantMissingBody(), { status: 503 });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "malformed" }, { status: 400 });
  }

  /* R-737: every chat turn burns paid Gemini — a script gets no answer. No-op until
     TURNSTILE_SECRET_KEY is set; the widget in AgentChat sends a fresh token per message. */
  const bot = await turnstileRefusalFor(request, body);
  if (bot) return bot;

  const messages = sanitizeMessages((body as Record<string, unknown>)?.messages);
  if (!messages) {
    return NextResponse.json({ error: "messages must be a non-empty array ending with the visitor's turn" }, { status: 400 });
  }

  const admin = createAdminClient();

  /* Live facts — the same shape (and the same wholesale-stripping) as the public
     catalogue endpoint. A failure here degrades to an empty price list; the prompt tells
     the model to offer the quote page in that case rather than remember old prices. */
  const { data: rows } = await admin
    .from("items")
    .select("name, msrp, prices")
    .eq("tenant_id", BUY_PAGE_TENANT_ID)
    .eq("vendor", "google")
    .eq("kind", "main")
    .eq("is_active", true)
    .ilike("name", "Google Workspace%")
    .order("msrp", { ascending: true });

  const { data: tenant } = await admin
    .from("tenants")
    .select("name, phone")
    .eq("id", BUY_PAGE_TENANT_ID)
    .maybeSingle();

  const facts = buildFacts(publicWorkspaceCatalog(rows ?? []), {
    name: tenant?.name?.trim() || "Anutech Digital Pvt Ltd",
    phone: tenant?.phone?.trim() || null,
    supportHours: "Mon–Sat, 10:00–19:00 IST",
  });

  /* ── SELF-LEARNING, READ SIDE ────────────────────────────────────────────
     R-727 (23 Oct 2026): only lessons a PERSON approved on /automation go back into the
     prompt (lib/ai/public-chat-lessons.ts). A lesson distilled from an anonymous visitor's
     conversation used to go straight in, so a visitor could teach every later visitor's chat.
     Each one re-passes sanitizeLearning at READ time too — the store is a database row
     somebody could edit. Advice-only by prompt construction; HARD RULES outrank. */
  const lessonsDb = bareLog();
  const { data: lessonRows } = lessonsDb === null
    ? { data: [] as LessonLogRow[] }
    : await lessonsDb
        .from("ai_action_log")
        .select("reason, outcome, entity, facts")
        .eq("tenant_id", BUY_PAGE_TENANT_ID)
        .eq("action", LESSON_ACTION)
        .eq("outcome", "did")
        .eq("entity", LESSON_DECISION_ENTITY)
        .order("created_at", { ascending: false })
        .limit(5);
  const learnings = approvedLessons((lessonRows ?? []) as LessonLogRow[]);

  const gemini = await resolveGeminiConfig(admin, BUY_PAGE_TENANT_ID);
  if (!gemini.apiKey) {
    /* No key configured is a stated state, not an error page — the visitor still gets a
       useful answer. */
    return NextResponse.json(fallbackReply() satisfies PublicChatReply);
  }

  /* The transcript goes in the user part, clearly fenced, so a visitor writing "system:"
     cannot promote themselves — the real system prompt travels in systemInstruction. */
  const transcript = messages
    .map((m) => `${m.role === "user" ? "VISITOR" : "ASSISTANT"}: ${m.text}`)
    .join("\n");

  const raw = await geminiJson<PublicChatReply>({
    apiKey: gemini.apiKey,
    model: gemini.model,
    system: systemPrompt(facts.factsText, learnings),
    user: `Conversation so far:\n${transcript}\n\nAnswer the visitor's last message.`,
    temperature: 0.4,
    timeoutMs: 20_000,
    label: "public/agent-chat",
    /* A visitor is waiting: when the main model is overloaded twice, ask the lighter one
       instead of answering "could not reply" (4 Oct 2026 — gemini-flash-lite-latest
       measured 200 against the live API that day). */
    fallbackModel: process.env.GEMINI_FALLBACK_MODEL?.trim() || "gemini-flash-lite-latest",
  });

  if (!raw) return NextResponse.json(fallbackReply() satisfies PublicChatReply);

  let guarded = guardReply(raw, facts.allowedFigures);

  /* ── THE LEAD — the whole point of the chat, filed through the PROVEN path ──
     Three conditions before anything is written:

       1. guardReply validated the fields (shape, email regex, 10-digit phone).
       2. The details literally appear in VISITOR turns — the model only ever sees the
          transcript, so a true detail must be quoted from it. A hallucinated contact is
          dropped silently and the visitor simply gets asked again later.
       3. This email has no lead in this workspace in the last day — decided HERE, from the
          leads table (R-727). The widget's `leadAlreadyCaptured` used to be the only check,
          and a script simply sent `false` every time: a new lead + auto-quote mail to any
          address on every message. The flag is still honoured when it says TRUE (it can
          only save a write); it can no longer cause one.

     Then the enquiry goes to this deployment's OWN public enquiry handlers — the same
     machinery, gates, auto-quote and mails as the website form.

     ── R-1549 (19 Oct 2026): IN-PROCESS, as the visitor, past Turnstile only as ourselves ──
     It used to fetch http://127.0.0.1:$PORT/api/public/enquiry/* (an earlier version used the
     request's own origin, which on Cloud Run said https to a plain-HTTP container and every
     lead failed). That loopback hop carried no visitor IP, so every chat visitor shared ONE
     rate-limit bucket, and no Turnstile token, so with TURNSTILE_SECRET_KEY set every chat
     lead was refused — and a refusal was only a log line, the visitor still read "our team
     will contact you". Now the handler is called in-process (the same way /api/enquiry calls
     it since R-1598), with the visitor's headers (IP, Referer), on a request object marked as
     this server's own call so Turnstile lets it through; the lead counts against this
     visitor's IP and email (siteVisitorLimit); and a lead that was not saved is SAID. */
  const widgetSaysCaptured = (body as Record<string, unknown>)?.leadAlreadyCaptured === true;
  let leadCreated: { quoteId: string | null } | null = null;
  let leadSaveFailed = false;

  if (
    guarded.lead &&
    !widgetSaysCaptured &&
    leadDetailsAppearInTranscript(guarded.lead, messages) &&
    !(await emailHasRecentLead(admin, BUY_PAGE_TENANT_ID, guarded.lead.email))
  ) {
    const L = guarded.lead;
    const summary = messages
      .filter((m) => m.role === "user")
      .map((m) => m.text)
      .join(" | ")
      .slice(0, 1_500);
    /* One enquiry handler call, built here and marked as ours — never a request from the network. */
    const file = (path: string, handler: LocalHandler, payload: Record<string, unknown>) =>
      handler(markTrustedInternalCall(new NextRequest(new URL(path, request.url), {
        method: "POST",
        headers: passThroughHeaders(request),
        body: JSON.stringify(payload),
      })));
    try {
      const limit = await siteVisitorLimit("enquiry", request.headers, L.email);
      if (!limit.ok) {
        leadSaveFailed = true;
        console.error(`[public/agent-chat] lead filing failed: rate-limited for this visitor (retry in ${limit.retryAfterSec}s)`);
      } else if (L.tier && L.seats) {
        const res = await file("/api/public/enquiry/workspace", workspaceEnquiry, {
          fullName: L.fullName,
          companyName: L.company || L.fullName,
          email: L.email,
          phone: L.phone,
          seats: L.seats,
          tierId: L.tier,
          billing: L.term === "monthly" ? "monthly" : "annual",
          message: `Via the website AI sales chat. Conversation: ${summary}`,
        });
        if (res.ok) {
          const data = (await res.json()) as { draftQuoteId?: string | null };
          leadCreated = { quoteId: data.draftQuoteId ?? null };
        } else {
          leadSaveFailed = true;
          console.error(`[public/agent-chat] lead filing failed: workspace handler answered ${res.status}`);
        }
      } else {
        const res = await file("/api/public/enquiry/general", generalEnquiry, {
          fullName: L.fullName,
          companyName: L.company || L.fullName,
          email: L.email,
          phone: L.phone,
          product: "google-workspace",
          ...(L.seats ? { seats: L.seats } : {}),
          message: `Via the website AI sales chat. Conversation: ${summary}`,
        });
        if (res.ok) leadCreated = { quoteId: null };
        else {
          leadSaveFailed = true;
          console.error(`[public/agent-chat] lead filing failed: general handler answered ${res.status}`);
        }
      }
    } catch (err) {
      /* The chat reply still goes out — a failed lead write must not eat the answer — but it
         says the details were not saved (below), and the widget is not credited, so the
         transcript asks again on a later turn. */
      leadSaveFailed = true;
      console.error("[public/agent-chat] lead filing failed:", redactContacts(err instanceof Error ? err.message : String(err)));
    }
  }

  /* R-1549: details given, not saved — the model's "our team will contact you" would be a lie. */
  if (leadSaveFailed) {
    guarded = { ...guarded, reply: leadNotSavedReply(messages[messages.length - 1]?.text ?? "") };
  }

  /* ── SELF-LEARNING, WRITE SIDE ───────────────────────────────────────────
     One lesson per FINISHED conversation — finished meaning a lead was captured, or the
     money guard had to replace a reply (the two moments with something to learn from).
     Fire-and-forget: the visitor's reply never waits on homework. Behind its own
     autonomy dial (public_chat.learn), so one click in /automation stops the loop. */
  /* ── Delivery-vaadon ka pehredaar (1 Sep 2026) ───────────────────────────
     Naapa hua jhooth: "team formal GST quotation generate kar rahi hai...
     jald hi deliver ho jayega... WhatsApp par bhi confirm karegi" — us
     session me na lead, na quotation, na email (DB me dekha). "Bheji ja
     rahi hai" kehna TABHI sach hai jab isi turn me quotation sach me bani
     ho (leadCreated) — warna reply imandaar agle-kadam se badal di jati
     hai. suggestQuote/lead-nikaasi waise hi rehte hain. */
  if (!leadCreated && !leadSaveFailed && promisesDelivery(guarded.reply)) {
    /* R-235: visitor ke aakhri sandesh ki bhasha me (default English). */
    guarded = { ...guarded, reply: honestNoDeliveryReply(messages[messages.length - 1]?.text ?? "") };
  }

  /* R-727: the lesson is written HELD — it waits on /automation for an owner or manager to
     press Use lesson (api/ai/action-log/lesson). The dial supports off/hold only; there is no
     "auto" any more, so no setting can put an unreviewed lesson into the prompt. */
  const guardTripped = guarded.reply === fallbackReply().reply;
  if (leadCreated || guardTripped) {
    void (async () => {
      try {
        const policy = await loadAutonomyPolicy(BUY_PAGE_TENANT_ID);
        if (resolveAutonomy(LESSON_ACTION, policy).mode !== "hold") return;
        const lessonRaw = await geminiJson<{ lesson?: string }>({
          apiKey: gemini.apiKey!,
          model: gemini.model,
          user: reflectionPrompt(transcript, leadCreated ? "lead_captured" : "guard_fallback"),
          temperature: 0.2,
          timeoutMs: 10_000,
          label: "public/agent-reflect",
        });
        const lesson = sanitizeLearning(lessonRaw?.lesson);
        if (!lesson) return;
        await logAiAction({
          tenantId: BUY_PAGE_TENANT_ID,
          action: LESSON_ACTION,
          outcome: "held",
          reason: lesson,
          mode: "hold",
          entity: LESSON_ENTITY,
          entityId: null,
          facts: { ending: leadCreated ? "lead_captured" : "guard_fallback", turns: messages.length },
        });
      } catch (err) {
        console.error("[public/agent-chat] reflection failed:", err);
      }
    })();
  }

  return NextResponse.json({ ...guarded, leadCreated, leadSaveFailed } satisfies PublicChatReply & { leadCreated: { quoteId: string | null } | null; leadSaveFailed: boolean });
}
