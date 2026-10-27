/**
 * POST /api/ai/extract-bill
 *
 * Reads an uploaded vendor bill (image or PDF) with Gemini vision and returns
 * the fields needed to pre-fill the Add Vendor Bill form. ZERO money-write —
 * it only returns extracted values; the operator REVIEWS and edits them before
 * saving (AI can misread amounts, and this feeds GST input credit + P&L, so a
 * human must confirm). Tenant-scoped Gemini key (Settings → Integrations → AI).
 *
 * Body: { fileBase64: string (raw base64, no data: prefix), mimeType: string }
 * Returns: { fields: {...}, mode: "gemini" }  or  { error } with a helpful hint.
 *
 * The prompt and the Gemini call moved to lib/ai/read-bill.ts when the billing@
 * inbound-email path became a second caller. A copied prompt drifts — one side
 * gets the fix for negative credit lines and the other does not, and then the
 * same PDF reads differently depending on how it reached the system.
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { mayOpenPage, ROLE_GATE_ERROR } from "@/lib/api/with-route";
import { resolveGeminiConfig } from "@/lib/ai/gemini";
import { sanitizeExtractedBill } from "./sanitize";
import { billBuyerMismatch } from "./buyer-check";
import { readBillWithGemini, READABLE_BILL_MIME } from "@/lib/ai/read-bill";

const bodySchema = z.object({
  fileBase64: z.string().min(20, "Empty file"),
  mimeType: z.string().min(3),
});

export async function POST(request: NextRequest) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  let parsed;
  try {
    parsed = bodySchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  // Only images + PDF are readable by Gemini vision.
  if (!READABLE_BILL_MIME.test(parsed.mimeType)) {
    return NextResponse.json({ error: "Upload a photo (JPG/PNG) or PDF of the bill." }, { status: 400 });
  }

  const { data: me } = await supabase.from("users").select("tenant_id, role").eq("id", user.id).maybeSingle();
  /* R-1470: only roles that open a page with the vendor bill / expense form that reads a bill — before any read, AI call or spend. */
  if (!mayOpenPage(me?.role, ["/accounting/bills", "/accounting/expenses", "/accounting/prepaid", "/accounting/advances", "/accounting/vendors", "/projects", "/marketing/spend"])) return NextResponse.json({ error: ROLE_GATE_ERROR }, { status: 403 });
  const gemini = await resolveGeminiConfig(supabase, me?.tenant_id ?? null);
  if (!gemini.apiKey) {
    return NextResponse.json(
      /* R-1744: `code` lets the Add expense form say plainly that AI is off and stay manual. */
      { error: "AI reading isn't set up. Add your Gemini key in Settings → Integrations → AI, or fill the bill by hand.", code: "ai_not_configured" },
      { status: 400 },
    );
  }

  const ai = await readBillWithGemini({
    apiKey:   gemini.apiKey,
    model:    gemini.model,
    tenantId: gemini.tenantId,
    mimeType: parsed.mimeType,
    base64:   parsed.fileBase64,
  });
  if (!ai) {
    return NextResponse.json({ error: "Couldn't read this bill. Try a clearer photo/PDF, or enter it by hand." }, { status: 502 });
  }

  // Everything stays a suggestion the operator verifies in the form.
  const fields = sanitizeExtractedBill(ai);

  /* R-1767: is the bill addressed to US? Compared here, where the tenant is known, so both
     dialogs read one answer. A failed tenant read just means no warning (never a false one). */
  const { data: tenant } = me?.tenant_id
    ? await supabase.from("tenants").select("name, gstin, gstin_verification").eq("id", me.tenant_id).maybeSingle()
    : { data: null };
  const verification = (tenant?.gstin_verification ?? null) as { legal_name?: string | null; trade_name?: string | null } | null;
  const buyer_mismatch = tenant
    ? billBuyerMismatch(fields, { name: tenant.name, gstin: tenant.gstin, legal_name: verification?.legal_name ?? null, trade_name: verification?.trade_name ?? null })
    : null;

  return NextResponse.json({ fields: { ...fields, buyer_mismatch }, mode: "gemini" });
}
