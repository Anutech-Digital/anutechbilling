/**
 * GET /api/invoices/{id}/pdf-link — a one-day signed link to the server-rendered Tax Invoice PDF
 * (5 Oct 2026).
 *
 * WHY: "Download PDF does not respond" (bug filed from AI Help). In the browser the react-pdf
 * render of an invoice could hang without ever resolving or throwing, so the button stayed in
 * its loading state forever and nothing downloaded. The server renders the very same InvoicePDF
 * component (it is what the customer is emailed), so when the in-browser render times out or
 * fails, the dialog falls back to this.
 *
 * Signed-in staff only, and only for an invoice their own RLS lets them read — the link is
 * minted for that invoice's tenant and lives one day.
 */
import { NextResponse, type NextRequest } from "next/server";
import { trustedOrigin } from "@/lib/app-url";
import { createClient } from "@/lib/supabase/server";
import { pdfDownloadUrl } from "@/lib/pdf/pdf-token";

export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  // RLS: returns the row only when it belongs to the caller's workspace.
  const { data: inv } = await supabase.from("invoices").select("id, tenant_id").eq("id", id).maybeSingle();
  if (!inv) return NextResponse.json({ error: "Invoice not found." }, { status: 404 });

  const origin = trustedOrigin(request.headers); // R-723
  return NextResponse.json({ url: pdfDownloadUrl(origin, "invoice", inv.id, inv.tenant_id, { ttlDays: 1 }) });
}
