/**
 * POST /api/leads/[id]/draft-reply — write the reply this customer's last message deserves.
 *
 * Asked for on 23 Aug 2026: "me chahta hu ai human ki tarah reply de jaise ek real sales
 * person ko ki enquiry ka reply dena chahiye vaise hi reply de."
 *
 * ─── IT DRAFTS. IT DOES NOT SEND. ───────────────────────────────────────────
 * The draft comes back as text and lands in the composer the operator is already looking
 * at. Sending stays the existing one-tap action, unchanged. That is not a smaller version
 * of the feature — an email cannot be recalled, and the whole reason this reply is worth
 * drafting is that the customer has corrected us twice already. When an operator has read
 * twenty of these and trusts them, auto-send becomes a tenant setting; it is not a default
 * anybody should get by accident.
 *
 * ─── THE MODEL WRITES PROSE. IT DOES NOT PRODUCE FACTS. ─────────────────────
 * `buildReplyContext` assembles what a salesperson would know — the thread with our own
 * quoted words stripped out, the requirement marked confirmed or not, the quote total if
 * one was sent — and `verifyDraftMoney` then checks the draft against the figures that
 * were actually allowed. A draft containing any other amount is DISCARDED, not corrected:
 * the sentence around a wrong number was written to suit that number.
 *
 * ─── TENANT-SCOPED THROUGH THE SESSION CLIENT ───────────────────────────────
 * Every read here goes through the operator's own client, so RLS decides what this lead
 * and its thread are. No admin client, no tenant id from the caller.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { errorResponse, RouteError, mayOpenPage, ROLE_GATE_ERROR } from "@/lib/api/with-route";
import { resolveGeminiConfig, geminiJson } from "@/lib/ai/gemini";
import { verifyDraftMoney } from "@/lib/ai/money-guard";
import { logAiDecision, formatGuardBlock } from "@/lib/ai/audit";
import { buildReplyContext, REPLY_SYSTEM_PROMPT, type ThreadTurn } from "@/lib/ai/reply-context";
import { buildEmailThread, factsSuperseded } from "@/lib/leads/email-thread";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface Draft { subject: string; message: string }

export async function POST(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Please sign in again." }, { status: 401 });

  /* R-1470: replies are drafted from Sales & Pipeline and Enquiries — only roles that open one of
     them, checked before the lead, its thread or the model is touched. The row also gives the
     tenant for the sign-off below. */
  const { data: me } = await supabase
    .from("users").select("tenant_id, role").eq("id", user.id).maybeSingle();
  if (!mayOpenPage(me?.role, ["/leads", "/enquiries"])) {
    return NextResponse.json({ error: ROLE_GATE_ERROR }, { status: 403 });
  }

  const leadId = params.id;

  /* RLS scopes both of these. A lead from another tenant simply is not found, which is the
     answer we want to give anyway. */
  const { data: lead, error: leadErr } = await supabase
    .from("leads")
    .select("id, company, contact_name, seats, plan")
    .eq("id", leadId)
    .maybeSingle();
  // Raw DB text client ko nahi (S21) — server log me [route] prefix ke saath.
  if (leadErr) return errorResponse("[api/leads/draft-reply]", "POST", new RouteError(500, "Could not load the lead — please try again.", leadErr.message));
  if (!lead) return NextResponse.json({ error: "Lead not found." }, { status: 404 });

  const { data: rows } = await supabase
    .from("inbound_emails")
    .select("id, lead_id, status, from_email, to_email, subject, body_text, body_html, created_at")
    .eq("lead_id", leadId)
    .order("created_at", { ascending: true });

  const thread = buildEmailThread(rows ?? [], leadId);
  const turns: ThreadTurn[] = thread.map((m) => ({
    direction: m.direction,
    at: m.at,
    body: m.body,
  }));

  /* The tenant's own name for the sign-off — never a hardcoded company (L20). */
  const tenantId = (me as { tenant_id?: string | null } | null)?.tenant_id ?? null;
  const { data: tenant } = tenantId
    ? await supabase.from("tenants").select("name").eq("id", tenantId).maybeSingle()
    : { data: null };

  /* The most recent quote actually SENT to this lead, so the reply can refer to it rather
     than promising a new one. `status` in ('sent','viewed') — a draft quote is not
     something the customer has seen, and telling them about one would be a lie. */
  const { data: quotes } = await supabase
    .from("quotes")
    .select("id, amount, status, created_at")
    .eq("lead_id", leadId)
    .in("status", ["sent", "viewed"])
    .order("created_at", { ascending: false })
    .limit(1);
  const sentQuote = (quotes ?? [])[0] as { id: string; amount: number | null } | undefined;

  const ctx = buildReplyContext({
    thread: turns,
    facts: {
      sellerName: (tenant as { name?: string | null } | null)?.name ?? null,
      customerName: lead.contact_name ?? lead.company ?? null,
      seats: lead.seats ?? null,
      plan: lead.plan ?? null,
      /* Same rule the reply pills use: more than one inbound message means the stored
         requirement may be a snapshot of the first enquiry. */
      factsUnconfirmed: factsSuperseded({ thread }),
      quote: sentQuote && (sentQuote.amount ?? 0) > 0
        ? { id: sentQuote.id, amount: sentQuote.amount as number }
        : null,
    },
  });

  if (ctx.blocked) {
    /* 409, not 500: nothing is broken, there is simply nothing to reply to. */
    return NextResponse.json({ error: ctx.blocked }, { status: 409 });
  }

  const gemini = await resolveGeminiConfig(supabase, tenantId);
  if (!gemini.apiKey) {
    /* No stub draft here, deliberately. The pills in the composer already provide a
       deterministic reply and say what they are; a second, blander template pretending to
       be an AI draft would just be a worse pill. */
    return NextResponse.json(
      { error: "AI drafting is not configured for this workspace. Use one of the quick replies instead." },
      { status: 503 },
    );
  }

  const parsed = await geminiJson<Partial<Draft>>({
    apiKey: gemini.apiKey,
    model: gemini.model,
    tenantId: gemini.tenantId,
    system: REPLY_SYSTEM_PROMPT,
    user: ctx.contextText,
    temperature: 0.6,
    label: "ai/draft-reply",
  });

  if (!parsed?.message) {
    /* geminiJson returns null on every failure path — timeout, breaker open, bad JSON — so
       an outage degrades to "use a quick reply" rather than hanging the composer. */
    return NextResponse.json(
      { error: "The AI did not respond. Try again, or use one of the quick replies." },
      { status: 503 },
    );
  }

  const draft: Draft = {
    subject: (parsed.subject ?? "").toString().trim(),
    message: parsed.message.toString().trim(),
  };

  /* Subject AND body: a wrong figure in a subject line is the part the customer sees
     before opening anything. */
  const verdict = verifyDraftMoney(`${draft.subject}\n${draft.message}`, ctx.allowedAmounts);
  if (!verdict.ok) {
    console.error(
      `[ai/draft-reply] lead ${leadId}: REJECTED — unauthorised amount(s) ${verdict.violations.join(", ")}; ` +
      `allowed ${ctx.allowedAmounts.join(", ") || "(none)"}.`,
    );
    await logAiDecision(supabase, {
      action: "ai_blocked",
      entity: "leads",
      entityId: leadId,
      label: formatGuardBlock(verdict.violations, ctx.allowedAmounts),
    });
    /* Discarded, not corrected. The sentence around a wrong number was written to suit
       that number, so patching the figure leaves a paragraph arguing for it. */
    return NextResponse.json(
      { error: "The draft quoted a figure that is not on this deal, so it was discarded. Use a quick reply, or send the revised quotation first." },
      { status: 422 },
    );
  }

  return NextResponse.json({ ...draft, mode: "gemini" });
}
