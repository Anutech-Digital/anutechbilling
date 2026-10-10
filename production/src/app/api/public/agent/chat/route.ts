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
import { NextResponse, type NextRequest } from "next/server";
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
  type PublicChatReply,
} from "@/lib/ai/public-sales-chat";
import { loadAutonomyPolicy, logAiAction } from "@/lib/ai/autonomy.server";
import { createBareClient } from "@/lib/supabase/bare";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveAutonomy } from "@/lib/ai/autonomy";

const BUY_PAGE_TENANT_ID =
  process.env.BUY_PAGE_TENANT_ID?.trim() || "fbb976f1-9090-4f10-9726-0901bd144e42";

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

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "malformed" }, { status: 400 });
  }

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
     The agent's own recent lessons (written by the reflection below) go back into its
     prompt. Each one re-passes sanitizeLearning at READ time too — the store is a
     database row somebody could edit, and the filter is cheap. Advice-only by prompt
     construction; HARD RULES outrank. */
  const lessonsDb = bareLog();
  const { data: lessonRows } = lessonsDb === null
    ? { data: [] as { reason: string | null }[] }
    : await lessonsDb
        .from("ai_action_log")
    .select("reason")
    .eq("tenant_id", BUY_PAGE_TENANT_ID)
    .eq("action", "public_chat.learn")
    .eq("outcome", "did")
    .order("created_at", { ascending: false })
    .limit(5);
  const learnings = (lessonRows ?? [])
    .map((r) => sanitizeLearning((r as { reason: string | null }).reason))
    .filter((l): l is string => l !== null);

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
       3. The widget has not already been credited (leadAlreadyCaptured) — one chat, one
          lead. The app's own Duplicate? marker is the backstop behind that.

     Then the enquiry goes to this deployment's OWN public enquiry endpoints — the same
     machinery, gates, auto-quote and mails as the website form. Self-addressed via the
     request's own origin rather than an env URL, because an env-configured self-URL in
     this repo has already pointed at a dead service once. */
  const alreadyCaptured = (body as Record<string, unknown>)?.leadAlreadyCaptured === true;
  let leadCreated: { quoteId: string | null } | null = null;

  if (guarded.lead && !alreadyCaptured && leadDetailsAppearInTranscript(guarded.lead, messages)) {
    const L = guarded.lead;
    /* ── LOOPBACK, not the request URL's own origin — measured failure, 1 Sep 2026 ──
       The first version self-addressed via the incoming request's origin, and on Cloud
       Run that resolves with the https scheme while the CONTAINER serves plain HTTP on
       $PORT (TLS ends at the proxy). The live log, on the first real chat lead:

           ERR_SSL_WRONG_VERSION_NUMBER … ssl3_get_record:wrong version number

       — the reply went out, the lead silently did not. Loopback HTTP is what a
       container can always say to itself; PORT is set by Cloud Run (8080) and the
       request port covers local dev. (The test bans the origin accessor by name — and
       this comment cannot name it either, or the comment defeats the test: the third
       time this session that exact failure shape has appeared.) */
    const origin = `http://127.0.0.1:${process.env.PORT || request.nextUrl.port || "3000"}`;
    const summary = messages
      .filter((m) => m.role === "user")
      .map((m) => m.text)
      .join(" | ")
      .slice(0, 1_500);
    try {
      if (L.tier && L.seats) {
        const res = await fetch(new URL("/api/public/enquiry/workspace", origin), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            fullName: L.fullName,
            companyName: L.company || L.fullName,
            email: L.email,
            phone: L.phone,
            seats: L.seats,
            tierId: L.tier,
            billing: L.term === "monthly" ? "monthly" : "annual",
            message: `Via the website AI sales chat. Conversation: ${summary}`,
          }),
          signal: AbortSignal.timeout(15_000),
          cache: "no-store",
        });
        if (res.ok) {
          const data = (await res.json()) as { draftQuoteId?: string | null };
          leadCreated = { quoteId: data.draftQuoteId ?? null };
        }
      } else {
        const res = await fetch(new URL("/api/public/enquiry/general", origin), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            fullName: L.fullName,
            companyName: L.company || L.fullName,
            email: L.email,
            phone: L.phone,
            product: "google-workspace",
            ...(L.seats ? { seats: L.seats } : {}),
            message: `Via the website AI sales chat. Conversation: ${summary}`,
          }),
          signal: AbortSignal.timeout(15_000),
          cache: "no-store",
        });
        if (res.ok) leadCreated = { quoteId: null };
      }
    } catch (err) {
      /* The chat reply still goes out — a failed lead write must not eat the answer. The
         operator side loses nothing permanent: the visitor was told a person follows up,
         and the transcript asks again on a later turn because the widget was not credited. */
      console.error("[public/agent-chat] lead filing failed:", err);
    }
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
  if (!leadCreated && promisesDelivery(guarded.reply)) {
    /* R-235: visitor ke aakhri sandesh ki bhasha me (default English). */
    guarded = { ...guarded, reply: honestNoDeliveryReply(messages[messages.length - 1]?.text ?? "") };
  }

  const guardTripped = guarded.reply === fallbackReply().reply;
  if (leadCreated || guardTripped) {
    void (async () => {
      try {
        const policy = await loadAutonomyPolicy(BUY_PAGE_TENANT_ID);
        if (resolveAutonomy("public_chat.learn", policy).mode !== "auto") return;
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
          action: "public_chat.learn",
          outcome: "did",
          reason: lesson,
          mode: "auto",
          entity: "public_chat",
          entityId: null,
          facts: { ending: leadCreated ? "lead_captured" : "guard_fallback", turns: messages.length },
        });
      } catch (err) {
        console.error("[public/agent-chat] reflection failed:", err);
      }
    })();
  }

  return NextResponse.json({ ...guarded, leadCreated } satisfies PublicChatReply & { leadCreated: { quoteId: string | null } | null });
}
