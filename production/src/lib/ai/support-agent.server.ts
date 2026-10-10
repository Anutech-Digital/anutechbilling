/**
 * Server side of the AI support agent: identify the customer, read the thread, call the model,
 * write what happened back onto the ticket.
 *
 * The decisions live in `support-agent.ts` and are pure. This file is the IO around them, kept
 * thin on purpose — same split as autonomy.ts / autonomy.server.ts and sales-agent /
 * sales-agent.server, for the same reason: what the agent is ALLOWED to tell a customer is the
 * part that gets argued about, and arguing about it should not require a database.
 *
 * ─── WHY A BARE CLIENT FOR SOME OF THIS ─────────────────────────────────────
 * `ai_support_conversations` is not in the generated `Database` type, and neither are the nine
 * columns migration 20260824180000 adds to `support_tickets`. Registering a table is not the
 * two-line fix it sounds like: measured 23 Aug 2026 on `document_series`, adding ONE table to
 * the Tables map took `npm run typecheck` from 4 errors to 2,722, because supabase-js resolves
 * row types through a conditional chain that tips over the instantiation limit at this schema
 * size and collapses every table to `never`. So the new surface is reached through a
 * deliberately untyped client, in ONE file rather than at each call site — the pattern
 * `sales-agent.server.ts` and `autonomy.server.ts` already establish.
 *
 * `support_tickets`' EXISTING columns are typed (SupportTicketRow), and reads that only need
 * those go through the typed admin client, which is why both appear below.
 *
 * WITH NO GENERATED TYPES, NOTHING CHECKS THE TENANT FILTER. Every query here carries an
 * explicit `.eq("tenant_id", …)`, and that line is the entire boundary between one workspace's
 * support conversations and another's. `tenantId` always comes from the caller's resolved
 * context, never from a request body.
 */
import { createBareClient } from "@/lib/supabase/bare";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { resolveGeminiConfig, geminiJson } from "./gemini";
import {
  applyEscalationRules,
  buildSupportAgentPrompt,
  parseSupportDecision,
  MAX_CONTEXT_TURNS,
  type AuthorisedRecord,
  type SupportChannel,
  type SupportCustomerFacts,
  type SupportDecision,
  type SupportSubscriptionFact,
  type SupportTurn,
  type SupportTurnRole,
} from "./support-agent";

/**
 * `no-store` is not optional (CLAUDE.md §17). A cached thread read is a stale transcript, and
 * a stale transcript is how the agent asks the customer to run the same DNS check twice — the
 * failure this whole feature exists to prevent.
 */
function bare(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) return null;
  return createBareClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (u, o) => fetch(u, { ...o, cache: "no-store" }) },
  });
}

/* ── Who is writing ──────────────────────────────────────────────────────── */

interface CustomerRow {
  id: string | null;
  name: string | null;
  display_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  contact_mobile: string | null;
}

interface SubscriptionRow {
  plan: string | null;
  vendor: string | null;
  domain: string | null;
  seats: number | null;
  used: number | null;
  status: string | null;
  renewal_date: string | null;
  mrr: number | null;
}

/**
 * Match the sender to a customer, and read what they actually bought.
 *
 * ─── AN UNMATCHED SENDER IS A FACT, NOT A FAILURE ───────────────────────────
 * Anyone can write to support@. The agent is told plainly when the sender matches nobody, and
 * the prompt forbids it from stating account facts in that case. The alternative — guessing at
 * the nearest customer — would tell a stranger somebody else's plan, seat count and renewal
 * date, which is a data leak dressed as helpfulness (AGENTS.md L20 is the same mistake with a
 * hardcoded recipient).
 *
 * ─── WHY EMAIL IS MATCHED EXACTLY AND PHONE IS TRIED THREE WAYS ─────────────
 * Email is stored one way and arrives one way, lower-cased on both sides. A phone number does
 * not have that luxury: `customers` holds `contact_phone` and `contact_mobile` and neither is
 * normalised, so the same number appears as +919812345678, 919812345678 and 09812345678 across
 * real rows. Matching only the E.164 form would silently treat most WhatsApp senders as
 * strangers — measured behaviour of the data, not a hypothetical.
 *
 * DOMAIN MATCHING IS DELIBERATELY NOT DONE. It looks attractive — the sender is
 * someone@acme.in and `customers.domain` says acme.in — but the person writing may be any
 * employee, and answering an unknown employee with the account's commercial facts is exactly
 * the leak above. A person can link the ticket to the account if it is theirs.
 */
