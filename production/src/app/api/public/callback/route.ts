/**
 * POST /api/public/callback — "Call me back" from an ad landing page (R-139, 4 Oct 2026).
 *
 * Two fields (name + mobile): on a phone, every extra field loses ad visitors before they
 * submit, and the team calls them anyway. Since 5 Oct 2026 (R-155) the home page's custom
 * software form posts here too: product "custom-software" plus an optional one-line need. Creates a lead with the ad attribution (gclid /
 * utm via pageUrl), tells the owner in-app and by email, and never auto-sends anything to the
 * visitor (we only have a phone number). Turnstile + per-IP and per-number rate limits.
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/server";
import { turnstileRefusal } from "@/lib/security/turnstile-guard";
import { rateLimit, clientIp } from "@/lib/security/rate-limit";
import { captureFromRequest } from "@/lib/marketing/utm";
import { notifyTenantOwners } from "@/lib/notifications/notify.server";
import { loadOwnerAlert } from "@/lib/email/owner-alert.server";
import { sendInternalEmail } from "@/lib/messaging";
import { websiteTenantId, websiteTenantMissingBody } from "@/lib/website-tenant";

/* R-1499: the website tenant is read per request (websiteTenantId) — outside production an unset
   BUY_PAGE_TENANT_ID refuses with a clear message, never the live tenant. */
const FROM_EMAIL = process.env.RESEND_FROM_DEFAULT?.trim() || "ResellerOS <onboarding@resend.dev>";

const schema = z.object({
  fullName: z.string().trim().min(2, "Please enter your name").max(120),
  phone: z.string().trim().min(10, "Please enter a 10-digit mobile number").max(20)
    .refine((p) => p.replace(/\D/g, "").length >= 10, "Please enter a 10-digit mobile number"),
  product: z.enum(["google-workspace", "custom-software"]).default("google-workspace"),
  /** Custom software only: what they want built or automated, in their words. */
  need: z.string().trim().max(600).optional(),
  /** Which plan's landing page sent it (lib/lp-plans.ts); old pages send none = Starter;
   *  "any" = the all-plans category page, where the call decides the plan. */
  plan: z.enum(["starter", "standard", "plus", "enterprise", "any"]).default("starter"),
  seats: z.coerce.number().int().min(1).max(300).optional(),
  pageUrl: z.string().max(1000).optional(),
  pageReferrer: z.string().max(1000).optional(),
});

export async function POST(request: NextRequest) {
  const BUY_PAGE_TENANT_ID = websiteTenantId();
  if (!BUY_PAGE_TENANT_ID) return NextResponse.json(websiteTenantMissingBody(), { status: 503 });
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const bot = await turnstileRefusal(request.headers, body);
  if (bot) return bot;

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: [...new Set(parsed.error.issues.map((i) => i.message))].join(", ") }, { status: 400 });
  }
  const { fullName, phone, seats, plan, product, need } = parsed.data;
  const software = product === "custom-software";
  const what = software ? "Custom software" : `Google Workspace${plan === "any" ? "" : ` ${plan}`}`;
  const digits = phone.replace(/\D/g, "").slice(-10);

  if (!rateLimit(`callback:ip:${clientIp(request.headers)}`, { limit: 5, windowMs: 10 * 60_000 }).ok ||
      !rateLimit(`callback:phone:${digits}`, { limit: 2, windowMs: 60 * 60_000 }).ok) {
    // Same answer as success: a repeat tap must not look like an error to a real person.
    return NextResponse.json({ ok: true });
  }

  const admin = createAdminClient();
  const leadId = "L-" + Date.now().toString(36).toUpperCase();
  const { error } = await admin.from("leads").insert({
    id: leadId,
    tenant_id: BUY_PAGE_TENANT_ID,
    company: fullName,                       // no company asked; the call fills it in
    contact_name: fullName,
    contact_phone: phone,
    plan: software ? "custom-software" : plan === "any" ? "google-workspace" : `google-workspace-${plan}`,
    seats: seats ?? null,
    stage: "new",
    source: software ? "website-callback" : "ads-callback",
    ...captureFromRequest(request, body),
    notes: software
      ? `Call-back request for custom software / office automation from the website home page.${need ? ` They wrote: "${need}"` : ""} Call within working hours.`
      : "Call-back request from the Google Workspace ad landing page. Call within working hours.",
  });
  if (error) {
    console.error("[api/public/callback] lead insert failed:", error.message);
    return NextResponse.json({ error: "Could not save your request. Please WhatsApp or call us." }, { status: 500 });
  }

  await notifyTenantOwners({
    tenantId: BUY_PAGE_TENANT_ID,
    kind: "lead.created",
    title: `Call back — ${fullName}`,
    body: `${phone} · ${what}${software ? " (website)" : " (ad landing page)"}`,
    href: "/leads",
    entityId: leadId,
  }).catch(() => null);

  const { alert: owner } = await loadOwnerAlert(admin, BUY_PAGE_TENANT_ID);
  if (owner.ok) {
    await sendInternalEmail({
      to: owner.to,
      from: FROM_EMAIL,
      kind: "ads_callback_alert",
      route: { tenantId: BUY_PAGE_TENANT_ID },
      subject: `📞 Call back now — ${fullName} (${phone}) · ${software ? "Custom software" : "Google Workspace ad"}`,
      text: `Someone on the ${software ? "website home page (custom software)" : "Google Workspace ad page"} asked for a call back.\n\nNAME   ${fullName}\nPHONE  ${phone}\n${seats ? `USERS  ${seats}\n` : ""}${need ? `NEED   ${need}\n` : ""}\nCall them while the interest is fresh. The lead is ${leadId} in your pipeline.`,
    }).catch(() => null);
  }

  return NextResponse.json({ ok: true });
}
