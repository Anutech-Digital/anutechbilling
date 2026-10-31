/**
 * POST /api/quotes/:id/raise-instalments — R-527.
 *
 * Called by the Record payment sheet right after a payment on a split-billed quote
 * (annual commitment billed monthly / quarterly / half-yearly). It raises the instalment
 * tax invoice that has fallen due — Q1 on the day the subscription starts — instead of
 * leaving the customer with a payment and no invoice until the next daily billing run.
 *
 * It issues nothing the daily cron (app/api/cron/billing) would not issue the same day,
 * through the same code (lib/billing/sync-instalments.server.ts): instalment rows are
 * keyed per period and raise_subscription_billing returns the existing invoice for a
 * period already billed, so a double click or a later cron run cannot invoice twice.
 * A quote that is not split-billed writes nothing and answers splitBilled:false.
 *
 * Errors come back per subscription (e.g. the customer has no state, so GST cannot pick
 * CGST+SGST vs IGST) — the payment is already recorded and stays recorded.
 */
import { NextResponse } from "next/server";
import { createClient, createAdminClientFor } from "@/lib/supabase/server";
import { raiseDueInstalmentsForQuote } from "@/lib/billing/sync-instalments.server";
import { istToday } from "@/lib/dates/ist";
import { mayDo, forbiddenMessage } from "@/lib/auth/action-roles";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Please sign in again." }, { status: 401 });

  const { data: me } = await supabase
    .from("users").select("tenant_id, role").eq("id", user.id).maybeSingle();
  if (!me?.tenant_id) {
    return NextResponse.json({ error: "Your account is not linked to a workspace yet." }, { status: 403 });
  }
  /* R-880: this raises a tax invoice through the admin client — money roles only (R-718),
     checked BEFORE any read or write with the admin client. */
  if (!mayDo((me as { role?: string | null }).role, "money.record")) {
    return NextResponse.json({ error: forbiddenMessage("money.record") }, { status: 403 });
  }

  const admin = createAdminClientFor(user.id);
  /* id AND tenant_id: the admin client bypasses RLS. */
  const { data: quote } = await admin
    .from("quotes").select("id").eq("id", params.id).eq("tenant_id", me.tenant_id).maybeSingle();
  if (!quote) return NextResponse.json({ error: "Quote not found." }, { status: 404 });

  /* R-2095 (Sept): the reconcile new sale says afterSale — raise the paid part's invoice only, never
     a next-period payment request at sale time (staging: a 'sent' H2 request 2 s after the sale). */
  const body = (await req.json().catch(() => null)) as { afterSale?: unknown } | null;
  const out = await raiseDueInstalmentsForQuote({
    supabase: admin, quoteId: quote.id, tenantId: me.tenant_id, todayISO: istToday(),
    /* R-2095: the owner's own Generate — a part freed by a full credit note is billed again. */
    rebillCredited: true,
    noNewRequests: body?.afterSale === true,
  });
  return NextResponse.json(out);
}