export async function loadSupportCustomerFacts(args: {
  admin: SupabaseClient<Database>;
  tenantId: string;
  channel: SupportChannel;
  customerContact: string;
  /** The name the channel gave us — a mail display name or a WhatsApp profile name. */
  fallbackName: string;
  ticketId: string | null;
  /** The tier already stamped on the ticket by `stamp_support_ticket_sla`, when there is one. */
  tier: "free" | "standard" | "enterprise" | null;
}): Promise<SupportCustomerFacts> {
  const { admin, tenantId, channel, customerContact } = args;

  const unmatched: SupportCustomerFacts = {
    ticketId: args.ticketId,
    customerName: args.fallbackName || customerContact,
    customerContact,
    channel,
    customerId: null,
    subscriptions: [],
    tier: args.tier,
  };

  const contact = customerContact.trim();
  if (!contact) return unmatched;

  let customer: CustomerRow | null = null;

  if (contact.includes("@")) {
    const { data, error } = await admin
      .from("customers")
      .select("id, name, display_name, contact_email, contact_phone, contact_mobile")
      .eq("tenant_id", tenantId)
      .ilike("contact_email", contact.toLowerCase())
      .limit(1)
      .maybeSingle();
    if (error) console.error("[support-agent] customer lookup by email failed:", error.message);
    customer = (data as CustomerRow | null) ?? null;
  } else {
    /* The three shapes the same Indian mobile appears in. `digits` is the last ten, which is
       the part that is stable across all of them. */
    const digits = contact.replace(/\D/g, "");
    const last10 = digits.slice(-10);
    if (last10.length === 10) {
      const { data, error } = await admin
        .from("customers")
        .select("id, name, display_name, contact_email, contact_phone, contact_mobile")
        .eq("tenant_id", tenantId)
        .or(`contact_phone.ilike.%${last10},contact_mobile.ilike.%${last10}`)
        .limit(1)
        .maybeSingle();
      if (error) console.error("[support-agent] customer lookup by phone failed:", error.message);
      customer = (data as CustomerRow | null) ?? null;
    }
  }

  if (!customer?.id) return unmatched;

  const { data: subRows, error: subErr } = await admin
    .from("subscriptions")
    .select("plan, vendor, domain, seats, used, status, renewal_date, mrr")
    .eq("tenant_id", tenantId)
    .eq("customer_id", customer.id)
    /* Cancelled subscriptions are excluded, expired ones are not. "My mail stopped working"
       from somebody whose subscription expired last week is answered BY that fact, and hiding
       it would send the agent looking for a DNS fault. A cancelled one is history. */
    .neq("status", "cancelled")
    .order("renewal_date", { ascending: true });

  if (subErr) console.error("[support-agent] subscription read failed:", subErr.message);

  const subscriptions = ((subRows ?? []) as SubscriptionRow[]).flatMap(
    (s): SupportSubscriptionFact[] => {
      if (!s.plan) return [];
      return [
        {
          plan: s.plan,
          vendor: s.vendor ?? "other",
          domain: s.domain ?? null,
          seats: typeof s.seats === "number" ? s.seats : 0,
          used: typeof s.used === "number" ? s.used : null,
          status: s.status ?? "unknown",
          renewalDate: s.renewal_date ?? null,
          /* Whole rupees, as everything in this schema is (AGENTS.md §1). */
          mrr: typeof s.mrr === "number" ? Math.round(s.mrr) : 0,
        },
      ];
    },
  );

  return {
    ticketId: args.ticketId,
    customerName: customer.display_name || customer.name || args.fallbackName || contact,
    customerContact: contact,
    channel,
    customerId: customer.id,
    subscriptions,
    tier: args.tier,
  };
}

/* ── The transcript ──────────────────────────────────────────────────────── */

interface TurnRow {
  role: string | null;
  message_content: string | null;
  channel: string | null;
}

function isRole(v: string | null): v is SupportTurnRole {
  return v === "user" || v === "agent" || v === "system";
}

function isChannel(v: string | null): v is SupportChannel {
  return v === "email" || v === "whatsapp" || v === "portal" || v === "app";
}

/**
 * The conversation so far, oldest first.
 *
 * Keyed on the TICKET when we have one and on the CONTACT when we do not — because a message
 * can arrive before the ticket insert has happened, and those early turns are exactly the ones
 * the next message needs as context. Both paths are tenant-filtered.
 *
 * Ordered newest-first in SQL and reversed here, because the limit has to keep the LAST
 * MAX_CONTEXT_TURNS. Ordering ascending with a limit would hand the model the opening of a
 * long thread and hide the part that matters.
 */
