/**
 * POST /api/public/quote/[id]/upi-notify?t=<token>
 *
 * "I've sent the payment by UPI." Emails the reseller to go and check their account.
 *
 * ─── THIS ROUTE DELIBERATELY RECORDS NO PAYMENT ─────────────────────────────
 * A direct UPI transfer lands in the reseller's bank, not through a gateway, so there
 * is no webhook and nothing here can verify a rupee arrived. The only fact this
 * endpoint has is that somebody with the quote link says they paid.
 *
 * Turning that into a payment row would put an unverified amount into the reseller's
 * books — reconciled reports, GST filings and the customer's outstanding balance all
 * read from those rows. It would also be trivially abusable: the link is the only
 * credential, so "mark this quote paid" would be one curl away.
 *
 * So: no record_payment, no status change, no payment_status change. An email, and a
 * human decides. That is the whole endpoint, and the restraint is the feature.
 */
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { quoteTokenMatches } from "@/lib/quotes/accept-token";
import { sendInternalEmail } from "@/lib/messaging";
import { rupee } from "@/lib/utils";
import { maskContactValue } from "@/lib/security/redact-contact";

export async function POST(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const admin = createAdminClient();

  const { data: quote } = await admin
    .from("quotes")
    .select("id, status, tenant_id, public_token, customer_name, amount, payment_status")
    .eq("id", params.id)
    .maybeSingle();

  if (!quote || !quoteTokenMatches(request.nextUrl.searchParams.get("t"), quote.public_token)) {
    return NextResponse.json({ error: "Quote not found" }, { status: 404 });
  }
  if (quote.status === "draft") {
    return NextResponse.json({ error: "Quote not found" }, { status: 404 });
  }
  if (quote.payment_status === "received" || quote.payment_status === "invoiced") {
    /* Already settled. Saying so beats sending the reseller to hunt for a payment
       they already banked. */
    return NextResponse.json({ ok: true, alreadySettled: true });
  }

  let signerName = "";
  try {
    const body = (await request.json()) as Record<string, unknown>;
    if (typeof body.signerName === "string") signerName = body.signerName.trim().slice(0, 200);
  } catch { /* no body is fine */ }

  const { data: tenant } = await admin
    .from("tenants").select("name, email").eq("id", quote.tenant_id).maybeSingle();

  if (!tenant?.email) {
    /* No inbox to notify. Told plainly rather than returning a cheerful ok — the
       customer needs to know their message went nowhere so they can phone instead. */
    return NextResponse.json(
      { error: "We could not reach the reseller by email — please call them to confirm your payment." },
      { status: 503 },
    );
  }

  await sendInternalEmail({
    /* Bina `route` ke ye default Resend par jata hai (send.ts:26), aur wo test mode
          me hai. Tenant ne Gmail chuna hai to mail wahi se jaye. */
    route: { tenantId: quote.tenant_id },
    to: tenant.email,
    subject: `UPI payment claimed on quote ${quote.id} — please verify`,
    text:
`${signerName || quote.customer_name} says they have paid quote ${quote.id} by UPI.

  Quote      ${quote.id}
  Customer   ${quote.customer_name}
  Amount     ${rupee(quote.amount ?? 0)}

NOTHING HAS BEEN RECORDED. There is no gateway on a direct UPI transfer, so this is
the customer's word and not a confirmation. Check your bank account, then record the
payment in ResellerOS so the invoice and the customer's balance are right.`,
  });

  console.info(`[upi-notify] ${quote.id} — claim relayed to ${maskContactValue(tenant.email)}, nothing recorded`);
  return NextResponse.json({ ok: true, recorded: false });
}
