/**
 * POST /api/ai/draft-followup
 *
 * AI auto-draft (Roadmap Step 1) — drafts a short message for a LEAD or a
 * CUSTOMER (WhatsApp or email). ZERO money-write: it only returns editable
 * text; the operator reviews + sends via the existing WhatsApp/email actions.
 *
 * Two modes (exactly one of leadId / customerId):
 *   - leadId   → sales follow-up to a prospect (purpose 'followup')
 *   - customerId → either a warm check-in ('followup') or a polite payment
 *                  reminder ('reminder') for an existing customer.
 *
 * MONEY-HONESTY: when a money figure (outstanding balance) is relevant we pass
 * the REAL number in context and instruct the model to use it verbatim and
 * never invent/alter figures. The operator still edits before sending
 * (human-in-the-loop) — the draft is never sent automatically.
 *
 * Tenant-safe: the lead/customer is fetched via the operator's SESSION client
 * (RLS), so a user can only draft for their own tenant's records. Uses Gemini
 * Flash with a stub fallback (works even before GEMINI_API_KEY is set).
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { resolveGeminiConfig, geminiJson } from "@/lib/ai/gemini";
import { verifyDraftMoney } from "@/lib/ai/money-guard";
import { logAiDecision, formatGuardBlock } from "@/lib/ai/audit";
import { rupee } from "@/lib/utils";
import { stubDraft, type Draft } from "@/lib/ai/stub-draft";

const bodySchema = z
  .object({
    leadId: z.string().min(1).optional(),
    customerId: z.string().min(1).optional(),
    channel: z.enum(["whatsapp", "email"]).default("whatsapp"),
    purpose: z.enum(["followup", "reminder", "renewal"]).default("followup"),
  })
  .refine((d) => !!d.leadId !== !!d.customerId, {
    message: "Provide exactly one of leadId or customerId.",
  });

/**
 * Draft via Gemini, then VERIFY the money in what came back.
 *
 * `allowedAmounts` is the set of rupee figures this route computed and put in the
 * prompt. The prompt also tells the model to use them verbatim — but that is a
 * request, not a constraint, and a restated ₹4,500 as ₹45,000 used to reach the
 * operator unchecked. A fluent, plausible payment reminder for money the customer
 * does not owe is the worst thing this feature could produce.
 *
 * So a draft containing any unauthorised figure is DISCARDED, and the caller
 * falls back to the deterministic stub — which builds its text from the same
 * numbers and cannot be wrong about them. Silently correcting the figure would be
 * worse: the sentence around it was written to suit the wrong number.
 */
/**
 * Why a draft did not come back. "AI was unavailable" and "AI said something
 * about money it was not allowed to say" are different events with different
 * meanings for the operator, and collapsing both into `null` made the second
 * one — the one worth investigating — indistinguishable from a quiet outage.
 */
type DraftOutcome =
  | { ok: true; draft: Draft }
  | { ok: false; reason: "unavailable" }
  | { ok: false; reason: "blocked"; violations: string[] };

async function draftWithGemini(
  apiKey: string, model: string, channel: "whatsapp" | "email",
  intent: string, ctx: string, allowedAmounts: number[],
): Promise<DraftOutcome> {
  const system =
    "You are the assistant for an Indian cloud-software reseller (Google Workspace, " +
    "Microsoft 365, Zoho). " +
    intent +
    " " +
    (channel === "whatsapp"
      ? "Channel = WhatsApp: 2-4 short lines, friendly, Hinglish is fine, no greeting-heavy formality, end with a soft question/CTA. Leave subject empty."
      : "Channel = Email: a concise professional email with a clear subject line. Indian SME tone.") +
    " CRITICAL: never invent or change any amount, price, discount, date, or claim — use ONLY the figures given in context, verbatim. " +
    'Return ONLY JSON: {"subject": string, "message": string}.';
  const user = `Context:\n${ctx}\n\nDraft the ${channel} message now.`;

  // geminiJson carries the timeout and the circuit breaker, and returns null on
  // every failure path — so an AI outage degrades to the stub instead of hanging.
  const p = await geminiJson<Partial<Draft>>({
    apiKey, model, system, user, temperature: 0.7, label: "ai/draft-followup",
  });
  if (!p?.message) return { ok: false, reason: "unavailable" };

  const draft: Draft = { subject: (p.subject ?? "").toString(), message: p.message.toString() };

  // ── Code validates ──────────────────────────────────────────────────────
  // Subject and body both, because a wrong figure in a subject line is the part
  // a customer sees before opening anything.
  const verdict = verifyDraftMoney(`${draft.subject}\n${draft.message}`, allowedAmounts);
  if (!verdict.ok) {
    console.error(
      `[ai/draft-followup] REJECTED draft — unauthorised amount(s) ${verdict.violations.join(", ")}; ` +
      `allowed ${allowedAmounts.join(", ") || "(none)"}. Falling back to the deterministic draft.`,
    );
    return { ok: false, reason: "blocked", violations: verdict.violations };
  }
  return { ok: true, draft };
}

