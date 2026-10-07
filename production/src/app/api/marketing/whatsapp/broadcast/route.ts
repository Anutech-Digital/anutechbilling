/**
 * POST /api/marketing/whatsapp/broadcast
 *   { templateId, audience: { stages?: string[]; sources?: string[] }, dryRun?: boolean }
 *
 * Sends one approved WhatsApp template to every lead in the audience that has a mobile
 * number and has not opted out. Each send goes through sendWhatsApp, which logs it in
 * whatsapp_messages; this route records the batch in whatsapp_broadcasts.
 *
 * dryRun returns the count that WOULD be sent and a sample, and sends nothing — the page
 * shows it before the confirm.
 *
 * Refuses, sending nothing, when WhatsApp is not connected for the company (409), the
 * template is not approved, or the audience is empty. Capped at MAX_PER_RUN so one click
 * cannot run past the request time or burn the number's quality rating.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/server";
import { withRoute, RouteError, dbFail } from "@/lib/api/with-route";
import { ACTION_ROLES, forbiddenMessage } from "@/lib/auth/action-roles";
import { sendWhatsApp, resolveWhatsAppCreds } from "@/lib/whatsapp/client";
import {
  slotValues, bodyComponents, renderBody, normalizeWaPhone, firstName, templateProblem,
} from "@/lib/marketing/whatsapp-broadcast";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

const MAX_PER_RUN = 250;

const schema = z.object({
  templateId: z.string({ message: "Template aur audience chuno." }).uuid("Template aur audience chuno."),
  audience: z.object({ stages: z.array(z.string()).optional(), sources: z.array(z.string()).optional() }).default({}),
  dryRun: z.boolean().optional(),
});

type Stage = "new" | "contact" | "demo" | "trial" | "quote" | "won" | "lost";

/* R-051: a broadcast reaches every lead at once — same gate as a campaign send. The page was
   owner/manager-only in nav, but the API took any signed-in member, so a sales login could
   POST here directly. */
export const POST = withRoute({
  route: "api/marketing/whatsapp/broadcast",
  input: schema,
  roles: ACTION_ROLES["campaign.send"],
  roleHint: forbiddenMessage("campaign.send"),
}, async ({ input, tenantId, user }) => {
  const { templateId, audience, dryRun } = input;

  /* Service role from here, every query pinned to this tenant. S21: whatsapp_* tables ab
     generated types me hain — alag untyped handle ki zaroorat nahi. */
  const admin = createAdminClient();

  const { data: tpl } = await admin.from("whatsapp_templates")
    .select("id, name, language, body, param_map, status").eq("id", templateId).eq("tenant_id", tenantId).maybeSingle();
  if (!tpl) throw new RouteError(404, "Template nahi mila.");
  if (tpl.status !== "approved") throw new RouteError(400, "Sirf Meta se approved template bheja ja sakta hai.");
  const paramMap = (Array.isArray(tpl.param_map) ? tpl.param_map : []) as string[];
  const problem = templateProblem(tpl.body, paramMap);
  if (problem) throw new RouteError(400, `Template theek karo: ${problem}`);

  // ── Audience ──────────────────────────────────────────────────────────────
  let q = admin.from("leads").select("id, contact_name, company, contact_phone").eq("tenant_id", tenantId)
    .not("contact_phone", "is", null).eq("is_junk", false);
  if (audience.stages?.length) q = q.in("stage", audience.stages as Stage[]);
  if (audience.sources?.length) q = q.in("source", audience.sources);
  const { data: leads, error: lErr } = await q;
  dbFail(lErr, "Audience ke leads load nahi hue — dobara try kariye.");

  const { data: outs } = await admin.from("whatsapp_opt_outs").select("phone").eq("tenant_id", tenantId);
  const optedOut = new Set(((outs ?? []) as { phone: string }[]).map((o) => o.phone));

  const seen = new Set<string>();
  let noPhone = 0, skippedOptOut = 0;
  const recipients: { leadId: string; phone: string; first: string; company: string | null }[] = [];
  for (const l of (leads ?? []) as { id: string; contact_name: string | null; company: string | null; contact_phone: string | null }[]) {
    const phone = normalizeWaPhone(l.contact_phone);
    if (!phone) { noPhone++; continue; }
    if (optedOut.has(phone)) { skippedOptOut++; continue; }
    if (seen.has(phone)) continue;
    seen.add(phone);
    recipients.push({ leadId: l.id, phone, first: firstName(l.contact_name), company: l.company });
  }

  const { data: tenant } = await admin.from("tenants").select("name").eq("id", tenantId).single();
  const sender = tenant?.name ?? "";
  const capped = recipients.slice(0, MAX_PER_RUN);

  if (dryRun) {
    const sample = capped[0];
    return {
      recipients: capped.length, overCap: Math.max(0, recipients.length - MAX_PER_RUN),
      skippedOptOut, noPhone,
      sample: sample ? renderBody(tpl.body, slotValues(paramMap, { first_name: sample.first, company: sample.company, sender })) : null,
      connected: (await resolveWhatsAppCreds(tenantId)) !== null,
    };
  }

  if (capped.length === 0) throw new RouteError(400, "Is audience mein WhatsApp number wala koi lead nahi.");
  if (!(await resolveWhatsAppCreds(tenantId))) {
    return NextResponse.json({ ok: false, error: "WhatsApp abhi connect nahi hai — Settings mein WhatsApp Business API jodo.", code: "not_configured" }, { status: 409 });
  }

  const { data: bc, error: bErr } = await admin.from("whatsapp_broadcasts").insert({
    tenant_id: tenantId, template_id: tpl.id, template_name: tpl.name, audience,
    recipients_count: capped.length, skipped_count: skippedOptOut, created_by: user.id,
  }).select("id").single();
  dbFail(bErr, "Broadcast shuru nahi hua — kuch bheja nahi gaya. Dobara try kariye.");
  if (!bc) throw new RouteError(500, "Broadcast shuru nahi hua — kuch bheja nahi gaya. Dobara try kariye.");

  let sent = 0, failed = 0;
  for (const r of capped) {
    try {
      const values = slotValues(paramMap, { first_name: r.first, company: r.company, sender });
      const res = await sendWhatsApp({
        tenantId, to: r.phone,
        message: { kind: "template", name: tpl.name, language: tpl.language, components: bodyComponents(values) },
        related: { leadId: r.leadId },
      });
      if (res.status === "failed") failed++; else sent++;
    } catch {
      failed++;
    }
  }

  await admin.from("whatsapp_broadcasts").update({
    sent_count: sent, failed_count: failed, status: sent === 0 ? "failed" : "sent",
  }).eq("id", bc.id);

  return { broadcastId: bc.id, recipients: capped.length, sent, failed, skippedOptOut, overCap: Math.max(0, recipients.length - MAX_PER_RUN) };
});
