/**
 * Drafts a reply to a lead, server-side, with no session.
 *
 * ─── NOT A COPY OF `api/leads/[id]/draft-reply` ─────────────────────────────
 * That route does three things: authenticate a session, build a context, and call Gemini.
 * Only the first is unavailable to a webhook, and the other two are already shared libs —
 * `buildReplyContext` and `geminiJson`. So this calls the same two functions the route
 * calls rather than reimplementing either, and the one piece of logic that exists here and
 * not there is the fetch of the thread, because the route gets it from its own query and a
 * webhook does not.
 *
 * The route is deliberately left alone. It has no tests, it is the path a person uses today,
 * and extracting its middle would risk a working feature to save an import — the same call
 * made for send-auto-quote and recorded as AGENTS.md L58.
 *
 * ─── IT REPORTS WHY IT COULD NOT DRAFT ──────────────────────────────────────
 * Four different failures — no thread, nothing from the customer, no Gemini key, Gemini
 * silent — and they mean different things to whoever reads the log. "Draft failed" would
 * flatten "this workspace has not configured AI" into "the model is down", and one of those
 * is fixed by a settings page.
 *
 * `usedTemplate` is always false: there is no template fallback here on purpose. A generic
 * reply is fine for a person to adapt and wrong to send unattended, and `decideAutoReply`
 * refuses one anyway — so producing one would only invite somebody to relax that rule.
 */
import { createBareClient } from "@/lib/supabase/bare";
import { buildReplyContext, REPLY_SYSTEM_PROMPT, type ThreadTurn } from "./reply-context";
import { geminiJson, resolveGeminiConfig } from "./gemini";
import { buildEmailThread, summariseThread } from "@/lib/leads/email-thread";
import { factsSuperseded } from "@/lib/leads/email-thread";

export interface DraftedReply {
  subject: string;
  message: string;
  /** Always false — see the header. Kept so the caller's gate reads explicitly. */
  usedTemplate: boolean;
  /** The newest message in the thread came from the customer. */
  theyWroteLast: boolean;
}

export type DraftReplyOutcome =
  | { ok: true; draft: DraftedReply }
  | { ok: false; reason: string };

function bare() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) return null;
  return createBareClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (u, o) => fetch(u, { ...o, cache: "no-store" }) },
  });
}

export async function draftReplyForLead(args: {
  tenantId: string;
  leadId: string;
}): Promise<DraftReplyOutcome> {
  const db = bare();
  if (!db) return { ok: false, reason: "Supabase is not configured on the server" };

  /* Every message on the lead, both directions — `inbound_emails` holds our sent copies too
     (lib/inbound/sent.ts explains why a reply lives in the same table as the mail it
     answers). Tenant filter is explicit because this client is untyped and nothing checks
     it for me. */
  const { data: rows, error: rowsErr } = await db
    .from("inbound_emails")
    .select("id, lead_id, status, from_email, to_email, subject, body_text, body_html, created_at")
    .eq("tenant_id", args.tenantId)   // <- the only tenant boundary on this read
    .eq("lead_id", args.leadId)
    .order("created_at", { ascending: true });

  if (rowsErr) return { ok: false, reason: "could not read the email thread" };

  const thread = buildEmailThread((rows ?? []) as never[], args.leadId);
  if (thread.length === 0) return { ok: false, reason: "there are no emails on this lead to reply to" };

  const summary = summariseThread(thread);
  const theyWroteLast = summary.latest?.direction === "inbound";

  const { data: leadRow } = await db
    .from("leads")
    .select("company, contact_name, plan, seats")
    .eq("id", args.leadId)
    .eq("tenant_id", args.tenantId)
    .maybeSingle();
  const lead = (leadRow ?? {}) as {
    company?: string | null; contact_name?: string | null;
    plan?: string | null; seats?: number | null;
  };

  /* Only a SENT quote counts as an authorised figure. A draft the customer has never seen is
     not a number we may repeat to them — the money guard's allow-list is built from this. */
  const { data: quoteRow } = await db
    .from("quotes")
    .select("id, amount, status")
    .eq("lead_id", args.leadId)
    .eq("tenant_id", args.tenantId)
    .in("status", ["sent", "viewed", "accepted"])
    .order("created_date", { ascending: false })
    .limit(1)
    .maybeSingle();
  const sentQuote = quoteRow as { id?: string; amount?: number | null } | null;

  /* Read, never hardcoded. AGENTS.md L20 exists because a customer-facing draft once signed
     off as a company that did not own the storefront it went out from. Null when the row has
     no name — buildReplyContext leaves the sign-off out rather than inventing one. */
  const { data: tenantRow } = await db
    .from("tenants").select("name").eq("id", args.tenantId).maybeSingle();
  const tenantName = ((tenantRow ?? {}) as { name?: string | null }).name?.trim() || null;

  const ctx = buildReplyContext({
    thread: thread.map<ThreadTurn>((m) => ({ direction: m.direction, at: m.at ?? null, body: m.body ?? "" })),
    facts: {
      /* The TENANT's name for the sign-off, never a hardcoded company — L20 exists because
         a draft once signed off as a company that did not own the storefront. */
      sellerName:   tenantName,
      customerName: lead.contact_name ?? lead.company ?? null,
      seats:        lead.seats ?? null,
      plan:         lead.plan ?? null,
      /* Same rule the reply pills use: more than one inbound message means the stored
         requirement may be a snapshot of the first enquiry. Without this the drafter can
         restate figures the customer has already corrected — which happened on 22 Aug 2026
         and is why factsSuperseded exists. */
      factsUnconfirmed: factsSuperseded({ thread }),
      quote: sentQuote?.id && (sentQuote.amount ?? 0) > 0
        ? { id: sentQuote.id, amount: sentQuote.amount as number }
        : null,
    },
  });

  if (ctx.blocked) return { ok: false, reason: ctx.blocked };

  const gemini = await resolveGeminiConfig(db as never, args.tenantId);
  if (!gemini.apiKey) {
    /* Distinct from "the model was silent" — this one is fixed on a settings page, and
       flattening the two would send somebody to check an outage that is not happening. */
    return { ok: false, reason: "AI drafting is not configured for this workspace" };
  }

  /* Google says WHY in every failure body, and until 24 Aug 2026 we threw it away and wrote
     "the AI did not return a reply" instead. That one sentence stood for four different
     faults in a single day — billing disabled, model retired, upstream busy, daily quota
     exhausted — and it pointed at none of them. Captured now and passed through, so the
     lead timeline and ai_action_log carry the actionable reason. */
  let failure: string | null = null;
  const parsed = await geminiJson<{ subject?: string; message?: string }>({
    apiKey: gemini.apiKey,
    model: gemini.model,
    system: REPLY_SYSTEM_PROMPT,
    user: ctx.contextText,
    temperature: 0.6,
    label: "ai/auto-reply",
    onFailure: (why) => { failure = why; },
  });

  if (!parsed?.message) {
    return { ok: false, reason: failure ?? "the AI returned nothing, and gave no reason" };
  }

  return {
    ok: true,
    draft: {
      subject: (parsed.subject ?? "").toString().trim(),
      message: parsed.message.toString().trim(),
      usedTemplate: false,
      theyWroteLast,
    },
  };
}