export async function loadSupportThread(args: {
  tenantId: string;
  ticketId: string | null;
  channel: SupportChannel;
  customerContact: string;
}): Promise<SupportTurn[]> {
  const db = bare();
  if (!db) return [];

  let q = db
    .from("ai_support_conversations")
    .select("role, message_content, channel")
    .eq("tenant_id", args.tenantId);

  q = args.ticketId
    ? q.eq("ticket_id", args.ticketId)
    : q.eq("channel", args.channel).eq("customer_contact", args.customerContact);

  const { data, error } = await q
    .order("created_at", { ascending: false })
    .limit(MAX_CONTEXT_TURNS);

  if (error) {
    console.error("[support-agent] thread read failed:", error.message);
    return [];
  }

  return ((data ?? []) as TurnRow[])
    .flatMap((r): SupportTurn[] => {
      if (!r.message_content || !isRole(r.role) || !isChannel(r.channel)) return [];
      return [{ role: r.role, content: r.message_content, channel: r.channel }];
    })
    .reverse();
}

/**
 * Append one turn to the transcript.
 *
 * Returns a boolean rather than throwing: the caller is a webhook that has already committed
 * the ticket and the message, and losing a captured support request to protect a transcript
 * row would be the wrong trade. A missing turn costs the NEXT reply some context; a failed
 * webhook costs the request outright.
 */
export async function recordSupportTurn(args: {
  tenantId: string;
  ticketId: string | null;
  channel: SupportChannel;
  customerContact: string;
  role: SupportTurnRole;
  content: string;
  intent?: string | null;
  resolutionStatus?: "resolved" | "more_info_needed" | "escalated" | "none" | null;
  confidence?: number | null;
}): Promise<boolean> {
  const db = bare();
  if (!db) return false;

  const { error } = await db.from("ai_support_conversations").insert({
    tenant_id: args.tenantId,
    ticket_id: args.ticketId,
    channel: args.channel,
    customer_contact: args.customerContact,
    role: args.role,
    message_content: args.content,
    intent: args.intent ?? null,
    resolution_status: args.resolutionStatus ?? null,
    confidence_score: args.confidence ?? null,
  });

  if (error) {
    console.error("[support-agent] turn insert failed:", error.message);
    return false;
  }
  return true;
}

/**
 * When the customer last wrote on this ticket. Null when they never have.
 *
 * Read from the transcript rather than from `support_tickets.updated_at`, because the ticket
 * row is touched by anything anybody does to it and this question is specifically about the
 * CUSTOMER — it is what stops the SLA cron closing a ticket under a reply.
 */
export async function lastCustomerMessageAt(args: {
  tenantId: string;
  ticketId: string;
}): Promise<Date | null> {
  const db = bare();
  if (!db) return null;

  const { data, error } = await db
    .from("ai_support_conversations")
    .select("created_at")
    .eq("tenant_id", args.tenantId)
    .eq("ticket_id", args.ticketId)
    .eq("role", "user")
    .order("created_at", { ascending: false })
    .limit(1);

  if (error) {
    console.error("[support-agent] last customer message read failed:", error.message);
    return null;
  }

  const at = ((data ?? []) as { created_at?: string }[])[0]?.created_at;
  return at ? new Date(at) : null;
}

/* ── Writing the outcome back onto the ticket ────────────────────────────── */

/**
 * The nine columns migration 20260824180000 adds, written through the bare client.
 *
 * ONE function rather than a call per field, and the reason is not tidiness: every one of
 * these writes is a tenant-scoped update on a table whose type does not know about the
 * columns, so each separate call site would be another place the `.eq("tenant_id", …)` could
 * be forgotten with nothing to catch it.
 */
