/**
 * POST /api/quotes/[id]/send — email a quote PDF to the customer.
 *
 * Replaces the legacy `mailto:` flow with a real server-side send that:
 *   1. Renders the Quote PDF on the server (no client roundtrip).
 *   2. Attaches it to a tenant-branded email via lib/email/send.ts.
 *   3. Logs the attempt in quote_send_log (audit + idempotency check).
 *   4. Atomically flips quote.status 'draft' → 'sent' on success.
 *
 * Works in BOTH email modes:
 *   - Stub (no RESEND_API_KEY): logs to console + DB as 'stubbed', still
 *     marks quote as sent so the UI / downstream automation continues.
 *   - Real (RESEND_API_KEY present): hits Resend, captures the message ID.
 *
 * Auth: regular user session (Supabase cookies). Tenant scope enforced by
 * looking up the user's tenant_id and verifying the quote belongs to it.
 *
 * Body: { to: string; cc?: string[]; subject?: string; message?: string }
 *   - `to` falls back to the customer's PRIMARY CONTACT when omitted (was
 *     customer.contact_email until 10 Sep 2026).
 *   - `subject` / `message` default to a sane template when omitted.
 */

import { NextResponse } from "next/server";
import { createClient, createAdminClientFor } from "@/lib/supabase/server";
import { primaryContactEmail } from "@/lib/contacts/primary";
import { sendEmail, isEmailConfigured } from "@/lib/email/send";
import { renderQuotePDF } from "@/lib/pdf";
import { replyToAddress } from "@/lib/email/reply-to";
import { logoDataUri } from "@/lib/pdf/logo";
import { stageAfterQuoteSent } from "@/lib/leads/stage-after-quote-sent";
import { quoteContact } from "@/lib/quotes/quote-contact";
import { firstChaseAfterSend } from "@/lib/ai/cadence";
import { scheduleSalesLoop } from "@/lib/ai/sales-loops.server";
import { buildQuoteUpiQr } from "@/lib/pdf/upi-qr";
import { quoteAmountDue } from "@/lib/payments/amount-due";
import { rupee } from "@/lib/utils";
import { quotePlaceOfSupply } from "@/lib/quotes/quote-place-of-supply";
import { quoteAcceptUrl } from "@/lib/quotes/accept-link";
import { buildCustomerQuoteHtml } from "@/lib/email/quote-template";
import type { QuoteLineItem } from "@/lib/supabase/database.types";
import { quoteDisplayTax } from "@/lib/quotes/quote-tax";
import { extensionTitle, isOneTimeQuote } from "@/lib/quotes/service-period";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface SendBody {
  to?:      string;
  cc?:      string[];
  subject?: string;
  message?: string;
}

