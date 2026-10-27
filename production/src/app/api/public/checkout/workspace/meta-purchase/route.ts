/**
 * POST /api/public/checkout/workspace/meta-purchase — R-1979 (26 Oct 2026, G-ADS).
 *
 * The thanks page of a PAID buy-page order asks the server to send Meta's Conversions API
 * Purchase (the browser pixel sends its own; both carry event_id "purchase-<quote>", so Meta
 * counts one). Sent from here, not from the Razorpay webhook, so the payment path is untouched.
 *
 * Only when: the quote number + its secret token match (the thanks page's own rule, S11), the
 * quote is the website tenant's and PAID, the buyer accepted analytics cookies (consent: true),
 * and the tenant set a pixel + token. Always answers { ok: true } for a well-formed request —
 * whether or not Meta was told — so the endpoint says nothing about an order.
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/server";
import { websiteTenantId } from "@/lib/website-tenant";
import { quoteTokenMatches } from "@/lib/quotes/accept-token";
import { reportPurchaseToMeta } from "@/lib/meta/capi.server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const schema = z.object({
  quoteId: z.string().regex(/^Q-(?:[A-Z0-9]{2,8}-)?(?:[0-9]{4}-)?[0-9]{2}-[0-9]{4,}$/),
  t: z.string().min(8).max(100),
  consent: z.boolean(),
  fbp: z.string().max(100).nullable().optional(),
  pageUrl: z.string().max(400).optional(),
});

export async function POST(request: NextRequest) {
  let body: unknown;
  try { body = await request.json(); } catch { body = null; }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ ok: false }, { status: 400 });
  const v = parsed.data;
  try {
    const tenantId = websiteTenantId();
    if (!tenantId || !v.consent) return NextResponse.json({ ok: true });
    const admin = createAdminClient();
    const { data } = await admin
      .from("quotes")
      .select("id, public_token, payment_status")
      .eq("id", v.quoteId)
      .eq("tenant_id", tenantId)
      .in("payment_status", ["received", "invoiced"])
      .maybeSingle();
    if (!data || !quoteTokenMatches(v.t, data.public_token)) return NextResponse.json({ ok: true });
    await reportPurchaseToMeta(admin, {
      quoteId: data.id, tenantId, consent: true,
      fbp: v.fbp ?? null,
      sourceUrl: v.pageUrl ?? null,
      clientIp: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null,
      userAgent: request.headers.get("user-agent"),
    });
  } catch (e) {
    console.error("[checkout/workspace/meta-purchase]", e instanceof Error ? e.message : e);
  }
  return NextResponse.json({ ok: true });
}
