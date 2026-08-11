/**
 * POST /api/webhooks/inbound-purchase
 *
 * Amazon (and similar) order/invoice emails → a PENDING purchase for review.
 * A Gmail filter forwards purchase emails here; we parse them (Gemini) and stage
 * a row in `inbound_purchases`. NOTHING touches expenses / P&L / GST until the
 * owner reviews it in the Purchase Inbox and clicks "Add to expenses" — money
 * stays correct + human-in-loop.
 *
 * Mirrors the inbound-email webhook: same shared secret (INBOUND_EMAIL_SECRET),
 * same provider-agnostic JSON, admin client (no session), idempotent claim.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { resolveGeminiConfig } from "@/lib/ai/gemini";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const INBOUND_SECRET = process.env.INBOUND_EMAIL_SECRET?.trim() || "";
const BUY_PAGE_TENANT_ID =
  process.env.BUY_PAGE_TENANT_ID?.trim() || "fbb976f1-9090-4f10-9726-0901bd144e42";
const INBOUND_TENANT_ID =
  process.env.INBOUND_EMAIL_TENANT_ID?.trim() || BUY_PAGE_TENANT_ID;

interface ExtractedPurchase {
  isPurchase: boolean;
  orderId:    string;
  orderDate:  string;   // YYYY-MM-DD or ""
  currency:   string;   // 'INR' default
  total:      number;   // gross incl. GST
  gst:        number;   // GST amount
  items:      { name: string; qty: number; amount: number }[];
}

function parseFrom(raw: string): { email: string } {
  const s = (raw ?? "").trim();
  const m = /<([^>]+)>/.exec(s);
  return { email: (m ? m[1] : s).trim().toLowerCase() };
}

async function extractWithGemini(apiKey: string, model: string, subject: string, from: string, body: string): Promise<ExtractedPurchase | null> {
  const system =
    "You read a shopping order/invoice email (e.g. Amazon India) for a business's bookkeeping. " +
    "Decide if it is a real PURCHASE/ORDER confirmation or tax invoice (NOT a shipping update, " +
    "promotion, wishlist, or password email). Extract the order details in INR. Return ONLY JSON: " +
    `{"isPurchase":boolean,"orderId":string,"orderDate":"YYYY-MM-DD","currency":string,"total":number,"gst":number,"items":[{"name":string,"qty":number,"amount":number}]}. ` +
    "total = grand total paid incl. taxes. gst = total GST/tax (0 if unknown). Empty string / 0 / [] when unknown.";
  const user = `SUBJECT: ${subject}\nFROM: ${from}\n\nBODY:\n${body.slice(0, 6000)}`;
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts: [{ text: user }] }],
          generationConfig: { responseMimeType: "application/json", temperature: 0.1 },
        }),
      },
    );
    if (!res.ok) { console.error("[inbound-purchase] Gemini failed:", res.status); return null; }
    const data = await res.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!raw) return null;
    const p = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, "").trim()) as Partial<ExtractedPurchase>;
    return {
      isPurchase: p.isPurchase === true,
      orderId:    (p.orderId ?? "").toString().trim(),
      orderDate:  (p.orderDate ?? "").toString().trim(),
      currency:   (p.currency ?? "INR").toString().trim().toUpperCase() || "INR",
      total:      Number(p.total) || 0,
      gst:        Number(p.gst) || 0,
      items:      Array.isArray(p.items) ? p.items.slice(0, 50).map((i) => ({
        name: (i?.name ?? "").toString().slice(0, 200), qty: Number(i?.qty) || 1, amount: Number(i?.amount) || 0,
      })) : [],
    };
  } catch (err) {
    console.error("[inbound-purchase] Gemini crashed:", err);
    return null;
  }
}

export async function POST(request: NextRequest) {
  // 1. Secret (fail closed)
  const url = new URL(request.url);
  const provided = (url.searchParams.get("key") ?? request.headers.get("x-inbound-secret") ?? "").trim();
  if (!INBOUND_SECRET || provided !== INBOUND_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // 2. Normalise payload
  let body: Record<string, unknown>;
  try { body = (await request.json()) as Record<string, unknown>; }
  catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const str = (...keys: string[]): string => {
    for (const k of keys) { const v = body[k]; if (typeof v === "string" && v.trim()) return v.trim(); }
    return "";
  };
  const rawFrom   = str("from", "sender", "From", "from_email");
  const fromEmail = parseFrom(rawFrom).email;
  const subject   = str("subject", "Subject");
  const text      = str("text", "body-plain", "plain", "TextBody", "stripped-text", "body");
  const messageId = str("messageId", "message_id", "Message-Id", "MessageID", "Message-ID")
    || `noid-${fromEmail}-${subject}`.slice(0, 200);

  const admin    = createAdminClient();
  const tenantId = INBOUND_TENANT_ID;

  // 3. Extract (Gemini or minimal stub — never drop; owner reviews raw)
  const gemini = await resolveGeminiConfig(admin, tenantId);
  const ai = gemini.apiKey ? await extractWithGemini(gemini.apiKey, gemini.model, subject, rawFrom, text) : null;
  const p: ExtractedPurchase = ai ?? {
    isPurchase: true, orderId: "", orderDate: "", currency: "INR", total: 0, gst: 0, items: [],
  };

  // A shipping/promo email → record as ignored so it doesn't clutter the inbox.
  const status = p.isPurchase ? "pending" : "ignored";
  const orderDate = /^\d{4}-\d{2}-\d{2}$/.test(p.orderDate) ? p.orderDate : null;
  const source = /amazon/i.test(rawFrom) || /amazon/i.test(subject) ? "amazon" : "other";

  // 4. Idempotent insert (unique tenant+message_id)
  const { error } = await admin.from("inbound_purchases").insert({
    tenant_id:  tenantId,
    source,
    message_id: messageId,
    order_id:   p.orderId || null,
    from_email: fromEmail || null,
    subject:    subject || null,
    order_date: orderDate,
    currency:   p.currency || "INR",
    total:      p.total || null,
    gst:        p.gst || null,
    items:      p.items,
    raw_text:   text.slice(0, 8000) || null,
    status,
  });
  if (error) {
    if (error.code === "23505") return NextResponse.json({ received: true, duplicate: true });
    console.error("[inbound-purchase] insert failed:", error);
    return NextResponse.json({ error: "Could not record purchase" }, { status: 500 });
  }

  return NextResponse.json({ received: true, status, orderId: p.orderId || null, total: p.total || null });
}
