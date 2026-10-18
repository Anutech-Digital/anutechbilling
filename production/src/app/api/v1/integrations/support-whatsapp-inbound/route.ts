/**
 * GET  /api/v1/integrations/support-whatsapp-inbound?tenant=…  → Meta verification handshake
 * POST /api/v1/integrations/support-whatsapp-inbound?tenant=…  → inbound support messages
 *
 * A WhatsApp number used as a support line. Meta POSTs each message here and the AI support
 * agent answers it or fetches a person.
 *
 * Setup mirrors the existing WhatsApp webhook, and the credentials are the SAME ones (Settings →
 * Integrations → WhatsApp): verify token for the handshake, app secret for the signature. Point
 * the SUPPORT number's webhook at this URL and the sales number's at
 * `/api/webhooks/whatsapp`, and each conversation reaches the right agent without anybody having
 * to classify it.
 *
 * ─── WHY A SEPARATE ENDPOINT AND NOT A CLASSIFIER ───────────────────────────
 * One number cannot be split reliably. "My renewal price seems wrong" is a support message and
 * a sales message depending on who you ask, and a model asked to choose will disagree with the
 * customer some fraction of the time — sending a broken-mail complaint to a salesperson, or a
 * buying enquiry to a support queue. The URL a message arrives on is a FACT, it is free, and it
 * is chosen by whoever set up the number. Route on the fact; use the model inside the branch.
 * `lib/inbound/routing.ts` makes exactly this argument for mail recipients.
 *
 * If a deployment has only one WhatsApp number, it points that number at ONE of these two URLs.
 * That is a real limitation and it is the honest one: the alternative is a coin toss on every
 * message.
 *
 * Security — MANDATORY HMAC on POST, matching the existing webhook. No app secret stored means
 * every POST is refused, because an unverified webhook is unauthenticated write access rather
 * than a weaker check.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { answerHandshake } from "@/lib/whatsapp/handshake";
import { verifyMetaSignature, signatureRefusalReason } from "@/lib/crypto/webhook-signature";
import { decryptTenantSecrets } from "@/lib/crypto/tenant-secrets";
import { runSupportAgentForMessage } from "@/lib/ai/run-support-agent";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const SELLER_NAME = process.env.SELLER_LEGAL_NAME?.trim() || "ANUTECH DIGITAL PVT LTD";
const FROM_EMAIL =
  process.env.RESEND_FROM_DEFAULT?.trim() || "ResellerOS <onboarding@resend.dev>";
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL?.trim() || "support@anutech.in";
const APP_URL = process.env.NEXT_PUBLIC_APP_URL?.trim() || "https://resellersos.web.app";

/** Bounded so one webhook delivery cannot become an unbounded fan-out of model calls. */
const MAX_MESSAGES_PER_DELIVERY = 10;

type MetaMessage = {
  from: string;
  id: string;
  timestamp?: string;
  type: string;
  text?: { body?: string };
  image?: { id?: string; mime_type?: string; caption?: string };
  document?: { id?: string; mime_type?: string; filename?: string; caption?: string };
  video?: { id?: string; mime_type?: string; caption?: string };
  audio?: { id?: string; mime_type?: string };
  sticker?: { id?: string; mime_type?: string };
};

type MetaChangeValue = {
  metadata?: { phone_number_id?: string; display_phone_number?: string };
  contacts?: Array<{ profile?: { name?: string }; wa_id?: string }>;
  messages?: MetaMessage[];
};

export async function GET(req: NextRequest) {
  /* R-1550: sealed token decrypt hota hai, aur har refusal ka ek hi 403 — lib/whatsapp/handshake.ts. */
  return answerHandshake(new URL(req.url), async (tenantId) => {
    const { data } = await createAdminClient()
      .from("tenant_secrets")
      .select("whatsapp_verify_token")
      .eq("tenant_id", tenantId)
      .maybeSingle();
    return data;
  });
}

