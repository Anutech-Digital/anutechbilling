/**
 * POST /api/webhooks/inbound-email
 *
 * Inbound-email → Lead pipeline. A forwarded product-enquiry email lands here
 * (via an inbound-parse provider — Cloudflare Email Routing / Postmark /
 * SendGrid / Mailgun — that the operator forwards Gmail enquiries to), and we:
 *
 *   1. Verify the shared secret (INBOUND_EMAIL_SECRET) — fail closed.
 *   2. Normalise provider payload → { fromEmail, fromName, subject, text, messageId }.
 *   3. Claim the messageId in `inbound_emails` (UNIQUE) → idempotent (no dup leads).
 *   4. Gemini extracts { isEnquiry, company, contactName, phone, product, summary }
 *      (stub fallback when GEMINI_API_KEY is absent).
 *   5. Non-enquiry → skip. Enquiry → create a Lead (reuses the buy-page enquiry
 *      pattern), deduping against a recent open lead with the same email.
 *   6. Notify the reseller owner (best-effort email).
 *
 * Public route — the secret is the only guard (mirrors the Razorpay webhook's
 * fail-closed posture). Uses the admin client (no session). v1 routes leads to
 * the single buy-page tenant; multi-tenant maps the ingest address → tenant later.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { resolveGeminiConfig } from "@/lib/ai/gemini";
import { sendEmail } from "@/lib/email/send";

const INBOUND_SECRET = process.env.INBOUND_EMAIL_SECRET?.trim() || "";
const FROM_EMAIL     = process.env.RESEND_FROM_DEFAULT?.trim() || "ResellerOS <onboarding@resend.dev>";
const APP_URL        = process.env.NEXT_PUBLIC_APP_URL?.trim() || "https://resellersos.web.app";
const BUY_PAGE_TENANT_ID =
  process.env.BUY_PAGE_TENANT_ID?.trim() || "fbb976f1-9090-4f10-9726-0901bd144e42";
// Which tenant inbound enquiry-emails belong to. Defaults to the buy-page
// tenant, but set INBOUND_EMAIL_TENANT_ID to route a specific reseller's
// forwarded Gmail enquiries to their own tenant (e.g. Anutech) without
// disturbing the public buy-page routing.
const INBOUND_TENANT_ID =
  process.env.INBOUND_EMAIL_TENANT_ID?.trim() || BUY_PAGE_TENANT_ID;

interface ExtractedLead {
  isEnquiry: boolean;
  company: string;
  contactName: string;
  phone: string;
  product: string;
  summary: string;
}

/** Parse "Display Name <a@b.com>" → { name, email }. Falls back gracefully. */
function parseFrom(raw: string): { name: string; email: string } {
  const s = (raw ?? "").trim();
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(s);
  if (m) return { name: m[1].trim(), email: m[2].trim().toLowerCase() };
  // Bare email or empty
  const email = /@/.test(s) ? s.toLowerCase() : "";
  return { name: "", email };
}

/** Ask Gemini to classify + extract. Returns null on any failure (caller stubs). */
async function extractWithGemini(apiKey: string, model: string, subject: string, from: string, body: string): Promise<ExtractedLead | null> {
  const system =
    "You triage forwarded B2B emails for a cloud-software reseller (Google Workspace, " +
    "Microsoft 365, Zoho). Decide if the email is a GENUINE sales/product enquiry from a " +
    "prospective customer (NOT a newsletter, receipt, notification, OTP, spam, or internal note). " +
    "Extract the prospect's details. Return ONLY a JSON object: " +
    `{"isEnquiry":boolean,"company":string,"contactName":string,"phone":string,"product":string,"summary":string}. ` +
    "company/contactName/phone/product = empty string if unknown. summary = one short line of what they want.";
  const user = `SUBJECT: ${subject}\nFROM: ${from}\n\nBODY:\n${body.slice(0, 4000)}`;

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts: [{ text: user }] }],
          generationConfig: { responseMimeType: "application/json", temperature: 0.2 },
        }),
      },
    );
    if (!res.ok) {
      console.error("[inbound-email] Gemini failed:", res.status, await res.text().catch(() => ""));
      return null;
    }
    const data = await res.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!raw) return null;
    const cleaned = raw.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
    const p = JSON.parse(cleaned) as Partial<ExtractedLead>;
    return {
      isEnquiry:   p.isEnquiry === true,
      company:     (p.company ?? "").toString().trim(),
      contactName: (p.contactName ?? "").toString().trim(),
      phone:       (p.phone ?? "").toString().trim(),
      product:     (p.product ?? "").toString().trim(),
      summary:     (p.summary ?? "").toString().trim(),
    };
  } catch (err) {
    console.error("[inbound-email] Gemini crashed:", err);
    return null;
  }
}

