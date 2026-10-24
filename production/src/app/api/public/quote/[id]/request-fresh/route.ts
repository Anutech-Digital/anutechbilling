/**
 * POST /api/public/quote/[id]/request-fresh?t=<token>
 *
 * R-1679: "Request a fresh quote" on an EXPIRED quote's customer page. It tells sales (owner +
 * manager, the in-app bell — same path as "Quote accepted") that this customer still wants it.
 * Before, the only button was a mailto: link that did nothing when the reseller had no email on
 * record, and no one on our side heard that a customer had come back.
 *
 * Changes nothing on the quote: no status, no validity, no new quote. A person decides.
 * The link token is the only credential, so the answer for a wrong token is "not found", and the
 * notification is sent at most once a day per quote (lib/notifications/quote-expired.server.ts).
 */
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { quoteTokenMatches } from "@/lib/quotes/accept-token";
import { shownQuoteStatus } from "@/lib/quotes/quote-expiry";
import { notifyQuoteExpired } from "@/lib/notifications/quote-expired.server";

export async function POST(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const admin = createAdminClient();

  const { data: quote } = await admin
    .from("quotes")
    .select("id, status, tenant_id, public_token, customer_name, expires_date, payment_status, invoice_id, superseded_by")
    .eq("id", params.id)
    .maybeSingle();

  if (!quote || !quoteTokenMatches(request.nextUrl.searchParams.get("t"), quote.public_token) || quote.status === "draft") {
    return NextResponse.json({ error: "Quote not found" }, { status: 404 });
  }
  /* Only an expired (or rejected) quote asks for a fresh one — a live quote is accepted instead. */
  const shown = shownQuoteStatus(quote);
  if (shown !== "expired" && shown !== "rejected") {
    return NextResponse.json({ error: "This quote can still be accepted — use Accept on the page." }, { status: 400 });
  }

  await notifyQuoteExpired({
    admin,
    tenantId: quote.tenant_id,
    quoteId: quote.id,
    customerName: quote.customer_name ?? "",
    event: "request",
  });

  const { data: tenant } = await admin.from("tenants").select("name").eq("id", quote.tenant_id).maybeSingle();
  return NextResponse.json({
    ok: true,
    message: `Thank you — ${tenant?.name ?? "the team"} has been told and will send you a fresh quote.`,
  });
}
