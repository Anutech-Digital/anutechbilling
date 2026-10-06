/**
 * POST /api/campaigns/send
 *
 * Bulk email campaign to leads. Audience filtered by stage / source /
 * search. Each recipient gets a personalized email with template
 * substitutions ({{name}}, {{company}}, {{offer_code}}, {{discount}},
 * {{expires}}).
 *
 * Idempotent per (campaign, recipient): each campaign_sends row has a
 * UNIQUE constraint, so re-running won't duplicate.
 *
 * Body:
 *   {
 *     name, subject, body,
 *     audience: { stages?: string[]; sources?: string[]; search?: string },
 *     offer?: { code: string; discount_pct: number; expires_at: string }
 *   }
 *
 * Returns:
 *   { campaignId, recipientsCount, sentCount, failedCount, mode }
 */

import { NextResponse } from "next/server";
import { replyToAddress } from "@/lib/email/reply-to";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/server";
import { ACTION_ROLES, forbiddenMessage } from "@/lib/auth/action-roles";
import { withRoute, dbFail } from "@/lib/api/with-route";
import { sendEmail, isEmailConfigured } from "@/lib/email/send";
import { unsubscribeUrl, unsubscribeFooter, normaliseEmail } from "@/lib/marketing/unsubscribe-token";
import { fillName, greetingName, NO_NAME } from "@/lib/marketing/greeting-name";
import { cleanPitch } from "@/lib/leads/lead-finder";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const schema = z.object({
  name:      z.string().min(2).max(120),
  subject:   z.string().min(2).max(200),
  body:      z.string().min(10).max(20000),
  body_html: z.string().max(200000).optional(),       // optional HTML version
  audience: z.object({
    stages:  z.array(z.string()).optional(),
    sources: z.array(z.string()).optional(),
    search:  z.string().optional(),
  }).default({}),
  // Explicit, hand-picked recipients (e.g. from the Contacts page selection).
  // When present, this OVERRIDES the audience filter.
  recipients: z.array(z.object({
    email:   z.string().email(),
    name:    z.string().optional(),
    company: z.string().optional(),
  })).max(2000).optional(),
  offer: z.object({
    code:         z.string().min(1).max(50),
    discount_pct: z.coerce.number().min(0).max(100),
    expires_at:   z.string().min(10),
  }).optional(),
});

function applyTemplate(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? `{{${key}}}`);
}

/* R-217 (R-051): withRoute() does sign-in, tenant, the role gate (ACTION_ROLES
   "campaign.send" = owner/manager) and the zod body in one place — a sales/support user
   gets 403 before a single lead is read or a mail goes out. */
