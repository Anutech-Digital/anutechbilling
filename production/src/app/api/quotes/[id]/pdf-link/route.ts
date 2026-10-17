/**
 * GET /api/quotes/{id}/pdf-link?template=proforma — a one-day signed link to the server-rendered
 * quote PDF (R-1523, 17 Oct 2026).
 *
 * WHY: the in-app "Download PDF" renders in the browser and has no UPI QR or bank block. The
 * Proforma Invoice must be the SAME paper the customer is emailed — QR, bank details, pay link —
 * so the quote page opens the server render (public quote PDF route) instead of building a second
 * copy that could drift. `template` is passed through untouched; the PDF route parses it.
 *
 * Signed-in staff who may open Quotes only, and only for a quote their own RLS lets them read.
 */
import { NextResponse, type NextRequest } from "next/server";
import { trustedOrigin } from "@/lib/app-url";
import { createClient } from "@/lib/supabase/server";
import { mayOpenPage, ROLE_GATE_ERROR } from "@/lib/api/with-route";
import { pdfDownloadUrl } from "@/lib/pdf/pdf-token";
import { parseQuoteTemplate } from "@/lib/pdf/quote-template";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const { data: me } = await supabase.from("users").select("role").eq("id", user.id).maybeSingle();
  if (!mayOpenPage((me as { role?: string | null } | null)?.role, ["/quotes"])) {
    return NextResponse.json({ error: ROLE_GATE_ERROR }, { status: 403 });
  }

  // RLS: returns the row only when it belongs to the caller's workspace.
  const { data: q } = await supabase.from("quotes").select("id, tenant_id").eq("id", id).maybeSingle();
  if (!q) return NextResponse.json({ error: "Quote not found." }, { status: 404 });

  const template = parseQuoteTemplate(request.nextUrl.searchParams.get("template"));
  const url = pdfDownloadUrl(trustedOrigin(request.headers), "quote", q.id, q.tenant_id, { ttlDays: 1 });
  return NextResponse.json({ url: template === "proforma" ? `${url}&template=proforma` : url });
}
