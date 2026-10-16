/**
 * POST /api/voice/whatsapp-note  — Voice-agent Phase 0.
 *
 * Turns a money-safe reminder into a Hindi voice clip (TTS) and sends it to the
 * customer as a WhatsApp voice note. NO telephony / DLT — one-way, async.
 *
 * MONEY-SAFETY: the spoken amount is the REAL outstanding from the DB, said
 * verbatim in a fixed template — the model never improvises a ₹ figure. No
 * money-write happens; this only sends an audio reminder.
 *
 * STUB-FIRST: needs (a) SARVAM_API_KEY for TTS and (b) WhatsApp Business Cloud
 * API configured for the tenant. Returns a clear 400 when either is missing.
 * A customer with no phone gets 422 `{ code: "no_phone", error, description, href }`
 * (R-1452) before any TTS or send is attempted.
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { synthesizeSpeech } from "@/lib/voice/tts";
import { sendCustomerWhatsApp } from "@/lib/messaging";
import { rupee } from "@/lib/utils";
import { hasPhone, noPhoneNotice, NO_PHONE_STATUS } from "@/lib/voice/voice-note-phone";

const bodySchema = z.object({
  customerId: z.string().min(1),
  purpose: z.enum(["reminder", "renewal"]).default("reminder"),
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

  const { data: me } = await supabase.from("users").select("tenant_id").eq("id", user.id).maybeSingle();
  if (!me?.tenant_id) return NextResponse.json({ error: "No tenant." }, { status: 403 });

  // Customer + tenant + real money context (RLS-scoped to this tenant).
  const { data: customer } = await supabase
    .from("customers").select("id, name, contact_name, contact_phone").eq("id", parsed.customerId).maybeSingle();
  if (!customer) return NextResponse.json({ error: "Customer not found." }, { status: 404 });
  // R-1452: no phone → a clear §24 answer (what, why, where to add it), and nothing is sent.
  if (!hasPhone(customer.contact_phone)) {
    return NextResponse.json(noPhoneNotice(customer.id, customer.name), { status: NO_PHONE_STATUS });
  }

  const { data: tenant } = await supabase.from("tenants").select("name").eq("id", me.tenant_id).maybeSingle();
  const brand = tenant?.name || "your service provider";

  const { data: subs } = await supabase
    .from("subscriptions").select("plan, status, outstanding_amount, renewal_date").eq("customer_id", customer.id);
  const outstanding = (subs ?? []).reduce((s, x) => s + (x.outstanding_amount ?? 0), 0);
  const active = (subs ?? []).find((s) => s.status === "active") ?? (subs ?? [])[0];
  const plan = active?.plan ? active.plan.replace(/^google-workspace-/, "Google Workspace ") : "your subscription";
  const firstName = (customer.contact_name || customer.name).split(/\s+/)[0];

  // Money-safe fixed template — real figures said verbatim, nothing improvised.
  let script: string;
  if (parsed.purpose === "renewal") {
    const on = active?.renewal_date
      ? new Date(active.renewal_date).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" })
      : "soon";
    script = `Namaste ${firstName} ji. ${brand} ki taraf se reminder. Aapka ${plan} ${on} ko renew hone wala hai. Service bina rukawat chalti rahe iske liye kripya renew karein. Dhanyavaad.`;
  } else {
    if (outstanding <= 0) return NextResponse.json({ error: "No outstanding balance to remind about." }, { status: 400 });
    script = `Namaste ${firstName} ji. ${brand} ki taraf se ek payment reminder. Aapke account par ${rupee(outstanding)} baaki hai. Kripya jaldi payment karein. Dhanyavaad.`;
  }

  // TTS — stub returns null when SARVAM_API_KEY isn't set.
  const audio = await synthesizeSpeech(script, "hi-IN");
  if (!audio) {
    return NextResponse.json(
      { error: "Voice (TTS) is not configured yet. Add a Sarvam API key (SARVAM_API_KEY) to enable voice notes." },
      { status: 400 },
    );
  }

  try {
    const result = await sendCustomerWhatsApp({
      tenantId: me.tenant_id,
      to: customer.contact_phone,
      message: {
        kind: "audio",
        buffer: Buffer.from(audio.base64, "base64"),
        mime: audio.mime,
        filename: `${parsed.purpose}-reminder.wav`,
      },
      related: { customerId: customer.id },
    });
    return NextResponse.json({ sent: true, status: result.status, script });
  } catch (err) {
    // Most common: WhatsApp Business Cloud API not configured for the tenant.
    return NextResponse.json({ error: err instanceof Error ? err.message : "Could not send the voice note." }, { status: 400 });
  }
}