export async function POST(request: NextRequest) {
  // ── 1. Secret guard (fail closed) ──────────────────────────────────────
  const url = new URL(request.url);
  const provided = (url.searchParams.get("key") ?? request.headers.get("x-inbound-secret") ?? "").trim();
  if (!INBOUND_SECRET || provided !== INBOUND_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // ── 2. Normalise payload across common inbound-parse providers ─────────
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const str = (...keys: string[]): string => {
    for (const k of keys) {
      const v = body[k];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    return "";
  };

  const rawFrom   = str("from", "sender", "From", "from_email");
  const { name: parsedName, email: fromEmail } = parseFrom(rawFrom);
  const fromName  = str("fromName", "from_name", "sender_name") || parsedName;
  const subject   = str("subject", "Subject");
  const text      = str("text", "body-plain", "plain", "TextBody", "stripped-text", "body");
  const html      = str("html", "body-html", "HtmlBody", "stripped-html");
  const messageId = str("messageId", "message_id", "Message-Id", "MessageID", "Message-ID")
    || `noid-${fromEmail}-${subject}`.slice(0, 200);

  if (!fromEmail) {
    return NextResponse.json({ error: "Missing sender email" }, { status: 400 });
  }

  const admin    = createAdminClient();
  const tenantId = INBOUND_TENANT_ID;

  // ── 3. Idempotency claim — insert the message_id; UNIQUE blocks replays ─
  const { error: claimErr } = await admin.from("inbound_emails").insert({
    tenant_id:  tenantId,
    message_id: messageId,
    from_email: fromEmail,
    from_name:  fromName || null,
    subject:    subject || null,
    body_text:  text || null,
    body_html:  html || null,
    status:     "received",
  });
  if (claimErr) {
    if (claimErr.code === "23505") {
      return NextResponse.json({ received: true, duplicate: true });
    }
    console.error("[inbound-email] claim insert failed:", claimErr);
    return NextResponse.json({ error: "Could not record email" }, { status: 500 });
  }

  const finalize = (status: string, leadId: string | null) =>
    admin.from("inbound_emails").update({ status, lead_id: leadId })
      .eq("tenant_id", tenantId).eq("message_id", messageId);

  // ── 4. Extract + classify (Gemini, or stub fallback) ───────────────────
  const gemini = await resolveGeminiConfig(admin, tenantId);
  const ai = gemini.apiKey ? await extractWithGemini(gemini.apiKey, gemini.model, subject, rawFrom, text) : null;
  const extracted: ExtractedLead = ai ?? {
    isEnquiry:   true, // no AI → don't silently drop; let the operator triage
    company:     fromEmail.split("@")[1]?.split(".")[0] || fromName || "Email lead",
    contactName: fromName,
    phone:       "",
    product:     "",
    summary:     subject || "Email enquiry",
  };

  if (!extracted.isEnquiry) {
    await finalize("skipped_non_enquiry", null);
    return NextResponse.json({ received: true, skipped: "non_enquiry" });
  }

  const company = extracted.company || fromName || (fromEmail.split("@")[1]?.split(".")[0]) || "Email lead";
  const note    = [
    `Inbound email lead (auto-captured).`,
    `From: ${fromName ? `${fromName} ` : ""}<${fromEmail}>`,
    subject ? `Subject: ${subject}` : null,
    extracted.summary ? `Summary: ${extracted.summary}` : null,
    text ? `\n--- original ---\n${text.slice(0, 1000)}` : null,
  ].filter(Boolean).join("\n");

  // ── 5. Dedup — recent OPEN lead with the same email? append, don't dup ─
  const { data: existing } = await admin
    .from("leads")
    .select("id, notes")
    .eq("tenant_id", tenantId)
    .ilike("contact_email", fromEmail)
    .not("stage", "in", "(won,lost)")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existing) {
    await admin.from("leads").update({
      notes: `${existing.notes ? existing.notes + "\n\n" : ""}[New email ${new Date().toISOString().slice(0, 10)}] ${subject || extracted.summary}`,
    }).eq("id", existing.id);
    // Log on the lead's activity timeline (visible in the drawer).
    await admin.from("lead_activities").insert({
      tenant_id: tenantId, lead_id: existing.id, kind: "email_in",
      detail: `Reply from ${fromEmail}${subject ? ` · ${subject}` : ""}`,
    });
    await finalize("appended_to_lead", existing.id);
    return NextResponse.json({ received: true, appendedToLead: existing.id });
  }

  // ── 6. Create the lead ─────────────────────────────────────────────────
  const leadId = "L-" + Date.now().toString(36).toUpperCase();
  const { error: leadErr } = await admin.from("leads").insert({
    id:            leadId,
    tenant_id:     tenantId,
    company,
    contact_name:  extracted.contactName || null,
    contact_email: fromEmail,
    contact_phone: extracted.phone || null,
    plan:          extracted.product || null,
    stage:         "new",
    source:        "email-inbound",
    priority:      "medium",
    notes:         note,
  });
  if (leadErr) {
    console.error("[inbound-email] lead insert failed:", leadErr);
    await finalize("error", null);
    return NextResponse.json({ error: "Could not create lead" }, { status: 500 });
  }
  await finalize("lead_created", leadId);
  await admin.from("lead_activities").insert({
    tenant_id: tenantId, lead_id: leadId, kind: "email_in",
    detail: `Email from ${fromEmail}${subject ? ` · ${subject}` : ""}`,
  });

  // ── 7. Notify the reseller owner (best-effort) ─────────────────────────
  const { data: tenant } = await admin.from("tenants").select("email, name").eq("id", tenantId).maybeSingle();
  const ownerEmail = tenant?.email?.trim();
  if (ownerEmail) {
    void sendEmail({
      to:      ownerEmail,
      from:    FROM_EMAIL,
      replyTo: fromEmail,
      subject: `🔔 New email lead — ${company}`,
      text:
`A product enquiry email was auto-captured as a lead.

COMPANY   ${company}
CONTACT   ${extracted.contactName || "—"} <${fromEmail}>
PHONE     ${extracted.phone || "—"}
PRODUCT   ${extracted.product || "—"}
SUBJECT   ${subject || "—"}
SUMMARY   ${extracted.summary || "—"}

Open the lead: ${APP_URL}/leads
— ResellerOS`,
    }).catch((e) => console.error("[inbound-email] notify failed:", e));
  }

  return NextResponse.json({ received: true, leadId });
}
