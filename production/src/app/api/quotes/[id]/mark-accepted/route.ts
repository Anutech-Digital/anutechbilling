/**
 * POST /api/quotes/[id]/mark-accepted
 *
 * Operator-triggered "customer accepted but hasn't paid yet" flow.
 *
 * Common B2B scenario:
 *   Customer says "yes, send invoice" but their finance dept takes 5-30 days
 *   to actually wire the money. Without this endpoint Pardeep had to wait
 *   for the payment to land before the lead converted to a customer record,
 *   which made follow-up + KPIs blind to in-flight deals.
 *
 * This calls the accept_quote() RPC which:
 *   - Sets quote.status = 'accepted'
 *   - Converts lead → customer (if linked + not already converted)
 *   - R-1706: a typed PROSPECT (no lead, no customer) → creates the customer from the quote's
 *     name, place of supply and country (customer_from_prospect_quote), so Invoice now and
 *     Activate now, pay later have a customer to bill
 *   - Marks lead.stage = 'won'
 *   - DOES NOT create payment / receipt voucher / subscription
 *     (those land via record_payment when the money actually arrives)
 *
 * Returns: { customerId, convertedNow, awaitsPayment, matchedExisting, customerName }
 *   matchedExisting (R-379): converted_now is also true when the lead was LINKED to a
 *   customer that already existed; this says which, so the toast can say "linked to <name>".
 */

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { safeDbMessage, logDbError } from "@/lib/errors/db-error";
import { createdBeforeRequest } from "@/lib/quotes/accepted-toast";
import { mayDo, forbiddenMessage } from "@/lib/auth/action-roles";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(_req: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const supabase = createClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData?.user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  /* R-880: accept_quote makes no invoice, payment or subscription (see above), so this stays
     a sales action — but support, delivery, partner agents and accountants do not accept
     quotes. The tenant match is accept_quote's own (current_tenant_id vs quote.tenant_id). */
  const { data: me } = await supabase
    .from("users").select("tenant_id, role").eq("id", authData.user.id).maybeSingle();
  if (!me?.tenant_id) {
    return NextResponse.json({ error: "Your account is not linked to a workspace yet." }, { status: 403 });
  }
  if (!mayDo((me as { role?: string | null }).role, "quote.accept")) {
    return NextResponse.json({ error: forbiddenMessage("quote.accept") }, { status: 403 });
  }

  const requestStartedMs = Date.now();
  const { data, error } = await supabase.rpc("accept_quote", {
    p_quote_id: params.id,
  });
  if (error) {
    const code = error.code === "PGRST116" ? 404 : 400;
    /* R-025. `accept_quote`'s own guards are P0001 and their wording IS the next step
       (§24) — those still reach the operator verbatim. A 23505/42703 from the engine
       does not: it names our constraints and columns and helps nobody holding a mouse. */
    logDbError("quotes/mark-accepted", error);
    return NextResponse.json(
      { error: safeDbMessage(error, "Could not mark this quote accepted. Reload the quote and try again.") },
      { status: code },
    );
  }

  type AcceptResult = {
    quote_id:       string;
    customer_id:    string;
    converted_now:  boolean;
    quote_status:   string;
    awaits_payment: boolean;
  };
  const result = data as unknown as AcceptResult;

  /* R-379 (h): created now, or matched? Best-effort read — a failure keeps the old wording. */
  let matchedExisting = false;
  let customerName: string | null = null;
  if (result.converted_now && result.customer_id) {
    const { data: cust } = await supabase
      .from("customers").select("name, created_at").eq("id", result.customer_id).maybeSingle();
    customerName    = cust?.name ?? null;
    matchedExisting = createdBeforeRequest(cust?.created_at ?? null, requestStartedMs);
  }

  return NextResponse.json({
    quoteId:       result.quote_id,
    customerId:    result.customer_id,
    convertedNow:  result.converted_now,
    quoteStatus:   result.quote_status,
    awaitsPayment: result.awaits_payment,
    matchedExisting,
    customerName,
  });
}
