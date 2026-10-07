/**
 * POST /api/public/enquiry/workspace
 *
 * Public lead-capture endpoint for the /buy/workspace landing page.
 * Anonymous visitors hit this — no auth required.
 *
 * On a successful submission we now do TWO things atomically (well, sequentially
 * — Supabase doesn't expose a JS-level multi-row transaction, but a failed
 * quote insert leaves the lead in place, which is acceptable degradation):
 *
 *   1. Create a `leads` row (stage='new', source='buy-workspace')
 *   2. **Auto-create a `draft` quote** with the visitor's tier + seat count
 *      and a 7-day expiry, linked back to the lead.
 *
 * The auto-draft collapses pipeline stage 5 ("Pardeep manually builds quote")
 * from ~15 minutes to zero. Pardeep just opens the lead in the app, glances
 * at the pre-populated quote, hits Send. Customer gets a GST-compliant quote
 * email within minutes of clicking "Email me a quote" on the buy page.
 *
 * PRICING (audit fix #10/#11, 2026-05-30): the auto-quote price now comes from
 * the SHARED catalog-driven module (src/lib/pricing/workspace.ts) — the SAME one
 * the public checkout uses. Previously this route hardcoded ₹270/₹864/₹1080 per
 * user, which diverged wildly from the catalog (₹136/₹736), so "Get a quote"
 * quoted a different price than "Buy now" for the same tier. Now both agree, and
 * `items.msrp` (retail) is the single source of truth.
 *
 * v1 limitation: single-tenant (routes leads to Excel Tech). When we add
 * subdomain-based multi-tenancy (excel.resellersos.app), we'll resolve
 * the tenant from the request host instead.
 *
 * Security:
 * - Validated with Zod (rejects malformed bodies)
 * - Uses admin client (bypasses RLS — required since visitor has no session)
 * - Rate limit TODO: bolt on at the edge later (Cloudflare or upstream proxy)
 */
import { addDaysISO, istToday } from "@/lib/dates/ist";
import { NextResponse, type NextRequest } from "next/server";
import { turnstileRefusal } from "@/lib/security/turnstile-guard";
import { captureFromRequest } from "@/lib/marketing/utm";
import { z } from "zod";
import { GST_STATE_BY_CODE } from "@/lib/utils";
import { createAdminClient } from "@/lib/supabase/server";
import { notifyTenantOwners } from "@/lib/notifications/notify.server";
import { sendEmail, isEmailConfigured } from "@/lib/email/send";
import { decideAutoSend } from "@/lib/quotes/auto-send-quote";
import { sendAutoQuote } from "@/lib/quotes/send-auto-quote";
import { loadOwnerAlert } from "@/lib/email/owner-alert.server";
import { storefrontVoice } from "@/lib/email/storefront-voice";
import {
  fetchWorkspaceCatalogPrice,
  buildWorkspaceLines,
  buildWorkspaceFlexLines,
  TIER_DISPLAY_NAME,
} from "@/lib/pricing/workspace";

/* The owner inbox used to be hardcoded here, with the comment "Hardcoded for v1
   (single tenant); resolve per-tenant once we go multi-tenant." That TODO came due
   and nobody noticed — the address it named is on a retired domain (CLAUDE.md §1),
   so buy-page leads were alerting an inbox the company no longer uses, and the
   `replyTo` on the CUSTOMER's acknowledgement pointed there too. It is resolved
   from the storefront tenant's own row now. See lib/email/owner-alert.ts. */
const FROM_EMAIL    = process.env.RESEND_FROM_DEFAULT?.trim() || "ResellerOS <onboarding@resend.dev>";
const APP_URL       = process.env.NEXT_PUBLIC_APP_URL?.trim() || "https://resellersos.web.app";

