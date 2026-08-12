/**
 * POST /api/public/quote/[id]/accept
 *
 * Customer-side action: marks the quote as accepted + sets payment_status to awaiting.
 * Uses admin client (bypasses RLS) since the customer isn't authenticated.
 * Quote ID is the implicit secret.
 */
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { isQuoteExpired, rupee } from "@/lib/utils";
import { quoteTokenMatches } from "@/lib/quotes/accept-token";
import { sendEmail } from "@/lib/email/send";
import { buildSalesAcknowledgementHtml } from "@/lib/email/quote-template";

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createAdminClient();

  // 1. Fetch the quote to validate state + authorize the caller by token
  const { data: quote, error: qErr } = await supabase
    .from("quotes")
    .select("id, status, payment_status, expires_date, customer_name, tenant_id, public_token, amount")
    .eq("id", params.id)
    .maybeSingle();

  if (qErr || !quote) {
    return NextResponse.json({ error: "Quote not found" }, { status: 404 });
  }

  // Authorization: the link carries an unguessable ?t=<token> (SEC-1). Without a
  // matching token we behave exactly like "not found" — no enumeration signal.
  const token = request.nextUrl.searchParams.get("t");
  if (!quoteTokenMatches(token, quote.public_token)) {
    return NextResponse.json({ error: "Quote not found" }, { status: 404 });
  }

  // 2. Reject drafts / already-accepted / rejected / expired
  if (quote.status === "draft") {
    return NextResponse.json({ error: "This quote hasn't been sent yet" }, { status: 400 });
  }
  if (quote.status === "accepted") {
    return NextResponse.json({ ok: true, already: true });
  }
  if (quote.status === "rejected") {
    return NextResponse.json({ error: "This quote was rejected — please reach out to the reseller" }, { status: 400 });
  }
  // Expiry judged at END OF DAY IST — a quote "valid until 30 Jun" must accept
  // through all of 30 Jun in India, not lapse at 05:30 IST (UTC midnight). (#20)
  if (isQuoteExpired(quote.expires_date)) {
    return NextResponse.json({ error: "This quote has expired — please ask the reseller for a fresh one" }, { status: 400 });
  }

  // 3. Accept + convert the linked lead → customer atomically via accept_quote
  //    (migration 0059 made the RPC service-role safe — it derives the tenant
  //    from the quote when there's no auth context). This is the SAME path the
  //    operator's "Mark accepted" uses, so a customer self-accept now also
  //    creates the customer record, advances the lead to 'won', and sets
  //    payment_status='awaiting' — instead of only flipping the quote status
  //    and leaving the deal un-converted until payment landed (#17).
  const { error: acceptErr } = await supabase.rpc("accept_quote", {
    p_quote_id: params.id,
  });

  if (acceptErr) {
    return NextResponse.json({ error: acceptErr.message }, { status: 500 });
  }

  // 4. Send Sales Team Acknowledgement Notification Email to Reseller / Sales Exec
  try {
    const { data: tenant } = await supabase
      .from("tenants")
      .select("name, email")
      .eq("id", quote.tenant_id)
      .single();

    if (tenant?.email) {
      const ackHtml = buildSalesAcknowledgementHtml({
        quoteId: params.id,
        customerName: quote.customer_name,
        tenantName: tenant.name,
        totalAmount: quote.amount ?? 0,
        acceptedAt: new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }),
      });

      await sendEmail({
        to: tenant.email,
        subject: `🎉 Sales Alert: Quotation #${params.id} Accepted by ${quote.customer_name}`,
        text: `Customer ${quote.customer_name} accepted quotation #${params.id} for ${rupee(quote.amount ?? 0)}. Lead converted to Won customer & PO/Invoice drafts created.`,
        html: ackHtml,
      });
    }
  } catch (emailErr) {
    console.error(`[quote-accept] Failed sending sales acknowledgement email for ${params.id}:`, emailErr);
  }

  console.info(`[quote-accept] ${params.id} accepted by ${quote.customer_name} (tenant ${quote.tenant_id})`);

  return NextResponse.json({ ok: true });
}
