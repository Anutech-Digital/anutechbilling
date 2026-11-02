/**
 * POST /api/public/enquiry/workspace/draft — R-2021 (R-2019 decision 5, G-DPDP, Pardeep 27 Oct 2026)
 *
 * The phone buy flow's "WhatsApp me a link to finish this order" box. A DRAFT lead (stage new,
 * source buy-workspace-draft — no quote, no email, no owner alert) is saved ONLY when the buyer
 * ticked that box: `resumeConsent` must be literally true, otherwise nothing is written and the
 * reply is 400. Without the tick the details stay in the buyer's own phone (localStorage) only.
 * The tick, the notice version and the time are written in the lead's notes — the record of what
 * they agreed to. It is not the "Send me offers" opt-in (R-2011): no offers follow from it.
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/server";
import { turnstileRefusalFor } from "@/lib/security/turnstile-guard";
import { captureFromRequest } from "@/lib/marketing/utm";
import { websiteTenantId, websiteTenantMissingBody } from "@/lib/website-tenant";
import { DATA_NOTICE_VERSION } from "@/lib/consent/data-notice";
import { buyIntentNote } from "@/app/api/public/checkout/workspace/buy-intent";
import { buyIntentFields } from "@/app/api/public/checkout/workspace/buy-intent-schema";
import { RESUME_CONSENT_LABEL } from "@/app/(public)/buy/workspace/_mobile/resume-consent";


const draftSchema = z.object({
  /** Must be the literal true: the box was ticked. Anything else → nothing is saved. */
  resumeConsent: z.literal(true),
  fullName:      z.string().trim().min(2).max(120),
  phone:         z.string().trim().min(10).max(20),
  email:         z.string().trim().email().max(200).optional().or(z.literal("")),
  companyName:   z.string().trim().max(200).optional(),
  seats:         z.coerce.number().int().min(1).max(10000),
  tierId:        z.enum(["starter", "standard"]),
  billing:       z.enum(["monthly", "annual"]),
  domain:        z.string().trim().max(120).optional(),
  ...buyIntentFields,
});

export async function POST(request: NextRequest) {
  const tenantId = websiteTenantId();
  if (!tenantId) return NextResponse.json(websiteTenantMissingBody(), { status: 503 });
  let body: unknown;
  try { body = await request.json(); } catch { body = {}; }
  const bot = await turnstileRefusalFor(request, body);
  if (bot) return bot;
  const parsed = draftSchema.safeParse(body);
  if (!parsed.success) {
    const noTick = parsed.error.issues.some((i) => i.path[0] === "resumeConsent");
    return NextResponse.json(
      { error: noTick ? "Nothing was saved: the 'WhatsApp me a link' box was not ticked." : "Nothing was saved: " + parsed.error.issues.map((i) => i.message).join(", ") },
      { status: 400 },
    );
  }
  const d = parsed.data;
  const leadId = "L-" + Date.now().toString(36).toUpperCase();
  const notes = [
    "DRAFT from the phone buy page — not an order yet, nothing paid.",
    `The buyer ticked "${RESUME_CONSENT_LABEL}" (data notice ${DATA_NOTICE_VERSION}, ${new Date().toISOString()}). Send them one link to finish; no offers.`,
    `Plan: Google Workspace ${d.tierId === "starter" ? "Business Starter" : "Business Standard"} · ${d.seats} licence${d.seats === 1 ? "" : "s"} · ${d.billing}`,
    d.domain ? `Domain: ${d.domain}` : null,
    buyIntentNote(d),
  ].filter(Boolean).join("\n");

  const admin = createAdminClient();
  const { error } = await admin.from("leads").insert({
    id:            leadId,
    tenant_id:     tenantId,
    company:       d.companyName || d.fullName,
    contact_name:  d.fullName,
    contact_email: d.email || null,
    contact_phone: d.phone,
    plan:          `google-workspace-${d.tierId}`,
    seats:         d.seats,
    value:         0,
    stage:         "new",
    source:        "buy-workspace-draft",
    ...captureFromRequest(request, body as Record<string, unknown>),
    domain:        d.domain || null,
    notes,
  });
  if (error) {
    console.error("[/api/public/enquiry/workspace/draft] lead insert failed:", error);
    return NextResponse.json({ error: "Could not save your draft. Your details are still on this phone." }, { status: 500 });
  }
  return NextResponse.json({ success: true, leadId });
}
