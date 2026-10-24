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
import { acceptedSecrets, secretMatches, readInboundSecret, querySecretAllowed, querySecretWarning } from "@/lib/inbound/verify-secret";
import { resolveGeminiConfig, geminiJson } from "@/lib/ai/gemini";
import { inboundTenantId, inboundTenantMissingMessage } from "@/lib/inbound/tenant";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const INBOUND_SECRET = process.env.INBOUND_EMAIL_SECRET?.trim() || "";
/* R-1555: no hard-coded Anutech fallback on a deployment — lib/inbound/tenant.ts, per request. */

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
  {
    /* Pehle yahan apna `fetch` tha — geminiJson ki copy, uski suraksha ke bina. Ye route
       vendor ke bill padhta hai, aur ek atki hui call yahan bhi wahi keemat rakhti hai:
       forwarder POST ke baad thread label kar deta hai bina jawab dekhe. */
    const p = await geminiJson<Partial<ExtractedPurchase>>({
      apiKey, model, system, user, temperature: 0.1, label: "inbound-purchase/extract",
    });
    if (!p) return null;
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
  }
  /* try/catch chala gaya — geminiJson khud "never throws" hai. */
}

export async function POST(request: NextRequest) {
  // 1. Secret (fail closed)
  /* ⚠️ Ye jagah `secretMatches` use NAHI kar rahi thi — seedha `provided !== INBOUND_SECRET`
     tha. Do nateeje: rotation yahan chup-chaap tootta tha (env var "old,new" hone par ye
     route poori string "old,new" ko hi secret maanta), aur compare constant-time nahi tha.
     Sibling route me dono theek the, isliye galti ek hi jaisi dikhne wali teen copy me
     chhup gayi — ab faisla ek hi jagah hai. */
  const secret = readInboundSecret(request);
  if (secret.fromQuery && !querySecretAllowed()) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!secretMatches(secret.value, acceptedSecrets(INBOUND_SECRET))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (secret.fromQuery) console.warn(querySecretWarning("webhooks/inbound-purchase"));

  /* R-1555: no company configured → 503, never a silent fallback to the Anutech tenant. */
  const tenantId = inboundTenantId();
  if (!tenantId) {
    console.error(inboundTenantMissingMessage("webhooks/inbound-purchase"));
    return NextResponse.json({ error: "not configured" }, { status: 503 });
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
