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
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { resolveGeminiConfig } from "@/lib/ai/gemini";
import { sanitizeExtractedBill, type ExtractedBill } from "./sanitize";

const bodySchema = z.object({
  fileBase64: z.string().min(20, "Empty file"),
  mimeType: z.string().min(3),
});

const PROMPT =
  "You are reading a vendor/supplier tax invoice for a cloud reseller's books. The " +
  "supplier may be INDIAN (Google Cloud/Workspace, Microsoft, Zoho, etc.) billing in " +
  "rupees with GST (CGST+SGST or IGST), OR a FOREIGN online-service provider (e.g. " +
  "Anthropic, OpenAI, Google LLC) billing in USD/other currency — these carry an India " +
  "GST registration under state code 99 (OIDAR) and may show GST as a single line. " +
  "Extract and return ONLY JSON, no prose:\n" +
  "{\n" +
  '  "vendor_name": string|null,        // the SUPPLIER who issued the bill (the seller, NOT the buyer)\n' +
  '  "vendor_gstin": string|null,       // 15-char India GST/VAT registration of the supplier if printed\n' +
  '  "bill_no": string|null,            // the invoice/bill number\n' +
  '  "bill_date": string|null,          // invoice/issue date as YYYY-MM-DD\n' +
  '  "currency": string|null,           // ISO code of the amounts on the bill: "INR", "USD", etc.\n' +
  '  "subtotal": number|null,           // taxable value BEFORE tax, in the bill\'s currency (keep decimals)\n' +
  '  "cgst": number|null,               // CGST amount (0 if not shown)\n' +
  '  "sgst": number|null,               // SGST amount (0 if not shown)\n' +
  '  "igst": number|null,               // IGST or a single GST/tax amount (0 if not shown)\n' +
  '  "total": number|null,              // grand total INCLUDING tax, in the bill\'s currency\n' +
  '  "line_items": [                    // every product/service row on the bill (empty array if none)\n' +
  '    { "description": string, "qty": number|null, "unit_price": number|null, "amount": number }\n' +
  "  ],\n" +
  '  "category_guess": string|null      // "COGS-Workspace" Google, "COGS-M365" Microsoft, "COGS-Zoho" Zoho, else "COGS-Other" or null\n' +
  "}\n" +
  "RULES: Keep amounts in the bill's OWN currency (do NOT convert). Keep decimals (e.g. 265.50). " +
  "Never invent a value — use null (or [] for line_items) if the bill does not clearly show it. " +
  "A single foreign 'GST - India' / 'VAT' line goes in igst. " +
  "CREDIT lines are NEGATIVE: a refund / 'unused time' / proration credit / discount row must have a NEGATIVE amount (and negative unit_price), e.g. -61.41 — never 0. " +
  "The line_items amounts must sum to the pre-tax subtotal (total minus tax), so keep signs correct. " +
  "vendor_name is the SELLER, never the reseller/buyer.";

async function extractWithGemini(apiKey: string, model: string, mimeType: string, base64: string): Promise<ExtractedBill | null> {
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{
            role: "user",
            parts: [
              { text: PROMPT },
              { inlineData: { mimeType, data: base64 } },
            ],
          }],
          generationConfig: { responseMimeType: "application/json", temperature: 0 },
        }),
      },
    );
    if (!res.ok) {
      console.error("[ai/extract-bill] Gemini failed:", res.status, await res.text().catch(() => ""));
      return null;
    }
    const data = (await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!raw) return null;
    const cleaned = raw.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
    return JSON.parse(cleaned) as ExtractedBill;
  } catch (err) {
    console.error("[ai/extract-bill] Gemini crashed:", err);
    return null;
  }
}

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
  if (!/^(image\/(png|jpe?g|webp|heic|heif)|application\/pdf)$/i.test(parsed.mimeType)) {
    return NextResponse.json({ error: "Upload a photo (JPG/PNG) or PDF of the bill." }, { status: 400 });
  }

  const { data: me } = await supabase.from("users").select("tenant_id").eq("id", user.id).maybeSingle();
  const gemini = await resolveGeminiConfig(supabase, me?.tenant_id ?? null);
  if (!gemini.apiKey) {
    return NextResponse.json(
      { error: "AI reading isn't set up. Add your Gemini key in Settings → Integrations → AI, or fill the bill by hand." },
      { status: 400 },
    );
  }

  const ai = await extractWithGemini(gemini.apiKey, gemini.model, parsed.mimeType, parsed.fileBase64);
  if (!ai) {
    return NextResponse.json({ error: "Couldn't read this bill. Try a clearer photo/PDF, or enter it by hand." }, { status: 502 });
  }

  // Everything stays a suggestion the operator verifies in the form.
  const fields = sanitizeExtractedBill(ai);

  return NextResponse.json({ fields, mode: "gemini" });
}
