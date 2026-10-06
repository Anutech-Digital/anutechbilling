/**
 * POST /api/public/enquiry/general
 *
 * General-purpose PUBLIC lead-capture endpoint for the shareable enquiry form
 * at /enquiry. Anonymous visitors hit this — no auth required.
 *
 * Unlike /api/public/enquiry/workspace (which is purchase-oriented: it needs a
 * tier + seat count and auto-drafts a priced Google Workspace quote), THIS
 * endpoint is for "tell us your requirement" enquiries. The visitor describes
 * what they need in free text; we simply create a `leads` row (stage='new',
 * source='enquiry-form') and notify the reseller. No pricing, no auto-quote —
 * Pardeep reads the requirement and follows up.
 *
 * Security:
 * - Validated with Zod (rejects malformed bodies)
 * - Uses the admin client (bypasses RLS — the visitor has no session) but writes
 *   ONLY to the single BUY_PAGE_TENANT_ID tenant, so there is no cross-tenant
 *   surface. (Same model as the workspace enquiry route.)
 */
import { NextResponse, type NextRequest } from "next/server";
import { turnstileRefusal } from "@/lib/security/turnstile-guard";
import { captureFromRequest } from "@/lib/marketing/utm";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/server";
import { notifyTenantOwners } from "@/lib/notifications/notify.server";
import { sendEmail } from "@/lib/email/send";
import { storefrontVoice } from "@/lib/email/storefront-voice";

const FROM_EMAIL = process.env.RESEND_FROM_DEFAULT?.trim() || "ResellerOS <onboarding@resend.dev>";
const APP_URL    = process.env.NEXT_PUBLIC_APP_URL?.trim() || "https://resellersos.web.app";

// The tenant that owns the public capture form. Explicit env var (shared with
// the buy page) so it can't drift when new tenants get seeded.
const BUY_PAGE_TENANT_ID =
  process.env.BUY_PAGE_TENANT_ID?.trim() || "fbb976f1-9090-4f10-9726-0901bd144e42";

// Human labels for the product a lead is interested in. Kept in sync with the
// <select> options on the /enquiry form.
const PRODUCT_LABEL: Record<string, string> = {
  "google-workspace": "Google Workspace",
  "microsoft-365":    "Microsoft 365",
  "zoho":             "Zoho",
  "other":            "Other / Not sure",
};

