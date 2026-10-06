/**
 * POST /api/public/trial/workspace
 *
 * Public trial-request endpoint for the /buy/workspace landing page.
 * Different from `/api/public/enquiry/workspace` in three ways:
 *
 *   1. The lead lands at stage='trial' (not 'new') — it's a qualified
 *      intent signal, customer wants to actually try the product
 *   2. NO auto-quote is created — a 14-day trial is free; no quote needed
 *      until the trial converts to paid (handled later via subscription flow)
 *   3. The form collects a `domain` (e.g. yourcompany.in) because Google
 *      Workspace trial provisioning needs a verifiable domain on day 1
 *
 * Workflow after this endpoint fires:
 *   - Pardeep gets an alert email + sees the lead in Deal Pipeline → Deals tab
 *   - He provisions the trial in Google Reseller Console (manual for v1)
 *   - On day 14, a separate cron should remind the customer to convert
 *     (TODO: build trial-conversion cron — for v1 Pardeep tracks manually)
 */
import { NextResponse, type NextRequest } from "next/server";
import { captureFromRequest } from "@/lib/marketing/utm";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/server";
import { sendEmail } from "@/lib/email/send";
import { loadOwnerAlert } from "@/lib/email/owner-alert.server";
import { storefrontVoice } from "@/lib/email/storefront-voice";

/* The owner recipient was hardcoded here to an address on a retired domain
   (CLAUDE.md §1). Resolved from the storefront tenant's row now — see
   lib/email/owner-alert.ts for why there is no fallback constant. */
const FROM_EMAIL    = process.env.RESEND_FROM_DEFAULT?.trim() || "ResellerOS <onboarding@resend.dev>";
const BUY_PAGE_TENANT_ID =
  process.env.BUY_PAGE_TENANT_ID?.trim() || "fbb976f1-9090-4f10-9726-0901bd144e42";

const TRIAL_DAYS = 14;

const trialSchema = z.object({
  fullName:    z.string().min(2).max(120),
  companyName: z.string().min(2).max(200),
  email:       z.string().email().max(200),
  phone:       z.string().min(10).max(20),
  seats:       z.coerce.number().int().min(1).max(300),  // trials capped lower
  domain:      z.string().min(3).max(120),               // e.g. acme.in
  tierId:      z.enum(["starter", "standard", "plus", "enterprise"]).optional(),
  message:     z.string().max(2000).optional(),
});