export async function POST(req: NextRequest) {
  const url = new URL(req.url);
  const tenantId = url.searchParams.get("tenant");
  if (!tenantId) return NextResponse.json({ error: "missing tenant" }, { status: 400 });

  const rawBody = await req.text();
  const admin = createAdminClient();

  const { data: secrets } = await admin
    .from("tenant_secrets")
    .select("whatsapp_app_secret")
    .eq("tenant_id", tenantId)
    .maybeSingle();

  const verdict = verifyMetaSignature(
    rawBody,
    req.headers.get("x-hub-signature-256"),
    decryptTenantSecrets(secrets)?.whatsapp_app_secret,
  );
  if (!verdict.ok) {
    console.warn(
      `[support-whatsapp-inbound] refused for tenant ${tenantId} — ${signatureRefusalReason(verdict.reason)}`,
    );
    // Same body for every reason: telling a caller whether a secret exists is itself
    // information about the tenant.
    return NextResponse.json({ error: "bad signature" }, { status: 401 });
  }

  let body: {
    entry?: Array<{ id?: string; changes?: Array<{ field?: string; value?: MetaChangeValue }> }>;
  };
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  const handled: Array<{ ticketId: string | null; outcome: string }> = [];
  let stored = 0;
  let skipped = 0;

  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== "messages") continue;
      const v = change.value ?? {};

      for (const m of v.messages ?? []) {
        if (handled.length >= MAX_MESSAGES_PER_DELIVERY) {
          /* Reported, not silently dropped. A truncated batch that reads as a clean run is the
             "no silent caps" failure — somebody would later find a message that was received,
             acknowledged and never answered, with nothing in the log about it. */
          console.warn(
            `[support-whatsapp-inbound] delivery for tenant ${tenantId} carried more than ` +
              `${MAX_MESSAGES_PER_DELIVERY} messages — the rest were stored but not answered`,
          );
          skipped++;
          continue;
        }

        const text =
          m.text?.body ?? m.image?.caption ?? m.video?.caption ?? m.document?.caption ?? null;

        const KNOWN: ReadonlyArray<string> = [
          "text",
          "template",
          "image",
          "document",
          "video",
          "audio",
          "location",
          "reaction",
          "sticker",
          "button",
          "interactive",
        ];
        const type = (KNOWN.includes(m.type) ? m.type : "unsupported") as
          | "text"
          | "template"
          | "image"
          | "document"
          | "video"
          | "audio"
          | "location"
          | "reaction"
          | "sticker"
          | "button"
          | "interactive"
          | "unsupported";

        const tsSec = m.timestamp ? Number(m.timestamp) : null;
        const tsIso = tsSec && Number.isFinite(tsSec) ? new Date(tsSec * 1000).toISOString() : null;

        const { error: insertErr } = await admin.from("whatsapp_messages").insert({
          tenant_id: tenantId,
          wamid: m.id,
          contact_phone: `+${m.from}`,
          direction: "inbound",
          type,
          text_body: text,
          media_id:
            m.image?.id ?? m.document?.id ?? m.video?.id ?? m.audio?.id ?? m.sticker?.id ?? null,
          media_mime:
            m.image?.mime_type ??
            m.document?.mime_type ??
            m.video?.mime_type ??
            m.audio?.mime_type ??
            m.sticker?.mime_type ??
            null,
          media_filename: m.document?.filename ?? null,
          status: "received",
          meta_timestamp: tsIso,
        });

        if (!insertErr) stored++;

        /* ── Hand it to the AI support agent ──────────────────────────────────
           GATED ON `!insertErr`, and that single condition is the whole idempotency story.
           Meta retries a webhook until it gets a 200, and this route always returns 200 — so
           without the gate a retried delivery would run the agent again and answer the same
           customer twice. The unique index on (tenant_id, wamid) is what makes the retry
           detectable at all: the second insert fails, `insertErr` is set, and the agent does
           not run.

           Text only. An image, a sticker or a reaction has nothing for the model to read, and
           `text` is already null for those — answering "👍" would be the app talking to itself.
           The message is still STORED, so the Inbox shows it and a person can pick it up.

           AWAITED, unlike the sales WhatsApp webhook's fire-and-forget call. A support message
           has to reach a TICKET, and the ticket is created inside this call; returning 200
           before that has happened would mean a Meta retry (which the wamid claim swallows)
           could be the only thing that would have created it. Bounded above so one delivery
           cannot hold the request open indefinitely. */
        if (!insertErr && type === "text" && text && text.trim()) {
          const phone = `+${m.from}`;
          const profileName =
            (v.contacts ?? []).find((c) => c.wa_id === m.from)?.profile?.name ?? "";

          try {
            const result = await runSupportAgentForMessage({
              admin,
              tenantId,
              incoming: text.trim(),
              customerContact: phone,
              channel: "whatsapp",
              /* WhatsApp has no subject line. run-support-agent derives the ticket title from
                 the customer's own first line, which scans far better in the Support list than
                 a column of "WhatsApp support request". */
              subject: "",
              senderName: profileName,
              fromEmail: FROM_EMAIL,
              sellerName: SELLER_NAME,
              supportEmail: SUPPORT_EMAIL,
              appUrl: APP_URL,
            });
            handled.push({ ticketId: result.ticketId, outcome: result.outcome });
          } catch (err) {
            /* One bad message must not end the delivery — the others in this batch are real
               customers waiting. Never rethrown: Meta would retry the whole batch and the
               messages that DID succeed are already claimed, so the retry would answer none of
               them and lose this one's error. */
            console.error("[support-whatsapp-inbound] support agent crashed:", err);
            handled.push({ ticketId: null, outcome: "crashed" });
          }
        }
      }
    }
  }

  // Meta retries until 200. Always 200 unless we want it to re-deliver.
  return NextResponse.json({ ok: true, stored, answered: handled.length, skipped, handled });
}