export async function patchTicketAiFields(args: {
  tenantId: string;
  ticketId: string;
  fields: {
    status?: string;
    priority?: string;
    category?: string;
    channel?: SupportChannel;
    ai_escalated?: boolean;
    ai_escalation_reason?: string | null;
    ai_escalated_at?: string | null;
    ai_answered_at?: string | null;
    ai_awaiting_reply_since?: string | null;
    sla_alert_sent_at?: string | null;
    first_responded_at?: string | null;
    resolved_at?: string | null;
    resolution_note?: string | null;
  };
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const db = bare();
  if (!db) return { ok: false, error: "Supabase is not configured" };

  const { error } = await db
    .from("support_tickets")
    .update({ ...args.fields, updated_at: new Date().toISOString() })
    .eq("id", args.ticketId)
    .eq("tenant_id", args.tenantId);

  return error ? { ok: false, error: error.message } : { ok: true };
}

/**
 * Stamp `first_responded_at` only if it is not already set.
 *
 * ─── WHY A READ BEFORE THE WRITE INSTEAD OF A COALESCE ──────────────────────
 * This column is what the SLA is judged against (`slaState` in lib/support/tiers.ts reads it),
 * so overwriting it on the agent's SECOND reply would move the first response later and quietly
 * turn a met SLA into a missed one — or the reverse. The REST API cannot express
 * `set x = coalesce(x, now())`, so the check happens here, and it is a check rather than a
 * blind write for exactly that reason.
 */
export async function stampFirstResponse(args: {
  tenantId: string;
  ticketId: string;
  at: string;
}): Promise<void> {
  const db = bare();
  if (!db) return;

  const { data, error } = await db
    .from("support_tickets")
    .select("first_responded_at")
    .eq("id", args.ticketId)
    .eq("tenant_id", args.tenantId)
    .maybeSingle();

  if (error) {
    console.error("[support-agent] first-response read failed:", error.message);
    return;
  }
  if ((data as { first_responded_at?: string | null } | null)?.first_responded_at) return;

  const res = await patchTicketAiFields({
    tenantId: args.tenantId,
    ticketId: args.ticketId,
    fields: { first_responded_at: args.at },
  });
  if (!res.ok) console.error("[support-agent] first-response stamp failed:", res.error);
}

/* ── Running the agent ───────────────────────────────────────────────────── */

export type SupportAgentRun =
  | {
      ok: true;
      decision: SupportDecision;
      /** True when applyEscalationRules overruled the model. Goes into the audit log. */
      overruled: boolean;
      /** Why it was overruled, or "" when it was not. */
      overruleReason: string;
      /** Rupee figures the prompt authorised, carried out so the dispatcher can re-check. */
      allowedMoney: number[];
    }
  | { ok: false; reason: string };

/**
 * Record values this tenant has verified and the agent may therefore state verbatim.
 *
 * Returns EMPTY, always, and that is the honest current state rather than a stub: this repo
 * has no table of vendor DNS records, so there is nothing to read and the agent may state
 * none. It exists as a named seam so that the day a tenant records their own verified values,
 * the change is here — rather than the guard in `support-agent.ts` being loosened, which is
 * how a guard stops being one.
 *
 * NOT a "fail open" default (AGENTS.md §2 — a failure converted into a plausible value is
 * worse than the failure). Empty means "you may state nothing", the strict direction.
 */
export function loadAuthorisedRecords(): readonly AuthorisedRecord[] {
  return [];
}

/**
 * One turn of the agent: assemble context, ask the model, validate, apply the hard rules.
 *
 * Never throws. Every failure comes back as `{ ok: false, reason }` with a sentence a
 * non-engineer can act on, because that sentence is what gets written onto the ticket. "The
 * AI support agent has no Gemini key" is fixed on a settings page; "the agent failed" is fixed
 * by asking an engineer, and that difference is the whole reason `onFailure` exists in
 * gemini.ts.
 */
export async function runSupportAgent(args: {
  admin: SupabaseClient<Database>;
  tenantId: string;
  customer: SupportCustomerFacts;
  incoming: string;
  sellerName: string;
  supportEmail: string;
}): Promise<SupportAgentRun> {
  const cfg = await resolveGeminiConfig(args.admin, args.tenantId);
  if (!cfg.apiKey) {
    return {
      ok: false,
      reason:
        "The AI support agent has no Gemini key. Add one in Settings → Integrations → Gemini, " +
        "and the next message on this ticket will be answered.",
    };
  }

  const history = await loadSupportThread({
    tenantId: args.tenantId,
    ticketId: args.customer.ticketId,
    channel: args.customer.channel,
    customerContact: args.customer.customerContact,
  });

  const prompt = buildSupportAgentPrompt({
    customer: args.customer,
    history,
    incoming: args.incoming,
    sellerName: args.sellerName,
    supportEmail: args.supportEmail,
    authorisedRecords: loadAuthorisedRecords(),
  });

  let failure = "";
  const raw = await geminiJson<unknown>({
    apiKey: cfg.apiKey,
    model: cfg.model,
    system: prompt.system,
    user: prompt.user,
    /* Lower than the sales agent's 0.3. A support answer is a procedure, and the same problem
       should get the same steps — variety in a runbook is not a feature. */
    temperature: 0.2,
    label: "ai/support-agent",
    onFailure: (r) => {
      failure = r;
    },
  });

  if (raw === null) {
    return { ok: false, reason: failure || "The AI did not answer, and gave no reason." };
  }

  const parsed = parseSupportDecision(raw);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };

  const ruled = applyEscalationRules({
    decision: parsed.decision,
    incoming: args.incoming,
    allowedMoney: prompt.allowedMoney,
    authorisedRecords: prompt.authorisedRecords,
    /* The renewal dates the prompt showed it. Carried through rather than re-derived so the
       rules can only ever authorise what the model was actually told. */
    allowedDates: prompt.allowedDates,
  });

  return {
    ok: true,
    decision: ruled.decision,
    overruled: ruled.overruled,
    overruleReason: ruled.reason,
    allowedMoney: prompt.allowedMoney,
  };
}