export async function POST(req: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  // ── 1. Authn ─────────────────────────────────────────────────────
  const userClient = createClient();
  const { data: authData } = await userClient.auth.getUser();
  if (!authData?.user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Resolve current user → tenant_id
  const { data: me, error: meErr } = await userClient
    .from("users")
    .select("tenant_id, full_name")
    .eq("id", authData.user.id)
    .single();
  if (meErr || !me) {
    return NextResponse.json({ error: "user not linked to a tenant" }, { status: 403 });
  }

  // ── 2. Parse body ────────────────────────────────────────────────
  let body: SendBody = {};
  try { body = await req.json(); } catch { /* empty body is OK */ }

  const supabase = createAdminClientFor(authData.user.id);

  /* ── 3. Load quote (scoped to tenant) ─────────────────────────────
     `lead_id` was added to this select on 24 Aug 2026 and its absence is part of why
     Darshan's bug lasted: this route had no idea which lead it was quoting for, so it could
     not have moved the stage even if somebody had thought to.

     NOTE the comment lives out here. A block comment inside the select STRING breaks
     supabase-js's type-level parser — it reads that string to derive the row type, and the
     first attempt turned every field on `quote` into a ParserError.

     Second lesson from the same two minutes: writing the words for a block comment INSIDE a
     block comment closes it early. That is what the four TS1005 errors after the first fix
     were. */
  const { data: quote, error: qErr } = await supabase
    .from("quotes")
    .select(`
      id, tenant_id, customer_id, customer_name, plan, seats, amount,
      status, payment_status, line_items, subtotal, discount_pct, tax_rate,
      created_date, expires_date, notes, is_renewal, is_add_seats, is_one_off, is_extension, extension_months, public_token, lead_id,
      prospect_state_code, prospect_country
    `)
    .eq("id", params.id)
    .single();
  if (qErr || !quote) {
    return NextResponse.json({ error: "quote not found" }, { status: 404 });
  }
  if (quote.tenant_id !== me.tenant_id) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (quote.status === "accepted" || quote.status === "rejected") {
    return NextResponse.json(
      { error: `cannot resend — quote is ${quote.status}` },
      { status: 400 }
    );
  }

  // ── 4. Tenant + customer info ────────────────────────────────────
  const { data: tenant } = await supabase
    .from("tenants")
    .select("name, email, phone, gstin, address, state, state_code, upi_vpa, upi_payee_name, logo_url")
    .eq("id", me.tenant_id)
    .single();
  if (!tenant) {
    return NextResponse.json({ error: "tenant not found" }, { status: 404 });
  }

  /* The mailbox the app READS — Reply-To must land there, or the customer's answer never
     reaches the pipeline. See lib/email/reply-to.ts. */
  const { data: ingestBoxes } = await supabase
    .from("user_google_tokens")
    .select("google_email")
    .eq("tenant_id", me.tenant_id);

  const { data: customer } = quote.customer_id
    ? await supabase
        .from("customers")
        .select("name, contact_name, contact_email, contact_phone, gstin, state_code, country")
        .eq("id", quote.customer_id)
        .single()
    : { data: null };
  /* R-376 (f): a quote raised on a lead has no customer yet — the lead's state is the place
     of supply. Without it the emailed PDF said "Intra-state" for an out-of-state lead. */
  const { data: lead } = !quote.customer_id && quote.lead_id
    ? await supabase.from("leads").select("state_code, gstin, country, contact_name, contact_email, contact_phone").eq("id", quote.lead_id).maybeSingle()
    : { data: null };
  const pos = quotePlaceOfSupply({ customer, lead, quote, seller: tenant });

  // ── 5. Resolve recipient ─────────────────────────────────────────
  /* The customer's PRIMARY CONTACT. customers.contact_email stopped being the truth on
     10 Sep 2026 — a customer's people live in `contacts`, one marked primary. The
     resolver keeps the old column as a floor so nobody becomes unreachable. */
  const resolvedContact = quote.customer_id
    ? await primaryContactEmail(supabase, quote.customer_id)
    : { email: null, name: null, fromLegacy: false };
  const recipient = (body.to ?? resolvedContact.email ?? "").trim();
  if (!recipient || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
    return NextResponse.json(
      { error: "no valid recipient — set customer contact email or pass `to`" },
      { status: 400 }
    );
  }

  // ── 6. Build subject + body ──────────────────────────────────────
  const subtotal    = quote.subtotal ?? quote.amount;
  const discount    = Math.round(subtotal * ((quote.discount_pct ?? 0) / 100));
  const taxable     = subtotal - discount;
  const taxRate     = quote.tax_rate ?? 18;
  const tax         = quoteDisplayTax(taxable, taxRate, quote.amount); // R-804
  const total       = quote.amount ?? taxable + tax;
  const lineItems   = (quote.line_items ?? []) as QuoteLineItem[];

  // Build the accept/pay link from the ACTUAL host the request came in on, not
  // NEXT_PUBLIC_APP_URL — that's baked at build time to a domain that may not be
  // live yet (dead links). Honours the Cloud Run proxy's x-forwarded-* headers.
  const linkProto = req.headers.get("x-forwarded-proto") ?? "https";
  const linkHost  = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  const linkBase  = linkHost ? `${linkProto}://${linkHost}` : new URL(req.url).origin;
  const customerUrl = quoteAcceptUrl(linkBase, quote.id, quote.public_token);
  if (!customerUrl) {
    /* Practically unreachable — `linkBase` comes from the request's own headers, so a real
       HTTP request always has one. Guarded anyway because of what the alternative looks
       like: the body below interpolates `${customerUrl}` directly, so a null would mail the
       customer a line reading "You can review and accept the quote online:" followed by the
       word "null". Refusing is the smaller failure, and it says which piece is missing.

       quoteAcceptUrl started returning null on 23 Aug 2026, after an empty base was found
       silently producing a RELATIVE path in renewal emails — unclickable, and unreported. */
    return NextResponse.json(
      { error: "Could not build the customer's accept link for this quote, so nothing was sent. The app URL could not be determined from the request." },
      { status: 500 },
    );
  }
  const subject     = body.subject?.trim() ||
                      `Quotation ${quote.id} from ${tenant.name}`;
  const greetName   = customer?.contact_name || quote.customer_name;
  const messageBody = body.message?.trim() || (
`Hi ${greetName},

Please find your quotation ${quote.id} attached as a PDF.

Total: ${rupee(total)}
Validity: ${quote.expires_date ? `up to ${quote.expires_date}` : "30 days"}

You can review and accept the quote online:
${customerUrl}

If you have any questions or need adjustments (seat count, plan tier, billing cycle), just reply to this email.

Thanks,
${me.full_name ?? tenant.name}
${tenant.name}${tenant.phone ? `\n${tenant.phone}` : ""}${tenant.email ? `\n${tenant.email}` : ""}`
  );

  const htmlBody = buildCustomerQuoteHtml({
    quoteId: quote.id,
    customerName: greetName,
    tenantName: tenant.name,
    tenantEmail: tenant.email,
    tenantPhone: tenant.phone,
    totalAmount: total,
    expiresDate: quote.expires_date,
    acceptUrl: customerUrl,
    lineItems: lineItems.map((li) => ({ name: li.name, qty: li.qty, rate: li.rate })),
  });

  // ── 7. Render PDF attachment ─────────────────────────────────────
  // This is the PDF the customer actually receives, so the scan-to-pay QR
  // matters more here than on the in-app download. quoteAmountDue() decides
  // whether one is offered at all — it refuses non-INR quotes (UPI settles only
  // in rupees) and quotes already invoiced (the invoice owns that ask).
  const tenantUpi = tenant as { name?: string; upi_vpa?: string | null; upi_payee_name?: string | null };
  const upi = await buildQuoteUpiQr({
    vpa:       tenantUpi.upi_vpa,
    payeeName: tenantUpi.upi_payee_name ?? tenant.name,
    quoteId:   quote.id,
    amountDue: quoteAmountDue(quote),
  });

  let attachments: { filename: string; content: Buffer; contentType: string }[] | undefined;
  try {
    const blob = await renderQuotePDF({
      tenantLogo:    await logoDataUri((tenant as { logo_url?: string | null }).logo_url),
      upiQrDataUrl: upi?.dataUrl ?? null,
      upiVpa:       upi?.vpa ?? null,
      tenantName:    tenant.name,
      tenantGstin:   tenant.gstin,
      tenantEmail:   tenant.email,
      tenantPhone:   tenant.phone,
      tenantAddress: tenant.address,
      quoteId:       quote.id,
      customerName:  quote.customer_name,
      /* R-445 (1): a lead quote's PDF names the lead's person, as the in-app preview does. */
      ...quoteContact(customer, lead),
      lineItems,
      subtotal,
      discountPct:   quote.discount_pct ?? 0,
      discount,
      taxable,
      taxRate,
      tax,
      total,
      // GST head derived from seller (tenant) vs buyer (customer) state. (audit #18-20)
      interState:    pos.interState,
      isExport:      pos.isExport,
      /* R-376 (f): "Haryana (06) · IGST" — state name and code, not just the head. */
      placeOfSupply: pos.label,
      validityDays:  30,
      notes:         quote.notes ?? undefined,
      isRenewal:     quote.is_renewal,
      oneTime:       isOneTimeQuote({
        isAddSeats: quote.is_add_seats, isOneOff: quote.is_one_off,
        isExtension: quote.is_extension, extensionMonths: quote.extension_months,
      }),
      extensionTitle: extensionTitle({ isExtension: quote.is_extension, extensionMonths: quote.extension_months }),
    });
    const arrBuf = await blob.arrayBuffer();
    attachments = [{
      filename:    `Quote-${quote.id}.pdf`,
      content:     Buffer.from(arrBuf),
      contentType: "application/pdf",
    }];
  } catch (pdfErr) {
    // Non-fatal — email still goes with link, but log it.
    // eslint-disable-next-line no-console
    console.warn(`[quotes/send] PDF render failed for ${quote.id}:`, (pdfErr as Error).message);
  }

  // ── 8. Send ──────────────────────────────────────────────────────
  const sendResult = await sendEmail({
    to:      recipient,
    /* Bina `route` ke sendEmail default Resend par jata hai — send.ts:26 khud kehta
       hai "Callers that omit `route` … still go through Resend." Resend test mode me
       hai, isliye apne address ke alawa kahin quote bhejna fail hota tha. */
    route:   { tenantId: me.tenant_id },
    subject,
    text:    messageBody,
    html:    htmlBody,
    from:    tenant.email ?? undefined,
    /* The mailbox the app INGESTS — see lib/email/reply-to.ts. Pointing this at the owner's
       address took every customer reply out of the pipeline, silently. */
    replyTo: replyToAddress(ingestBoxes, tenant.email),
    attachments,
  });

  // ── 9. Audit log ─────────────────────────────────────────────────
  await supabase.from("quote_send_log").insert({
    tenant_id:       me.tenant_id,
    quote_id:        quote.id,
    recipient_email: recipient,
    cc_emails:       body.cc && body.cc.length > 0 ? body.cc : null,
    subject,
    status:          sendResult.status,
    provider_id:     sendResult.providerId,
    error_message:   sendResult.errorMessage,
    sent_by:         authData.user.id,
  });

  // ── 10. Flip quote.status draft → sent on success ────────────────
  if (sendResult.status === "sent" || sendResult.status === "stubbed") {
    if (quote.status === "draft") {
      const { error: statusErr } = await supabase
        .from("quotes")
        .update({ status: "sent" })
        .eq("id", quote.id);
      /* Checked now. An unchecked write here is the same fault found in send-auto-quote.ts
         hours earlier: supabase-js does not throw, so the quote stays `draft` while the
         customer holds it and the next person sends it again. */
      if (statusErr) console.error(`[quotes/send] could not mark ${quote.id} sent:`, statusErr);
    }

    /* ── AND MOVE THE LEAD INTO "Quote Sent" ─────────────────────────────────
       Darshan's report, 24 Aug 2026: "Customer ko quotation sent kar di lekin Quote sent
       mein show nahi kar raha." He was right — "Quote Sent" is a lead STAGE
       (folders.ts: `l.stage === "quote"`), and the ONLY place that ever set it was the
       public buy-page checkout. This route, the auto-quote and renewals all left it alone,
       so the quote went and the column named after that act stayed empty.

       This does not contradict the morning's decision that the app should nudge rather than
       advance stages. It is the same rule: automation opens on a FACT. "An activity was
       logged" is a guess about what it meant; "a quote was emailed to this customer" is
       exactly what the words Quote Sent describe.

       Forward only — stageAfterQuoteSent refuses to drag a Won or Lost lead back. Failures
       are logged and never fail the response: the mail has gone, and a stage that did not
       move is a reporting problem, not a reason to tell the operator the send failed. */
    if (quote.lead_id) {
      const { data: leadRow } = await supabase
        .from("leads")
        .select("stage")
        .eq("id", quote.lead_id)
        .eq("tenant_id", me.tenant_id)
        .maybeSingle();

      const move = stageAfterQuoteSent((leadRow as { stage?: string | null } | null)?.stage);
      if (move.nextStage) {
        const { error: stageErr } = await supabase
          .from("leads")
          .update({ stage: move.nextStage })
          .eq("id", quote.lead_id)
          .eq("tenant_id", me.tenant_id);
        if (stageErr) {
          console.error(`[quotes/send] could not move lead ${quote.lead_id} to Quote Sent:`, stageErr);
        } else {
          await supabase.from("lead_activities").insert({
            tenant_id: me.tenant_id,
            lead_id:   quote.lead_id,
            kind:      "stage",
            detail:    `Moved to Quote Sent — ${quote.id} was emailed to ${recipient}.`,
          });
        }
      } else {
        console.info(`[quotes/send] lead ${quote.lead_id} stage unchanged — ${move.reason}`);
      }
    }

    /* ── AND PLAN THE CHASE (R-115) ──────────────────────────────────────────
       Only quotes the AI sent used to get the follow-up cadence; one a person sent from here
       got nothing. The first real send (draft → sent, mail actually delivered — not a stub
       when email is unconfigured, and not a resend that would restart the cadence) schedules
       step 2. The cron then re-checks reply / won / lost / accepted / paid before every touch,
       and `followup.send` decides whether it is sent or only drafted. Never fails the send. */
    if (quote.lead_id && quote.status === "draft" && sendResult.status === "sent") {
      const chase = firstChaseAfterSend(new Date());
      if (chase) {
        const ok = await scheduleSalesLoop({ tenantId: quote.tenant_id, leadId: quote.lead_id, ...chase });
        if (!ok) console.error(`[quotes/send] could not plan the follow-up for lead ${quote.lead_id}`);
      }
    }
  }

  return NextResponse.json({
    status:       sendResult.status,
    email_mode:   isEmailConfigured() ? "real" : "stub",
    providerId:   sendResult.providerId,
    errorMessage: sendResult.errorMessage,
    recipient,
    attachedPdf:  !!attachments,
    quoteStatus:  sendResult.status === "failed" ? quote.status : "sent",
  });
}