const enquirySchema = z.object({
  fullName:    z.string().min(2).max(120),
  companyName: z.string().min(2).max(200),
  email:       z.string().email().max(200),
  phone:       z.string().min(10).max(20),
  product:     z.enum(["google-workspace", "microsoft-365", "zoho", "other"]).optional(),
  seats:       z.coerce.number().int().min(1).max(100000).optional(),
  subscriptionType: z.enum(["fresh", "switch"]).optional(),
  message:     z.string().min(5, "Please describe what you need").max(2000),
  /** A free-trial request from the site's trial form: no owner alert (owner, 30 Sep 2026). */
  trial:       z.boolean().optional(),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    /* R-020: a bot is refused here; a no-op until TURNSTILE_SECRET_KEY is set. */
    const botRefusal = await turnstileRefusal(request.headers, body);
    if (botRefusal) return botRefusal;
    const parsed = enquirySchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid form data: " + parsed.error.issues.map((i) => i.message).join(", ") },
        { status: 400 },
      );
    }

    const { fullName, companyName, email, phone, product, seats, subscriptionType, message, trial } = parsed.data;

    const admin = createAdminClient();
    const tenantId = BUY_PAGE_TENANT_ID;

    const productLabel = product ? PRODUCT_LABEL[product] : null;
    const subLabel = subscriptionType === "switch" ? "Switching provider (already subscribed)"
                   : subscriptionType === "fresh"  ? "Fresh subscription" : null;

    const leadId    = "L-" + Date.now().toString(36).toUpperCase();
    const leadNotes = [
      "Submitted via public enquiry form (/enquiry)",
      productLabel ? `Interested in: ${productLabel}` : null,
      seats ? `Approx users: ${seats}` : null,
      subLabel ? `New/switching: ${subLabel}` : null,
      `Requirement: ${message}`,
    ].filter(Boolean).join("\n");

    const { error: leadErr } = await admin.from("leads").insert({
      id:            leadId,
      tenant_id:     tenantId,
      company:       companyName,
      contact_name:  fullName,
      contact_email: email,
      contact_phone: phone,
      plan:          product ?? null,
      seats:         seats ?? null,
      subscription_type: subscriptionType ?? null,
      stage:         "new",
      source:        "enquiry-form",
      // Migration 0232 — inbound attribution. Nulls when nothing was captured.
      ...captureFromRequest(request, body as Record<string, unknown>),
      notes:         leadNotes,
    });

    if (leadErr) {
      console.error("[/api/public/enquiry/general] lead insert failed:", leadErr);
      return NextResponse.json(
        { error: "Could not save your enquiry. Please try again or call us." },
        { status: 500 },
      );
    }

    /* In-app khabar (audit B4) — lead COMMIT ke baad, best-effort. */
    await notifyTenantOwners({
      tenantId,
      kind: "lead.created",
      title: `New enquiry — ${companyName}`,
      body: fullName + (seats ? ` · ${seats} seats` : ""),
      href: "/leads",
      entityId: leadId,
    });

    // ── Notify the reseller (best-effort — don't fail the request on email) ──
    // Pull the tenant's own inbox so alerts land with the right owner, not a
    // hardcoded address.
    const { data: tenant } = await admin
      .from("tenants")
      .select("email, name")
      .eq("id", tenantId)
      .maybeSingle();

    const ownerEmail = tenant?.email;
    // The storefront signs as the company and takes replies at support (lib/email/storefront-voice.ts).
    const voice = storefrontVoice(tenantId);
    const firstName  = fullName.split(" ")[0];

    const settled = await Promise.allSettled([
      /* 1. Reseller alert — not for a trial request. Owner, 30 Sep 2026, on trial alerts:
         "Remove this feature completely. That will just annoy the owner." Staff still see
         the trial as a lead. */
      ownerEmail && !trial
        ? sendEmail({
            /* Bina `route` ke ye default Resend par jata hai (send.ts:26), aur wo test mode
                  me hai. Tenant ne Gmail chuna hai to mail wahi se jaye. */
            route: { tenantId: tenantId },
            to:      ownerEmail,
            from:    FROM_EMAIL,
            replyTo: email,
            subject: `🔔 New enquiry — ${companyName}${productLabel ? ` (${productLabel})` : ""}`,
            text:
`A new enquiry just came in through your public form.

COMPANY     ${companyName}
CONTACT     ${fullName} <${email}>
PHONE       ${phone}
${productLabel ? `INTEREST    ${productLabel}\n` : ""}${seats ? `USERS       ${seats}\n` : ""}
REQUIREMENT
${message}

Open the lead to follow up:
${APP_URL}/leads/${leadId}

— ResellerOS`,
          })
        : Promise.resolve({ status: "skipped" as const }),

      // 2. Customer acknowledgement
      sendEmail({
        /* Bina `route` ke ye default Resend par jata hai (send.ts:26), aur wo test mode
              me hai. Tenant ne Gmail chuna hai to mail wahi se jaye. */
        route: { tenantId: tenantId },
        to:      email,
        from:    FROM_EMAIL,
        replyTo: voice ? voice.replyTo : ownerEmail,
        subject: `Got your enquiry, ${firstName} — we'll be in touch shortly`,
        text:
`Hi ${firstName},

Thanks for reaching out${tenant?.name ? ` to ${tenant.name}` : ""}. We've received your requirement and someone will get back to you shortly.

WHAT WE HAVE FROM YOU
  Company       ${companyName}
${productLabel ? `  Interested in ${productLabel}\n` : ""}${seats ? `  Users         ${seats}\n` : ""}  Requirement   ${message}

If it's urgent, just reply to this email.

${voice ? voice.signOff : `— Team${tenant?.name ? ` ${tenant.name}` : ""}`}`,
      }),
    ]);
    settled.forEach((r, i) => {
      if (r.status === "rejected") {
        console.error(`[enquiry/general] email ${i === 0 ? "to owner" : "to customer"} failed:`, r.reason);
      }
    });
    /* Did the customer's copy really go? Returned so the form can say "check your inbox"
       only when it is true (30 Sep 2026). */
    const ack = settled[1];
    const ackSent = ack.status === "fulfilled" && ack.value.status === "sent";

    return NextResponse.json({ success: true, leadId, ackSent });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[/api/public/enquiry/general] crashed:", message);
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
