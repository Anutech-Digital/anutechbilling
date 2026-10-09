/**
 * Public quote-accept page — what the customer sees when they click the
 * link in the quote email/WhatsApp message.
 *
 * Server Component: fetches via admin client (bypasses RLS since the customer
 * isn't logged in). Quote ID is the secret — short, B2B context, low enumeration risk.
 *
 * Customer can accept, request changes, or print the quote here.
 */
import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { createAdminClient } from "@/lib/supabase/server";
import type { Quote, QuoteLineItem, LineCommitment } from "@/lib/supabase/database.types";
import { quoteTokenMatches } from "@/lib/quotes/accept-token";
import { buildQuoteUpiQr } from "@/lib/pdf/upi-qr";
import { quoteUpiAmount } from "./upi-amount";
import { acceptedPayNow } from "./accepted-pay";
import { quotePlaceOfSupply } from "@/lib/quotes/quote-place-of-supply";
import { signerNameDefault } from "./signer-default";
import { includedSupportLine } from "@/lib/pdf/quote-support-line";
import { QuoteAcceptView, type PublicQuote, type PublicLine } from "./quote-accept-view";
import { QuoteReplaced, replacementHref } from "./replaced";
import { isBotUserAgent } from "@/lib/quotes/quote-intent";
import { maybeAlertHotLead, recordQuoteView } from "@/lib/quotes/quote-views.server";

export const dynamic = "force-dynamic"; // never cache — quotes change state

interface Props {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ t?: string }>;
}

export async function generateMetadata(props: Props) {
  const searchParams = await props.searchParams;
  const params = await props.params;
  // Resolve the supplier name — but ONLY when the link carries the right token,
  // so the tab/share preview can't be used to confirm a quote exists (SEC-1).
  const supabase = createAdminClient();
  const { data: quote } = await supabase
    .from("quotes").select("tenant_id, public_token").eq("id", params.id).maybeSingle();
  let supplier = "your reseller";
  if (quote && quoteTokenMatches(searchParams.t, quote.public_token)) {
    const { data: tenant } = await supabase
      .from("tenants").select("name").eq("id", quote.tenant_id).maybeSingle();
    supplier = tenant?.name ?? supplier;
  }
  return {
    title: "Review & Accept your quote",
    description: `Review and accept your quote from ${supplier}.`,
    robots: "noindex",  // not search-engine indexable
  };
}