export async function POST(request: NextRequest) {
  try {
    const body   = await request.json();
    const parsed = trialSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid trial request: " + parsed.error.issues.map((i) => i.message).join(", ") },
        { status: 400 },
      );
    }

    const { fullName, companyName, email, phone, seats, domain, tierId, message } = parsed.data;

    // Normalize domain — strip protocol, trailing slash, lower-case
    const cleanDomain = domain
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/\/+$/, "")
      .trim();

    const admin = createAdminClient();

    // ── Insert lead at stage='trial' ───────────────────────────────────────
    const leadId    = "L-" + Date.now().toString(36).toUpperCase();
    const planLabel = tierId ? `google-workspace-${tierId}` : "google-workspace-trial";
    const tierName  =
      tierId === "starter"    ? "Business Starter"   :
      tierId === "standard"   ? "Business Standard"  :
      tierId === "plus"       ? "Business Plus"      :
      tierId === "enterprise" ? "Enterprise"         :
                                "Standard (default)";

    const notes = [
      `TRIAL REQUEST · ${TRIAL_DAYS}-day free trial`,
      `Domain: ${cleanDomain}`,
      `Plan to trial: Google Workspace ${tierName}`,
      `Seats: ${seats}`,
      `Submitted via /buy/workspace`,
      message ? `Message: ${message}` : null,
      ``,
      `NEXT STEPS:`,
      `  1. Verify domain ownership via DNS TXT record`,
      `  2. Create trial Org in Google Reseller Console`,
      `  3. Provision ${seats} ${tierName} licenses (14-day expiry)`,
      `  4. Send admin credentials to ${email} + WhatsApp ${phone}`,
      `  5. Set calendar reminder for Day 12 conversion outreach`,
    ].filter(Boolean).join("\n");

    // Trial lifecycle timestamps — drives reminders + expiry cron
    const trialStartedAt = new Date();
    const trialExpiresAt = new Date(trialStartedAt.getTime() + TRIAL_DAYS * 86400000);

    const { error: leadErr } = await admin.from("leads").insert({
      id:                leadId,
      tenant_id:         BUY_PAGE_TENANT_ID,
      company:           companyName,
      contact_name:      fullName,
      contact_email:     email,
      contact_phone:     phone,
      plan:              planLabel,
      seats,
      value:             0,                                  // trial is free — no deal value yet
      stage:             "trial",                            // qualified lead, not raw inquiry
      source:            "buy-workspace-trial",
      // Migration 0232 — inbound attribution. Nulls when nothing was captured.
      ...captureFromRequest(request, body as Record<string, unknown>),
      domain:            cleanDomain,                        // structured — flows lead→quote→subscription
      notes,
      trial_started_at:  trialStartedAt.toISOString(),
      trial_expires_at:  trialExpiresAt.toISOString(),
    });

    if (leadErr) {
      console.error("[/api/public/trial/workspace] lead insert failed:", leadErr);
      return NextResponse.json(
        /* Was "Please WhatsApp Pardeep directly" — a website visitor is told to contact a
           person by name, on a storefront that may belong to a different reseller, and with
           no number given to do it with. A §24 dead-end: it names a next step the reader
           cannot take. This says what to do with what they actually have in front of them. */
        { error: "Could not start your trial — nothing was saved, so please try again. If it happens twice, email us using the address on this page and we will set it up by hand." },
        { status: 500 },
      );
    }

    // Auto-create follow-up tasks via tasks system —
    //   T-7  (Day 7):  "Mid-trial check-in"
    //   T-2  (Day 12): "Conversion call — trial expires in 2 days"
    //   T+0  (Day 14): "Trial expires today — final outreach"
    // Tasks are best-effort. If insert fails (no owner_id, schema drift),
    // the trial flow still succeeds — Pardeep just won't get reminders.
    try {
      const day7  = new Date(trialStartedAt.getTime() + 7  * 86400000);
      const day12 = new Date(trialStartedAt.getTime() + 12 * 86400000);
      const day14 = new Date(trialStartedAt.getTime() + 14 * 86400000);
      day7.setHours(10, 0, 0, 0);  // 10am IST-ish
      day12.setHours(10, 0, 0, 0);
      day14.setHours(10, 0, 0, 0);

      await admin.from("tasks").insert([
        {
          tenant_id: BUY_PAGE_TENANT_ID,
          title:     `Trial check-in: ${companyName} (${cleanDomain})`,
          notes:     `Day 7 of 14-day trial. Ask about adoption, onboarding blockers, any questions.`,
          kind:      "call",
          due_at:    day7.toISOString(),
          lead_id:   leadId,
        },
        {
          tenant_id: BUY_PAGE_TENANT_ID,
          title:     `Conversion call: ${companyName} — trial ends in 2 days`,
          notes:     `Day 12 of 14-day trial. Discuss converting to paid. Quote ready to issue.`,
          kind:      "call",
          due_at:    day12.toISOString(),
          lead_id:   leadId,
        },
        {
          tenant_id: BUY_PAGE_TENANT_ID,
          title:     `Trial expires TODAY: ${companyName}`,
          notes:     `14-day trial ends. Final outreach. Either convert to paid quote OR mark lead lost + suspend in Google CSP.`,
          kind:      "call",
          due_at:    day14.toISOString(),
          lead_id:   leadId,
        },
      ]);
    } catch (taskErr) {
      console.error("[/api/public/trial/workspace] task auto-create failed (non-fatal):", taskErr);
    }

    // ── Notification emails (best-effort, non-blocking) ───────────────────
    const trialEnds = new Date();
    trialEnds.setDate(trialEnds.getDate() + TRIAL_DAYS);
    const trialEndsFmt = trialEnds.toLocaleDateString("en-IN", {
      day: "2-digit", month: "short", year: "numeric",
    });

    const { alert: owner, tenant: ownerTenant } = await loadOwnerAlert(admin, BUY_PAGE_TENANT_ID);
    const ownerName = owner.ok ? owner.ownerName : "";
    // The storefront signs as the company and takes replies at support (lib/email/storefront-voice.ts).
    const voice = storefrontVoice(BUY_PAGE_TENANT_ID);
    const customerReplyTo = voice ? voice.replyTo : owner.ok ? owner.to : null;
    if (!owner.ok) {
      console.warn(`[trial/workspace] lead ${leadId}: no owner address, so the customer email has no reply-to: ${owner.reason}`);
    }

    await Promise.allSettled([
      /* No owner email for a trial (owner, 30 Sep 2026: "that will just annoy the owner").
         The request is a lead with its follow-up task, where staff see it. */
      /* Customer trial acknowledgement.
         Named from the tenant row. This body previously said "through Excel
         Technologies", "Pardeep will WhatsApp you", a fixed phone number, and
         "Google Premier Partner · since 2014" — on a storefront owned by any other
         tenant, four statements about a company and a person the customer has no
         relationship with, one of them a partner certification this code cannot
         know is held. Absent details are omitted, never invented. */
      /* Sent whatever the owner-alert lookup returns — it used to need it (owner.ok), so a
         workspace with no owner address sent the customer nothing. */
      sendEmail({
        to:      email,
        from:    FROM_EMAIL,
        ...(customerReplyTo ? { replyTo: customerReplyTo } : {}),
        kind:    "buy_page_trial_customer",
        route:   { tenantId: BUY_PAGE_TENANT_ID },
        subject: `Your ${TRIAL_DAYS}-day Google Workspace trial — ${cleanDomain}`,
        text:
`Hi ${fullName.split(" ")[0]},

Thanks for trying Google Workspace${ownerTenant?.name?.trim() ? ` through ${ownerTenant.name.trim()}` : ""}. Here's
what happens next:

WITHIN 4 HOURS
  • We'll be in touch to verify the domain (${cleanDomain})
  • You'll receive a DNS TXT record to add (or we can guide you over the phone)

WITHIN 24 HOURS
  • ${seats} Google Workspace ${tierName} licenses provisioned for ${cleanDomain}
  • Admin console handover with your credentials
  • Onboarding call scheduled (15-30 minutes)

DAY 12
  • We'll reach out to discuss whether to convert to paid (with the GST
    pricing you've already seen) or to extend / cancel the trial

NO CREDIT CARD until you decide to convert. ${TRIAL_DAYS} days fully free, no
strings attached. Trial period ends ${trialEndsFmt}.

If you want to talk before then, just reply to this email${ownerTenant?.phone?.trim() ? ` — or call/WhatsApp ${voice ? "us" : ownerName || "us"} on ${ownerTenant.phone.trim()}` : ""}.

${voice ? voice.signOff : `— ${ownerName || ownerTenant?.name?.trim() || "Your reseller"}${
  ownerTenant?.name?.trim() && ownerName !== ownerTenant.name.trim()
    ? `\n   ${ownerTenant.name.trim()}`
    : ""
}`}`,
      }),
    ]).then((results) => {
      const labels = ["customer acknowledgement"];
      results.forEach((r, i) => {
        /* A skipped send settles as the literal `false`, so this must not be read
           as a send result — otherwise "not sent" logs as "sent fine". */
        if (r.status === "rejected") {
          console.error(`[trial/workspace] ${labels[i]} failed:`, r.reason);
        } else if (r.value && r.value.status === "failed") {
          console.error(`[trial/workspace] ${labels[i]} failed:`, r.value.errorMessage);
        }
      });
    });

    return NextResponse.json({ success: true, leadId, trialEnds: trialEnds.toISOString() });
  } catch (err) {
    const m = err instanceof Error ? err.message : "Unknown error";
    console.error("[/api/public/trial/workspace] crashed:", m);
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
