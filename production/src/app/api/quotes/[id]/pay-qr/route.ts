/**
 * GET /api/quotes/{id}/pay-qr — the scan-to-pay UPI QR the customer's quote PDF carries, for the
 * staff preview ("Preview · This is how the customer will see it"). R-1694, 20 Oct 2026.
 *
 * WHY a route: the QR is encoded server-side (`qrcode` stays out of the browser bundle, as on
 * the accept page), and the decision — UPI ID set, ₹ quote, money still due — is the PDF route's
 * own rule via `quotePayQr`, so the preview and the PDF cannot disagree.
 *
 * Signed-in staff who may open Quotes only, and only for a quote their own RLS lets them read.
 * Response: { qr: { dataUrl, vpa, amount } | null }.
 */
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { mayOpenPage, ROLE_GATE_ERROR } from "@/lib/api/with-route";
import { readQuoteDueNow } from "@/lib/checkout/quote-order";
import { quotePayQr, type QuotePayQrTenant } from "@/lib/pdf/quote-pay-qr";
import type { Quote } from "@/lib/supabase/database.types";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const { data: me } = await supabase.from("users").select("role").eq("id", user.id).maybeSingle();
  if (!mayOpenPage((me as { role?: string | null } | null)?.role, ["/quotes"])) {
    return NextResponse.json({ error: ROLE_GATE_ERROR }, { status: 403 });
  }

  // RLS: returns the row only when it belongs to the caller's workspace.
  const { data: quote } = await supabase.from("quotes").select("*").eq("id", id).maybeSingle();
  if (!quote) return NextResponse.json({ error: "Quote not found." }, { status: 404 });
  const q = quote as Quote;

  const { data: tenant } = await supabase
    .from("tenants")
    .select("name, upi_vpa, upi_payee_name")
    .eq("id", q.tenant_id)
    .maybeSingle();

  const qr = await quotePayQr({
    tenant:  tenant as QuotePayQrTenant | null,
    quoteId: q.id,
    due:     await readQuoteDueNow(supabase, q),
  });
  return NextResponse.json({ qr }, { headers: { "cache-control": "no-store" } });
}