export default async function QuoteAcceptPage(props: Props) {
  const searchParams = await props.searchParams;
  const params = await props.params;
  const supabase = createAdminClient();

  // Fetch quote (admin client bypasses RLS). We DON'T select cost columns —
  // total_cost / per-line cost must never reach the customer's browser. Every
  // prop passed to the client view is serialized into the HTML payload.
  const { data: quote, error } = await supabase
    .from("quotes")
    // payment_status / payment_amount / invoice_id are here for quoteAmountDue, which
    // refuses to build a UPI QR for money already settled or already asked for on an
    // invoice — two documents collecting the same amount is how a customer pays twice.
    .select("id, status, tenant_id, public_token, customer_name, subtotal, discount_pct, tax_rate, amount, expires_date, notes, line_items, billing_cycle, currency, exchange_rate, payment_status, payment_amount, invoice_id, hot_lead_alerted_at, customer_id, lead_id, prospect_state_code, prospect_country")
    .eq("id", params.id)
    .maybeSingle();

  if (error || !quote) {
    notFound();
  }

  // Authorization: unguessable ?t=<token> must match. No token → "not found"
  // (identical to a missing quote, so ids can't be enumerated). (SEC-1)
  if (!quoteTokenMatches(searchParams.t, quote.public_token)) {
    notFound();
  }

  // Don't expose draft quotes via public link — they're not meant for customer eyes
  if (quote.status === "draft") {
    notFound();
  }

  /* R-448: a replaced quote shows "This quote was replaced" + a link to the new one, never
     the Accept button. Read in its own query so this page keeps working if the column is
     not there yet (the error is simply ignored). */
  const { data: rev } = await supabase
    .from("quotes").select("superseded_by").eq("id", quote.id).maybeSingle();
  if (rev?.superseded_by) {
    const [{ data: next }, { data: t }] = await Promise.all([
      supabase.from("quotes").select("id, status, public_token")
        .eq("id", rev.superseded_by).eq("tenant_id", quote.tenant_id).maybeSingle(),
      supabase.from("tenants").select("name").eq("id", quote.tenant_id).maybeSingle(),
    ]);
    return (
      <QuoteReplaced
        quoteId={quote.id}
        newId={rev.superseded_by}
        href={replacementHref(next)}
        tenantName={t?.name ?? "Your reseller"}
      />
    );
  }

  /* ── VIEW TRACKING ────────────────────────────────────────────────────────
     Recorded HERE, on our own page, rather than by an analytics pixel. The brief asked for a
     pixel and it fails in the expensive direction: Gmail pre-fetches images through its proxy,
     so a pixel fires with no human involved, and three of those tell a rep to ring somebody who
     never opened the quote. A false hot lead costs more than a missed one — after two of them
     nobody acts on the third.

     Placed AFTER the token check and the draft check on purpose: a fetch that was not allowed
     to see the quote is not a view of it, and counting enumeration attempts as customer
     interest would be the easiest possible way to fake a hot lead.

     Awaited rather than fired and forgotten, because a Server Component's floating promise can
     be cut off when the render finishes — but it never throws, so a failed analytics write
     cannot stop a customer reading their quote. See lib/quotes/quote-views.server.ts. */
  const ua = (await headers()).get("user-agent");
  await recordQuoteView({
    tenantId: quote.tenant_id,
    quoteId: quote.id,
    userAgent: ua,
    /* First hop of X-Forwarded-For — Cloud Run puts the client there. Hashed with a salt
       before storage; the address itself is never written. */
    ip: ((await headers()).get("x-forwarded-for") ?? "").split(",")[0].trim() || null,
  });

  /* And then, only if this is a person reading it repeatedly, tell the desk. Once.
     Not gated by the autonomy dial: this is the app talking to OUR OWN desk, the same
     exemption the SLA breach alert has and the same reason `compliance.send` was removed from
     the registry — the dial must never be able to silence what the app says to us. */
  if (!isBotUserAgent(ua)) {
    await maybeAlertHotLead({
      admin: supabase,
      tenantId: quote.tenant_id,
      quoteId: quote.id,
      customerName: quote.customer_name ?? "",
      amount: quote.amount ?? 0,
      alreadyAlertedAt: quote.hot_lead_alerted_at ? new Date(quote.hot_lead_alerted_at) : null,
    }).catch((err) => console.error("[quote/accept] hot-lead check failed:", err));
  }

  // Fetch tenant info for the brand header. Phone + address help the customer
  // contact the reseller before accepting (especially for India where WhatsApp
  // calls happen on the visible phone number).
  const { data: tenant } = await supabase
    .from("tenants")
    .select("name, gstin, email, phone, address, upi_vpa, upi_payee_name, state_code")
    .eq("id", quote.tenant_id)
    .maybeSingle();

  // Mark quote as "viewed" if currently "sent" — fire and forget
  if (quote.status === "sent") {
    void supabase.from("quotes").update({ status: "viewed" }).eq("id", quote.id);
  }

  // Build a customer-SAFE projection — never the raw row. Line items keep only
  // the display fields; cost/margin are dropped.
  const publicQuote: PublicQuote = {
    id: quote.id,
    status: quote.status,
    customer_name: quote.customer_name,
    subtotal: quote.subtotal,
    discount_pct: quote.discount_pct,
    tax_rate: quote.tax_rate,
    amount: quote.amount,
    expires_date: quote.expires_date,
    notes: quote.notes,
    billing_cycle: quote.billing_cycle,
    currency: quote.currency,
    exchange_rate: quote.exchange_rate,
  };
  const lineItems: PublicLine[] = ((quote.line_items ?? []) as QuoteLineItem[]).map((l) => ({
    id: l.id, name: l.name, qty: l.qty, rate: l.rate, commitment: l.commitment,
    /* R-495: the list price the line was priced from, so the customer sees list →
       discount → final. A selling price the reseller shows on the PDF anyway — not cost. */
    ...(typeof l.list_rate === "number" ? { list_rate: l.list_rate } : {}),
    // What the reseller marked adjustable. Cost and margin are still dropped.
    optional: l.optional, included_by_default: l.included_by_default,
    seats_adjustable: l.seats_adjustable, min_seats: l.min_seats, max_seats: l.max_seats,
  }));

  // Offer "Pay online" only when the reseller has Razorpay wired AND the quote
  // is in ₹ (Razorpay charges INR; a foreign-currency total would mismatch).
  // The pay route re-checks everything authoritatively — this only gates the UI.
  const { data: rzSecret } = await supabase
    .from("tenant_secrets")
    .select("razorpay_key_id, razorpay_key_secret")
    .eq("tenant_id", quote.tenant_id)
    .maybeSingle();
  const rzConfigured =
    Boolean(rzSecret?.razorpay_key_id && rzSecret?.razorpay_key_secret) ||
    Boolean(
      (process.env.RAZORPAY_KEY_ID || process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID) &&
      process.env.RAZORPAY_KEY_SECRET,
    );
  const quoteIsForeign = !!quote.currency && quote.currency.toUpperCase() !== "INR";
  const payOnline = rzConfigured && !quoteIsForeign;

  /* UPI straight to the reseller's own VPA — built server-side because the QR needs
     the `qrcode` package, which has no business in a customer's bundle.
     `buildQuoteUpiQr` returns null for a non-₹ quote, a malformed VPA, or an
     already-invoiced quote (two documents asking for the same money is how a
     customer pays twice). Null simply means the block does not render. */
  /* R-234: on a split-billed quote the QR asks for instalment 1 — the same figure the
     Pay button charges — not the whole term. See ./upi-amount.ts. */
  const upiAmount = quoteUpiAmount(quote, lineItems[0]?.commitment ?? null);
  const upiQrImg = await buildQuoteUpiQr({
    vpa:        tenant?.upi_vpa,
    payeeName:  tenant?.upi_payee_name || tenant?.name,
    quoteId:    quote.id,
    amountDue:  upiAmount,
  });
  const upi = upiQrImg ? { ...upiQrImg, amount: upiAmount } : null;

  /* R-377: what the ACCEPTED screen offers to collect — the same figure the pay route
     charges, and only when this tenant has a way to be paid. See ./accepted-pay.ts. */
  const acceptedPay = acceptedPayNow({
    quote,
    firstCommitment: lineItems[0]?.commitment ?? null,
    payOnline,
    hasUpi: Boolean(upi),
  });

  /* R-376(b): the tax heads exactly as the quote preview / PDF print them — seller vs
     buyer state through the shared place-of-supply helper (same call as the send route).
     Only state codes and GSTINs are read; only the resulting boolean reaches the page.
     R-376 (f): a quote raised on a LEAD (no customer yet) takes the lead's state — before,
     it fell to the intra-state default and showed CGST + SGST to an out-of-state buyer.
     R-376 (d): the contact person's NAME is read too, for the signer box — nothing else. */
  const [{ data: buyer }, { data: lead }] = await Promise.all([
    quote.customer_id
      ? supabase
          .from("customers")
          .select("gstin, state_code, country, contact_name, contact_first_name, contact_last_name")
          .eq("id", quote.customer_id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    !quote.customer_id && quote.lead_id
      ? supabase
          .from("leads")
          .select("gstin, state_code, country, contact_name")
          .eq("id", quote.lead_id)
          .eq("tenant_id", quote.tenant_id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ]);
  const { interState } = quotePlaceOfSupply({
    customer: buyer, lead, quote, seller: { state_code: tenant?.state_code, gstin: tenant?.gstin },
  });
  const signerDefault = signerNameDefault({ customer: buyer, lead, company: quote.customer_name });

  /* R-376(b): "Support: Free — Included" — the same builder the preview and the PDF use,
     fed the raw lines (it needs item_id to spot a catalogue support row). */
  const supportLine = includedSupportLine((quote.line_items ?? []) as QuoteLineItem[]);

  return (
    <QuoteAcceptView
      quote={publicQuote}
      lineItems={lineItems}
      token={searchParams.t ?? ""}
      payOnline={payOnline}
      tenantName={tenant?.name ?? "Reseller"}
      tenantGstin={tenant?.gstin ?? null}
      tenantEmail={tenant?.email ?? null}
      tenantPhone={tenant?.phone ?? null}
      tenantAddress={tenant?.address ?? null}
      upiQr={upi}
      acceptedPay={acceptedPay}
      interState={interState}
      signerDefault={signerDefault}
      supportLine={supportLine ? { text: supportLine.text, detail: supportLine.detail } : null}
    />
  );
}

// Helper re-exports so the view can use them (could move to shared lib later)
export type { Quote, QuoteLineItem, LineCommitment };