/**
 * Resolve an outcome into the draft to return, recording anything the operator
 * would want to know about. Audit failures never affect the returned draft.
 */
async function settle(
  client: Awaited<ReturnType<typeof createClient>>,
  outcome: DraftOutcome | null,
  fallback: Draft,
  audit: { entity: string; entityId: string; allowed: number[]; aiConfigured: boolean },
): Promise<Draft & { mode: "gemini" | "stub" }> {
  if (outcome?.ok) return { ...outcome.draft, mode: "gemini" };

  if (outcome && !outcome.ok && outcome.reason === "blocked") {
    await logAiDecision(client, {
      action: "ai_blocked",
      entity: audit.entity,
      entityId: audit.entityId,
      label: formatGuardBlock(outcome.violations, audit.allowed),
    });
  } else if (audit.aiConfigured) {
    // Only worth a row when AI was SUPPOSED to run. A tenant with no Gemini key
    // gets the stub by design, and logging that on every draft would be noise.
    await logAiDecision(client, {
      action: "ai_fallback",
      entity: audit.entity,
      entityId: audit.entityId,
      label: "AI unavailable (error, timeout or breaker) — sent the standard draft",
    });
  }

  return { ...fallback, mode: "stub" };
}

export async function POST(request: NextRequest) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  let parsed;
  try {
    parsed = bodySchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  // Resolve the tenant's Gemini config (tenant key → env → stub). RLS scopes
  // the tenant_secrets read to this user's tenant.
  const { data: me } = await supabase.from("users").select("tenant_id").eq("id", user.id).maybeSingle();
  const gemini = await resolveGeminiConfig(supabase, me?.tenant_id ?? null);

  /* Who the draft is FROM. The stub's three email variants used to end
     "Thanks,\nDemo Co" — a hardcoded company in text the operator sends to
     their own customer, and a company this tenant no longer is (CLAUDE.md §1). Read
     through the session client, so RLS scopes it to the caller's own tenant.

     An empty name is passed through as empty rather than substituted: stubDraft omits
     the sign-off line entirely, which is lib/whatsapp.ts's rule — no name beats the
     wrong name. */
  const { data: myTenant } = await supabase
    .from("tenants")
    .select("name")
    .eq("id", me?.tenant_id ?? "")
    .maybeSingle();
  const signOff = (myTenant as { name?: string | null } | null)?.name?.trim() ?? "";

  // ── Lead mode ───────────────────────────────────────────────────────────
  if (parsed.leadId) {
    const { data: lead, error } = await supabase
      .from("leads")
      .select("id, company, contact_name, plan, seats, value, stage, notes, follow_up_date")
      .eq("id", parsed.leadId)
      .maybeSingle();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!lead) return NextResponse.json({ error: "Lead not found." }, { status: 404 });

    const ctx = [
      `Recipient is a SALES PROSPECT (not yet a customer).`,
      `Company: ${lead.company}`,
      lead.contact_name ? `Contact: ${lead.contact_name}` : null,
      lead.plan ? `Interested in: ${lead.plan}` : null,
      lead.seats ? `Seats: ${lead.seats}` : null,
      lead.value ? `Est. value: ${rupee(lead.value)}` : null,
      `Stage: ${lead.stage}`,
      lead.notes ? `Notes: ${lead.notes.slice(0, 600)}` : null,
    ].filter(Boolean).join("\n");

    const intent = "Draft a SHORT, warm, professional sales follow-up to a prospect. Reference what we know about them.";
    // The estimated deal value is the only figure in this prompt, so it is the
    // only one the draft may state. Anything else is invented.
    const allowed = lead.value ? [lead.value] : [];
    const ai = gemini.apiKey
      ? await draftWithGemini(gemini.apiKey, gemini.model, parsed.channel, intent, ctx, allowed)
      : null;
    const settled = await settle(supabase, ai, stubDraft({
      channel: parsed.channel,
      firstName: (lead.contact_name || lead.company).split(/\s+/)[0],
      company: lead.company,
      planLabel: lead.plan ? lead.plan.replace(/^google-workspace-/, "Google Workspace ") : "the plan we discussed",
      purpose: "followup",
      outstanding: 0,
      signOff,
    }), { entity: "leads", entityId: lead.id, allowed, aiConfigured: Boolean(gemini.apiKey) });
    return NextResponse.json(settled);
  }

  // ── Customer mode ─────────────────────────────────────────────────────────
  const { data: customer, error: cErr } = await supabase
    .from("customers")
    .select("id, name, contact_name, contact_email, contact_phone")
    .eq("id", parsed.customerId!)
    .maybeSingle();
  if (cErr) return NextResponse.json({ error: cErr.message }, { status: 500 });
  if (!customer) return NextResponse.json({ error: "Customer not found." }, { status: 404 });

  // Real subscription context (RLS-scoped) — outstanding + plan for the draft.
  const { data: subs } = await supabase
    .from("subscriptions")
    .select("plan, status, outstanding_amount, renewal_date")
    .eq("customer_id", customer.id);
  const outstanding = (subs ?? []).reduce((s, x) => s + (x.outstanding_amount ?? 0), 0);
  const activePlan = (subs ?? []).find((s) => s.status === "active")?.plan ?? (subs ?? [])[0]?.plan ?? null;
  const planLabel = activePlan ? activePlan.replace(/^google-workspace-/, "Google Workspace ") : "your subscription";
  // Soonest upcoming renewal (fallback to the earliest on file) — for renewal nudges.
  const today = new Date().toISOString().slice(0, 10);
  const renewalDates = (subs ?? []).map((s) => s.renewal_date).filter(Boolean) as string[];
  const renewalDate = renewalDates.filter((d) => d >= today).sort()[0] ?? renewalDates.sort()[0] ?? null;

  const ctx = [
    `Recipient is an EXISTING CUSTOMER.`,
    `Company: ${customer.name}`,
    customer.contact_name ? `Contact: ${customer.contact_name}` : null,
    activePlan ? `Subscription: ${activePlan}` : null,
    parsed.purpose === "reminder" ? `Outstanding balance (use EXACTLY this, do not change): ${rupee(outstanding)}` : null,
    parsed.purpose === "renewal" && renewalDate ? `Renewal date (use EXACTLY this, do not change): ${renewalDate}` : null,
    parsed.purpose === "renewal" && outstanding > 0 ? `Outstanding on account (use EXACTLY this): ${rupee(outstanding)}` : null,
  ].filter(Boolean).join("\n");

  const intent = parsed.purpose === "reminder"
    ? "Draft a SHORT, polite, warm PAYMENT REMINDER. State the exact outstanding amount given, offer help/a payment link, and keep it friendly (not aggressive)."
    : parsed.purpose === "renewal"
      ? "Draft a SHORT, warm RENEWAL nudge. Mention the exact renewal date given, encourage timely renewal to avoid service interruption, and offer to send the renewal quote. Do not invent prices."
      : "Draft a SHORT, warm relationship CHECK-IN with an existing customer. No selling pressure; offer help with seats/renewals/support.";

  // Only the outstanding balance was given to the model, so only it may appear.
  // A reminder is the highest-stakes draft here — it asks a real customer for a
  // specific sum. The guard's bare-number sweep is deliberately NOT enabled even
  // so: with any useful floor it would flag a year ("renew in 2026") or a phone
  // number as a monetary claim, and a guard that cries wolf on ordinary drafts is
  // one somebody turns off. Currency-marked figures are what a model produces
  // when it restates a number from context, and those are checked strictly.
  const allowed = outstanding > 0 ? [outstanding] : [];
  const ai = gemini.apiKey
    ? await draftWithGemini(gemini.apiKey, gemini.model, parsed.channel, intent, ctx, allowed)
    : null;
  const settled = await settle(supabase, ai, stubDraft({
    channel: parsed.channel,
    firstName: (customer.contact_name || customer.name).split(/\s+/)[0],
    company: customer.name,
    planLabel,
    purpose: parsed.purpose,
    outstanding,
    renewalDate,
    signOff,
  }), { entity: "customers", entityId: customer.id, allowed, aiConfigured: Boolean(gemini.apiKey) });
  return NextResponse.json(settled);
}
