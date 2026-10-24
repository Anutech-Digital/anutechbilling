/**
 * POST /api/ai/scan-visiting-card
 *
 * Reads contact details off a visiting card / letterhead photo, OR out of a
 * pasted email or WhatsApp signature, and returns fields to PRE-FILL the
 * customer form. ZERO write — same posture as /api/ai/extract-bill: the operator
 * sees every value in an editable form and confirms it.
 *
 * Body: { fileBase64, mimeType }   — a photo or PDF
 *    or { text }                   — a pasted signature
 * Returns: { fields, filled, mode: "gemini" } or { error } with a next step.
 *
 * ─── ONE ROUTE FOR BOTH, BECAUSE IT IS ONE TASK ─────────────────────────────
 * A card and a signature block are the same job — "find the company, person,
 * phone, email and address in this" — and the only difference is whether the
 * input reaches Gemini as an image part or a text part. Two routes would mean
 * two prompts drifting apart, which is the exact failure the bill prompt just
 * had to be de-duplicated to avoid.
 *
 * ─── WHAT IT REFUSES TO RETURN ──────────────────────────────────────────────
 * No state, no state_code, no country, no customer group, no payment terms. In
 * India the state decides CGST+SGST versus IGST, so it comes from the verified
 * GSTIN the form already fetches from GSTN — a government source — and never
 * from a card. Group and payment terms are commercial decisions a visiting card
 * carries no evidence for. See lib/customers/card-fields.ts.
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { mayOpenPage, ROLE_GATE_ERROR } from "@/lib/api/with-route";
import { resolveGeminiConfig, geminiJson } from "@/lib/ai/gemini";
import { mapScannedCard, filledCount, type ScannedCard } from "@/lib/customers/card-fields";

const bodySchema = z.union([
  z.object({ fileBase64: z.string().min(20), mimeType: z.string().min(3) }),
  z.object({ text: z.string().trim().min(10, "Paste a bit more text.") }),
]);

const READABLE = /^(image\/(png|jpe?g|webp|heic|heif)|application\/pdf)$/i;

const PROMPT =
  "You are reading an Indian business visiting card, letterhead, or an email/WhatsApp " +
  "signature block. Extract the contact details and return ONLY JSON, no prose:\n" +
  "{\n" +
  '  "company_name": string|null,   // the ORGANISATION, not the person\n' +
  '  "contact_name": string|null,   // the person\'s full name\n' +
  '  "designation": string|null,    // their job title, e.g. "Director", "Purchase Manager"\n' +
  '  "email": string|null,          // their email address\n' +
  '  "phone": string|null,          // landline or main number, digits as printed\n' +
  '  "mobile": string|null,         // mobile number if separate from phone\n' +
  '  "address": string|null,        // street address WITHOUT the city, state or PIN\n' +
  '  "city": string|null,\n' +
  '  "pin_code": string|null,       // 6-digit Indian PIN\n' +
  '  "domain": string|null,         // website, bare domain only e.g. "acmecorp.com"\n' +
  '  "gstin": string|null           // 15-character GSTIN if printed, exactly as shown\n' +
  "}\n" +
  "RULES: Never invent a value — use null if it is not clearly there. Do NOT guess the " +
  "state or country from the city; leave them out entirely. Copy the GSTIN character by " +
  "character; do not correct what you think is a typo. If several people appear, take the " +
  "one whose details are most prominent.";

async function askGemini(
  apiKey: string, model: string,
  part: { text: string } | { inlineData: { mimeType: string; data: string } },
): Promise<ScannedCard | null> {
  /* Pehle yahan apna `fetch` tha. Timeout iske paas THA (15s), par circuit breaker aur
     retry nahi — aur wo comment neeche bacha hua hai kyunki wo aaj bhi sach hai.

     Prompt `user` part me hi rehta hai, system me nahi: GSTIN "character by character"
     copy karne wala rule is prompt ki jaan hai, aur use doosri jagah le jaana output badal
     sakta hai. Isliye geminiJson ka `system` optional hai. */
  const isImage = "inlineData" in part;
  return geminiJson<ScannedCard>({
    apiKey, model,
    /* Text wali shakl me doosra part bhi text hi hai, to dono ko jod dete hain — request
       ka matlab wahi rehta hai (Gemini do text parts ko jodkar hi padhta hai). */
    user: isImage ? PROMPT : `${PROMPT}\n\n${part.text}`,
    attachment: isImage
      ? { mimeType: part.inlineData.mimeType, base64: part.inlineData.data }
      : undefined,
    temperature: 0,
    // The brief asks for under 3 seconds. That is not ours to promise —
    // it is Google's latency. What IS ours is refusing to hang the form:
    // a slow read must fail fast so the operator can type instead of wait.
    timeoutMs: 15_000,
    label: "scan-visiting-card",
  });
}

export async function POST(request: NextRequest) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Send a photo of the card, or paste the signature text." }, { status: 400 });
  }

  const input = parsed.data;
  if ("mimeType" in input && !READABLE.test(input.mimeType)) {
    return NextResponse.json({ error: "Use a photo (JPG/PNG) or a PDF of the card." }, { status: 400 });
  }

  const { data: me } = await supabase.from("users").select("tenant_id, role").eq("id", user.id).maybeSingle();
  /* R-1470: only roles that open a page with the add-customer form that scans a card — before any read, AI call or spend. */
  if (!mayOpenPage(me?.role, ["/customers", "/quotes", "/projects", "/accounting/banking", "/accounting/vendors", "/settings"])) return NextResponse.json({ error: ROLE_GATE_ERROR }, { status: 403 });
  const gemini = await resolveGeminiConfig(supabase, me?.tenant_id ?? null);
  if (!gemini.apiKey) {
    return NextResponse.json(
      { error: "AI reading isn't set up. Add your Gemini key in Settings → Integrations → AI, or fill the form by hand." },
      { status: 400 },
    );
  }

  const part = "text" in input
    ? { text: `Signature / pasted text:\n${input.text.slice(0, 4000)}` }
    : { inlineData: { mimeType: input.mimeType, data: input.fileBase64 } };

  const ai = await askGemini(gemini.apiKey, gemini.model, part);
  if (!ai) {
    return NextResponse.json(
      { error: "Couldn't read that. Try a sharper photo, or type the details in — the form works fine by hand." },
      { status: 502 },
    );
  }

  // Sanitised, and deliberately incomplete: anything that failed a check is
  // returned as null rather than as a plausible wrong value.
  const fields = mapScannedCard(ai);
  return NextResponse.json({ fields, filled: filledCount(fields), mode: "gemini" });
}