// The tenant that owns the /buy/workspace storefront. Explicit env var keeps
// this from drifting when new tenants get added (the previous "oldest tenant"
// heuristic broke when seed data created an earlier Excel Tech tenant that
// Pardeep wasn't logged in as). Falls back to the active Excel Tech tenant.
const BUY_PAGE_TENANT_ID =
  process.env.BUY_PAGE_TENANT_ID?.trim() || "fbb976f1-9090-4f10-9726-0901bd144e42";

const enquirySchema = z.object({
  fullName:    z.string().min(2).max(120),
  companyName: z.string().min(2).max(200),
  email:       z.string().email().max(200),
  phone:       z.string().min(10).max(20),
  seats:       z.coerce.number().int().min(1).max(10000),
  tierId:      z.enum(["starter", "standard", "plus", "enterprise"]),
  billing:     z.enum(["monthly", "annual"]),
  message:     z.string().max(2000).optional(),
  // Optional GST place-of-supply. Drives IGST vs CGST+SGST once the lead
  // converts to a customer (state copied through accept_quote / record_payment).
  /* R-174: a real GST state code — "2 digits" alone let "00" or "98" through, which no invoice
     can use. Unknown codes are refused here rather than stored on the lead. */
  stateCode:   z.string().regex(/^\d{2}$/, "state code must be 2 digits")
    .refine((c) => c in GST_STATE_BY_CODE && Number(c) < 97, "not a GST state code").optional(),
  state:       z.string().max(60).optional(),
  /** A free-trial request from the site's trial form: no owner alert (owner, 30 Sep 2026). */
  trial:       z.boolean().optional(),
  /** R-157: the visitor took the "30+ users, ₹1,650 first year" Starter offer (ad page). */
  offer:       z.enum(["starter-30"]).optional(),
});