export const POST = withRoute(
  {
    route: "api/campaigns/send",
    input: schema,
    roles: ACTION_ROLES["campaign.send"],
    roleHint: forbiddenMessage("campaign.send"),
  },
  async ({ req, input, user, tenantId }) => {
  const me = { tenant_id: tenantId };

  const { name, subject, body: bodyTemplate, body_html: htmlTemplate, audience, offer, recipients: explicitRecipients } = input;
  const admin = createAdminClient();

  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  // ── 1. Resolve recipients ─────────────────────────────────────
  // Two modes: an explicit hand-picked list (Contacts page), or the audience
  // filter over leads. Normalise both to { lead_id, contact_name, contact_email, company }.
  type Recipient = { lead_id: string | null; contact_name: string | null; contact_email: string; company: string | null };
  let recipients: Recipient[];

  if (explicitRecipients && explicitRecipients.length > 0) {
    // Dedupe by email; keep only valid addresses.
    const seen = new Set<string>();
    recipients = [];
    for (const r of explicitRecipients) {
      const email = r.email.trim().toLowerCase();
      if (!emailRe.test(email) || seen.has(email)) continue;
      seen.add(email);
      recipients.push({ lead_id: null, contact_name: r.name ?? null, contact_email: r.email.trim(), company: r.company ?? null });
    }
  } else {
    let leadsQuery = admin
      .from("leads")
      .select("id, contact_name, contact_email, company, stage, source")
      .eq("tenant_id", me.tenant_id)
      .not("contact_email", "is", null);

    if (audience.stages && audience.stages.length > 0) {
      leadsQuery = leadsQuery.in("stage", audience.stages as ("new"|"contact"|"demo"|"trial"|"quote"|"won"|"lost")[]);
    }
    if (audience.sources && audience.sources.length > 0) {
      leadsQuery = leadsQuery.in("source", audience.sources);
    }
    if (audience.search && audience.search.trim()) {
      const q = audience.search.trim();
      leadsQuery = leadsQuery.or(`company.ilike.%${q}%,contact_name.ilike.%${q}%`);
    }

    const { data: leads, error: leadsErr } = await leadsQuery;
    dbFail(leadsErr, "Leads padhe nahi gaye — thodi der baad dobara try kariye.");
    recipients = (leads ?? [])
      .filter((l) => l.contact_email && emailRe.test(l.contact_email))
      .map((l) => ({ lead_id: l.id, contact_name: l.contact_name, contact_email: l.contact_email!, company: l.company }));
  }

  /* Opted out (migration 20260926190000): never mailed again, whichever list they are
     picked from. Skipped silently per person, reported as a count. */
  const { data: suppressed } = await (admin as unknown as { from: (t: string) => any })  // eslint-disable-line @typescript-eslint/no-explicit-any
    .from("email_suppressions").select("email").eq("tenant_id", me.tenant_id);
  const optedOut = new Set(((suppressed ?? []) as { email: string }[]).map((r) => r.email));
  const beforeOptOut = recipients.length;
  recipients = recipients.filter((r) => !optedOut.has(normaliseEmail(r.contact_email)));
  const skippedOptOut = beforeOptOut - recipients.length;

  if (recipients.length === 0) {
    return NextResponse.json(
      { error: skippedOptOut > 0
          ? `Sab ${skippedOptOut} recipients ne unsubscribe kiya hua hai — kisi ko mail nahi gaya.`
          : "No recipients with a valid email — adjust the selection or filter" },
      { status: 400 }
    );
  }

  // ── 2. Tenant brand info for signature ────────────────────────
  const { data: tenant } = await admin
    .from("tenants")
    .select("name, email, phone")
    .eq("id", me.tenant_id)
    .single();
  /* Wo mailbox jise app PADHTI hai. Reply-To wahi hona chahiye — 31 Aug 2026 ko
     tenants.email par bheja gaya jawab kisi ko dikha hi nahi. lib/email/reply-to.ts. */
  const { data: ingestBoxes } = await admin
    .from("user_google_tokens").select("google_email").eq("tenant_id", me.tenant_id);

  const senderName = tenant?.name ?? "Your team";
  /* Unsubscribe links need an absolute host. The configured app URL, else this request's
     own origin — a campaign is always sent from the app, so that origin serves /unsubscribe. */
  const appUrl = process.env.NEXT_PUBLIC_APP_URL?.trim() || req.nextUrl.origin;

  // ── 3. Allocate campaign ID + insert campaign row ─────────────
  const { data: campaignIdRaw, error: numErr } = await admin
    .rpc("next_document_number", { p_doc_type: "campaign", p_tenant_id: me.tenant_id });
  if (numErr || !campaignIdRaw) {
    return NextResponse.json({ error: "Could not allocate campaign number" }, { status: 500 });
  }
  const campaignId = campaignIdRaw as unknown as string;

  const { error: insertErr } = await admin.from("campaigns").insert({
    id:                 campaignId,
    tenant_id:          me.tenant_id,
    name,
    subject,
    body:               bodyTemplate,
    body_html:          htmlTemplate ?? null,
    audience_filter:    audience,
    offer_code:         offer?.code ?? null,
    offer_discount_pct: offer?.discount_pct ?? null,
    offer_expires_at:   offer?.expires_at ?? null,
    recipients_count:   recipients.length,
    sent_count:         0,
    failed_count:       0,
    status:             "sending",
    created_by:         user.id,
  });
  dbFail(insertErr, "Campaign save nahi hua — thodi der baad dobara try kariye.");

  // ── 4. Per-recipient dispatch loop ────────────────────────────
  const fromAddress = process.env.RESEND_FROM_DEFAULT?.trim() || "ResellerOS <onboarding@resend.dev>";
  const emailMode   = isEmailConfigured() ? "real" : "stub";

  const offerExpiresFmt = offer?.expires_at
    ? new Date(offer.expires_at).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })
    : "";

  let sent   = 0;
  let failed = 0;

  /* {{pitch}} — the AI Lead Finder's one-line pitch for that company (29 Sep 2026). Only
     leads that came from the finder have one; for the rest it is empty, so a template that
     uses it should read fine without it. */
  const pitchByLead = new Map<string, string>();
  const usesPitch = [subject, bodyTemplate, htmlTemplate ?? ""].some((t) => t.includes("{{pitch}}"));
  const leadIds = recipients.map((r) => r.lead_id).filter((x): x is string => !!x);
  if (usesPitch && leadIds.length) {
    const { data: cands } = await admin.from("lead_finder_candidates").select("lead_id, pitch").eq("tenant_id", me.tenant_id).in("lead_id", leadIds);
    for (const c of cands ?? []) if (c.lead_id && c.pitch) pitchByLead.set(c.lead_id, c.pitch);
  }

  for (const r of recipients) {
    // {{name}} is filled first (fillName): "Dr. Kopal", or "Sir/Ma'am" without the "ji" after it.
    const firstName = greetingName(r.contact_name) ?? NO_NAME;
    const pitch = cleanPitch(r.lead_id ? pitchByLead.get(r.lead_id) ?? "" : "");
    const vars = {
      name:       firstName,
      company:    r.company || "",
      offer_code: offer?.code ?? "",
      discount:   offer ? String(offer.discount_pct) : "",
      expires:    offerExpiresFmt,
      sender:     senderName,
      pitch,
    };

    /* Every campaign mail carries a way out (lib/marketing/unsubscribe-token.ts). */
    const unsub  = unsubscribeUrl(appUrl, me.tenant_id, r.contact_email, campaignId);
    const footer = unsub ? unsubscribeFooter(unsub, senderName) : null;
    const renderedBody    = applyTemplate(fillName(bodyTemplate, r.contact_name), vars) + (footer?.text ?? "");
    const renderedSubject = applyTemplate(fillName(subject, r.contact_name),      vars);
    // The pitch is model-written text: escape it before it goes into HTML.
    const htmlVars        = { ...vars, pitch: pitch.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") };
    const renderedHtml    = htmlTemplate ? applyTemplate(fillName(htmlTemplate, r.contact_name), htmlVars) + (footer?.html ?? "") : undefined;

    let sendStatus: "sent" | "failed" | "stubbed" = "sent";
    let providerId: string | null = null;
    let errorMessage: string | null = null;

    try {
      const result = await sendEmail({
        to:      r.contact_email,
        from:    fromAddress,
        replyTo: replyToAddress(ingestBoxes, tenant?.email),
    route:   { tenantId: me.tenant_id },
        subject: renderedSubject,
        text:    renderedBody,
        html:    renderedHtml,
      });
      if (result.status === "failed") {
        sendStatus = "failed";
        errorMessage = result.errorMessage ?? "Unknown failure";
        failed++;
      } else if (result.status === "stubbed") {
        sendStatus = "stubbed";
        providerId = result.providerId ?? null;
        sent++;
      } else {
        sendStatus = "sent";
        providerId = result.providerId ?? null;
        sent++;
      }
    } catch (e) {
      sendStatus = "failed";
      errorMessage = e instanceof Error ? e.message : String(e);
      failed++;
    }

    await admin.from("campaign_sends").insert({
      tenant_id:       me.tenant_id,
      campaign_id:     campaignId,
      lead_id:         r.lead_id,
      recipient_email: r.contact_email,
      recipient_name:  r.contact_name,
      status:          sendStatus,
      provider_id:     providerId,
      error_message:   errorMessage,
      sent_at:         sendStatus === "failed" ? null : new Date().toISOString(),
    });
  }

  // ── 5. Finalize campaign status ───────────────────────────────
  const finalStatus = failed === recipients.length
    ? "failed"
    : "sent";

  await admin
    .from("campaigns")
    .update({
      status:       finalStatus,
      sent_count:   sent,
      failed_count: failed,
      sent_at:      new Date().toISOString(),
    })
    .eq("id", campaignId);

  return {
    campaignId,
    recipientsCount: recipients.length,
    skippedOptOut,
    sentCount:       sent,
    failedCount:     failed,
    mode:            emailMode,
    status:          finalStatus,
  };
  },
);