/** The page the form was sent from, for the lead note ("/lp/google-workspace-1"), else null. */
function pagePath(body: unknown): string | null {
  const raw = (body as { pageUrl?: unknown } | null)?.pageUrl;
  if (typeof raw !== "string" || !raw) return null;
  try { return new URL(raw, "https://anutech.in").pathname.slice(0, 120); } catch { return null; }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    /* R-020: a bot is refused here; a no-op until TURNSTILE_SECRET_KEY is set. */
    const botRefusal = await turnstileRefusal(request.headers, body);
    if (botRefusal) return botRefusal;
    const parsed = enquirySchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid form data: " + parsed.error.issues.map(i => i.message).join(", ") },
        { status: 400 },
      );
    }

    const { fullName, companyName, email, phone, seats, tierId, billing, message, stateCode, state, trial, offer } = parsed.data;

    const admin = createAdminClient();

    // ── Route to the explicit buy-page tenant ─────────────────────────────
    // We used to pick "oldest tenant by created_at", but seed data introduced
    // an earlier Excel Tech tenant that the logged-in operator can't see, so
    // leads landed in the wrong inbox. Use BUY_PAGE_TENANT_ID env var instead.
    const tenantId = BUY_PAGE_TENANT_ID;

    // ── Price from the catalog (single source of truth, shared with checkout)
    const catalogRow = await fetchWorkspaceCatalogPrice(admin, tenantId, tierId);
    const lines      = buildWorkspaceLines(catalogRow, tierId, seats);
    const tierName   = TIER_DISPLAY_NAME[tierId];

    /* ── FLEX DRAFT — the visitor asked pay-as-you-go, the document says so ──
       billing === "monthly" prices the draft on the flexible tier: per seat per MONTH,
       one month's subtotal, no ×12 anywhere (Pardeep: "12 invoices wala koi chakkar
       nahi"). Null means the catalogue holds no flexible price for this product — then
       the annual draft is created and held for a person, and nothing is invented. */
    const wantFlex  = billing === "monthly";
    const flexLines = wantFlex ? buildWorkspaceFlexLines(catalogRow, tierId, seats) : null;
    const usingFlex = wantFlex && flexLines !== null;
    const chosen    = usingFlex ? flexLines! : lines;

    // ── Insert lead ────────────────────────────────────────────────────────
    const leadId    = "L-" + Date.now().toString(36).toUpperCase();
    const planLabel = `google-workspace-${tierId}`;
    /* Lead ranking value: annual figure jab annual, mahine ka jab flex — jo document
       banega usi ka sach. */
    const value     = chosen.subtotal;

    /* R-157: say where it really came from (landing pages, /trial and /quote all post here),
       and what was asked — a trial or the first-year offer are not a plain price request. */
    const leadNotes = [
      `Submitted via ${pagePath(body) ?? "the website"}`,
      trial ? "Asked for the free 14-day trial — set the trial up, do not send a price first." : null,
      offer === "starter-30" ? "Asked for the 30+ users first-year offer (₹1,650/user, new account) — needs Google's approval before it is quoted." : null,
      `Billing preference: ${billing}`,
      message ? `Message: ${message}` : null,
    ].filter(Boolean).join("\n");

    const { error: leadErr } = await admin.from("leads").insert({
      id:            leadId,
      tenant_id:     tenantId,
      company:       companyName,
      contact_name:  fullName,
      contact_email: email,
      contact_phone: phone,
      plan:          planLabel,
      seats,
      value,
      stage:         trial ? "trial" : "new",
      source:        trial ? "website-trial" : "buy-workspace",
      // Migration 0232 — inbound attribution. Nulls when nothing was captured.
      ...captureFromRequest(request, body as Record<string, unknown>),
      notes:         leadNotes,
      // Place-of-supply for GST (copied to the customer on conversion). Optional here — an
      // enquiry is not a sale; a blank one shows in Customers → "State missing" after conversion
      // (R-166) and generate_invoice refuses until it is set. The name comes from the code (R-174).
      state_code:    stateCode ?? null,
      state:         stateCode ? GST_STATE_BY_CODE[stateCode] : (state ?? null),
    });

    if (leadErr) {
      console.error("[/api/public/enquiry/workspace] lead insert failed:", leadErr);
      return NextResponse.json(
        { error: "Could not save your enquiry. Please call us directly." },
        { status: 500 },
      );
    }

    /* In-app khabar (audit B4) — lead COMMIT ke baad, best-effort. */
    await notifyTenantOwners({
      tenantId,
      kind: "lead.created",
      title: `New enquiry — ${companyName}`,
      body: `${fullName} · ${seats} seats ${tierId}`,
      href: "/leads",
      entityId: leadId,
    });

    // ── Auto-create draft quote — collapses pipeline stage 5 ──────────────
    // Skip for Enterprise (custom pricing — Pardeep hand-prices) and for any
    // tier the catalog can't price. Retry up to 3 times if the doc-number RPC
    // returns a value already in `quotes` (counter drift from earlier seed data).
    let draftQuoteId: string | null = null;
    const canAutoQuote = tierId !== "enterprise" && chosen.items.length > 0;

    if (canAutoQuote) {
      /* R-026: the IST calendar day. `toISOString().slice(0, 10)` is the UTC day, so an order
         placed between 00:00 and 05:30 IST was dated yesterday (AGENTS.md §6). */
      const createdDate = istToday();
      const expiresDate = addDaysISO(createdDate, 7);

      for (let attempt = 1; attempt <= 3 && !draftQuoteId; attempt++) {
        const { data: quoteId, error: numErr } = await admin
          .rpc("next_document_number", { p_doc_type: "quote", p_tenant_id: tenantId });

        if (numErr || !quoteId) {
          console.error(`[enquiry/workspace] next_document_number attempt ${attempt} failed:`, numErr);
          break;
        }

        const { error: quoteErr } = await admin.from("quotes").insert({
          id:            quoteId as string,
          tenant_id:     tenantId,
          customer_id:   null,
          customer_name: companyName,
          lead_id:       leadId,
          plan:          planLabel,
          seats,
          line_items:    chosen.items,       // ← flex: ₹/seat/MONTH · annual: ₹/seat/year
          subtotal:      chosen.subtotal,    // ← ex-GST (per month on flex)
          total_cost:    chosen.items.reduce((s, i) => s + i.qty * i.cost, 0),
          discount_pct:  0,
          tax_rate:      18,                 // CGST 9 + SGST 9 (or IGST 18)
          amount:        chosen.amount,      // ← incl-GST (per month on flex)
          /* The covering letter and the PDF read this to say PAYABLE EACH MONTH vs
             TOTAL PAYABLE — leaving it null made every buy-page draft read annual. */
          billing_cycle: usingFlex ? "monthly" : "yearly",
          status:        "draft",
          owner_id:      null,
          created_date:  createdDate,
          expires_date:  expiresDate,
          notes:         `Auto-generated from /buy/workspace enquiry. Customer wants ${seats} seat${seats === 1 ? "" : "s"} of Google Workspace ${tierName}, ${usingFlex ? "monthly flexible (pay-as-you-go)" : "annual commitment"}.`,
        });

        if (!quoteErr) {
          draftQuoteId = quoteId as string;
          break;
        }

        // Postgres unique-violation code = 23505 — retry pulls the next number.
        if (quoteErr.code === "23505") {
          console.warn(`[enquiry/workspace] quote ID collision on attempt ${attempt}: ${quoteId}. Retrying...`);
          continue;
        }

        // Any other failure — log and bail (lead is still saved, Pardeep can
        // build the quote manually).
        console.error(`[enquiry/workspace] quote insert failed on attempt ${attempt}:`, quoteErr);
        break;
      }

      if (draftQuoteId) {
        // Annotate the lead so Pardeep sees the auto-quote ID in the lead drawer
        await admin
          .from("leads")
          .update({
            notes: `${leadNotes}\n\nAuto-generated draft quote: ${draftQuoteId} (₹${chosen.amount.toLocaleString("en-IN")}${usingFlex ? "/month" : ""} incl GST, valid 7 days)`,
          })
          .eq("id", leadId);
      }
    }

    // ── Fire two notification emails (best-effort, don't block response) ──
    // 1. Pardeep gets a "new buy-page lead" alert with all the lead details
    //    plus a direct deep-link to the auto-quote (if it got created)
    // 2. The customer gets an instant acknowledgement so they don't feel
    //    ghosted between submission and Pardeep's call-back
    //
    // We don't `await` these in series because we want the API to respond
    // fast (form-submit UX) — but we do `await` both so any errors get
    // logged. The user-facing response is unaffected if email fails (the
    // lead is already saved).
    const valueFmt = `₹${value.toLocaleString("en-IN")}${usingFlex ? "/month" : "/year"}`;
    const draftUrl = draftQuoteId ? `${APP_URL}/quotes/${draftQuoteId}` : `${APP_URL}/leads`;

    /* Who owns this storefront, and can they be reached? Resolved once for both
       emails below. `ok: false` is a stated reason, never a substituted address —
       the lead is already saved either way, so a lost notification is recoverable
       and a misdirected one is not. */
    const { alert: owner, tenant: ownerTenant } = await loadOwnerAlert(admin, tenantId);
    if (!owner.ok) {
      console.error(`[enquiry/workspace] lead ${leadId} saved, but no owner alert: ${owner.reason}`);
    }
    const ownerName = owner.ok ? owner.ownerName : "";
    const voice = storefrontVoice(tenantId);
    const customerReplyTo = voice ? voice.replyTo : owner.ok ? owner.to : null;

    /* ── FULL AUTO-SEND — Pardeep's call, 31 Aug 2026 ─────────────────────────
       "poora auto-SEND bhi kar do." Until now this route stopped at a draft and the
       operator clicked Send. The email-enquiry path has sent unattended since 23 Aug,
       behind decideAutoSend's gates — so this route now walks through the SAME gates and
       the SAME sender rather than growing a second send path:

         · decideAutoSend  — the volume review band (>50 seats holds), the address checks,
                             the not-configured check. termAssumed is false HERE by
                             construction: the form's billing field is an enum the visitor
                             clicked, not a phrase the app interpreted.
         · sendAutoQuote   — PDF, covering letter, quote.send dial, kill switch,
                             quote_send_log, lead stage — one sender, one audit shape.

       ── AND THE ONE HOLD THAT IS NEW ──────────────────────────────────────
       billing === "monthly" never auto-sends. buildWorkspaceLines prices EVERY draft on
       the annual commitment (rate = monthly MSRP × 12, commitment annual_yearly — its own
       header says so); for an annual request the document matches the ask, but a visitor
       who clicked "Monthly, flexible" would receive a quotation priced on a commitment
       they explicitly declined. That is the document-contradicts-the-request defect this
       app has already paid for at 12× — so the flex draft waits for a person to reprice
       it, and the operator alert says exactly that. Pricing flex drafts natively in
       buildWorkspaceLines is the follow-up that removes this hold. */
    let autoSent = false;
    let holdReason: string | null = null;

    if (draftQuoteId) {
      const ourAddresses = [owner.ok ? owner.to : null, ownerTenant?.email ?? null]
        .filter((a): a is string => !!a)
        .map((a) => a.trim().toLowerCase());

      if (trial) {
        /* R-157: someone who asked for a free trial was emailed a full-price quotation. */
        holdReason = "this is a free-trial request — set the trial up first; send the price when they decide to buy";
      } else if (offer === "starter-30") {
        /* The offer price needs Google's approval per account, so the list-price draft must not go out as the answer. */
        holdReason = "the visitor asked for the 30+ users first-year offer — get Google's approval, then reprice the draft at the offer rate";
      } else if (wantFlex && !usingFlex) {
        /* The one hold that remains: flex was asked for and the catalogue has no flexible
           price for this tier — the draft on file is ANNUAL-priced, so a person must
           reprice it. Sending it unattended would put a commitment the visitor declined
           on a document they can hold us to. */
        holdReason =
          "the visitor chose monthly-flexible billing but the catalogue has no flexible " +
          "price for this tier — the draft is annual-priced, reprice it before sending";
      } else {
        const decision = decideAutoSend({
          termAssumed: false,
          seats,
          seatsHeardNotWritten: false,
          recipient: email,
          quoteId: draftQuoteId,
          emailConfigured: isEmailConfigured(),
          senderIsOurs: ourAddresses.includes(email.trim().toLowerCase()),
          isSelfTest: false,
        });
        if (decision.send) {
          const sent = await sendAutoQuote(admin, {
            tenantId,
            quoteId: draftQuoteId,
            leadId,
            recipient: email,
            fromEmail: FROM_EMAIL,
          });
          autoSent = sent === "sent";
          if (!autoSent) holdReason = "the quotation email failed to send — the draft is saved";
        } else {
          holdReason = decision.reason;
        }
      }

      if (!autoSent && holdReason) {
        /* The same sentence shape the inbound path writes, so the operator reads ONE kind
           of hold note wherever the enquiry came from. */
        await admin.from("lead_activities").insert({
          tenant_id: tenantId, lead_id: leadId, kind: "note",
          detail: `Quote not sent automatically — ${holdReason}`,
        });
      }
    }

    const settled = await Promise.allSettled([
      /* ── EMAIL 1: owner alert — not for a trial request (owner, 30 Sep 2026: "Remove
         this feature completely. That will just annoy the owner."). Staff still see the
         trial as a lead. ─────────────────────────────────────────────────── */
      owner.ok && !trial && sendEmail({
        to:      owner.to,
        from:    FROM_EMAIL,
        kind:    "buy_page_lead_alert",
        route:   { tenantId },
        replyTo: email,            // hit Reply to talk to the lead directly
        subject: `🔔 New ${tierName} lead — ${companyName} (${seats} users · ${valueFmt})`,
        text:
`A new buy-page enquiry just landed in your pipeline.

COMPANY     ${companyName}
CONTACT     ${fullName} <${email}>
PHONE       ${phone}
PLAN        Google Workspace ${tierName}
SEATS       ${seats}
EST. VALUE  ${valueFmt}
BILLING     ${billing}
${message ? `MESSAGE     ${message}\n` : ""}
${autoSent
  ? `The quotation (${draftQuoteId}) was EMAILED AUTOMATICALLY with the PDF — nothing to do unless they reply.\nView it: ${draftUrl}`
  : draftQuoteId
    ? `A draft quote (${draftQuoteId}) is ready but was NOT auto-sent — ${holdReason ?? "held"}.\nReview & send: ${draftUrl}`
    : `Open the lead to build a quote:\n${APP_URL}/leads/${leadId}`}

— ResellerOS`,
      }),

      /* ── EMAIL 2: Customer acknowledgement ─────────────────────────────
         Every identity in this body used to be hardcoded: it promised "a WhatsApp
         message from Pardeep (he runs Excel Technologies himself)", gave a fixed
         phone number, and signed off "Google Premier Partner · since 2014". On a
         storefront owned by any other tenant that is three false statements to a
         stranger — including a partner certification this code cannot know the
         tenant holds. Named from the tenant row now, and anything absent is left
         out rather than guessed. Needs a reply-to because a customer told to reply
         is owed somewhere for the reply to land: support for the storefront
         (lib/email/storefront-voice.ts), the owner for a reseller tenant. */
      customerReplyTo && sendEmail({
        to:      email,
        from:    FROM_EMAIL,
        replyTo: customerReplyTo,
        kind:    "buy_page_lead_ack",
        route:   { tenantId },
        subject: `Got it, ${fullName.split(" ")[0]} — your Google Workspace quote is on the way`,
        text:
`Hi ${fullName.split(" ")[0]},

Thanks for the enquiry. Here's what you'll get from us shortly:

• A custom GST quote for ${seats} Google Workspace ${tierName} users
• Answers to any migration / setup / pricing questions${ownerTenant?.phone?.trim() ? `\n• A call or WhatsApp from ${voice ? "our team" : ownerName || "our team"} on ${ownerTenant.phone.trim()}` : ""}

WHAT WE HAVE FROM YOU
  Company    ${companyName}
  Plan       Google Workspace ${tierName}
  Seats      ${seats}
  Billing    ${billing}

Just reply to this email if anything above is wrong, or if you'd like to add detail.

${voice ? voice.signOff : `— ${ownerName || ownerTenant?.name?.trim() || "Your reseller"}${
  ownerTenant?.name?.trim() && ownerName !== ownerTenant.name.trim()
    ? `\n   ${ownerTenant.name.trim()}`
    : ""
}`}`,
      }),
    ]);
    {
      const labels = ["owner alert", "customer acknowledgement"];
      settled.forEach((r, i) => {
        /* `owner.ok && sendEmail(...)` yields the literal `false` when unaddressed,
           so a settled value is not necessarily a send result. Checked before it is
           read as one — otherwise a skipped send reads as a successful send. */
        if (r.status === "rejected") {
          console.error(`[enquiry/workspace] ${labels[i]} failed:`, r.reason);
        } else if (r.value && r.value.status === "failed") {
          console.error(`[enquiry/workspace] ${labels[i]} failed:`, r.value.errorMessage);
        }
      });
    }
    /* Did the customer's copy really go? false when it was skipped (no owner address) or
       failed — the form says "check your inbox" only when this is true (30 Sep 2026). */
    const ack = settled[1];
    const ackSent = ack.status === "fulfilled" && !!ack.value && ack.value.status === "sent";

    /* autoSent, taki website ka confirmation sach bole — "emailed with the PDF" sirf
       tab jab sach me gaya ho, warna "drafted, review ke baad". */
    return NextResponse.json({ success: true, leadId, draftQuoteId, autoSent, ackSent });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[/api/public/enquiry/workspace] crashed:", message);
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
