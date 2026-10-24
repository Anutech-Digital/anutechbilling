/**
 * Meta WhatsApp Cloud API client — server-only.
 *
 * Reads per-tenant credentials from `tenant_secrets`. All callers go
 * through `sendWhatsApp()` so we have one place to update if Meta's API
 * version moves (currently v18.0).
 *
 * Send shape:
 *   - text:     { to, text: "..." }
 *   - template: { to, template: { name, language, components? } }
 *
 * Why a single send helper:
 *   - Quote send button, invoice send button, renewal cron, inbox
 *     reply, customer follow-up — all funnel through here
 *   - We persist the outbound message row on send so the Inbox page sees
 *     it immediately even before Meta's status callback lands.
 */

import "server-only";
import { createAdminClient } from "@/lib/supabase/server";
import { WhatsAppNotConfiguredError } from "./send-failure";
import { guardPhoneRecipient, PHONE_ALLOWLIST_ENV } from "@/lib/email/staging-allowlist";
import { decryptTenantSecrets } from "@/lib/crypto/tenant-secrets";
import type {
  WhatsAppMessageStatus,
  WhatsAppMessageType,
} from "@/lib/supabase/database.types";

const META_GRAPH_BASE = "https://graph.facebook.com/v18.0";

export interface WhatsAppCreds {
  phoneNumberId:    string;
  accessToken:      string;
  businessAccountId: string | null;
  verifyToken:      string | null;
  appSecret:        string | null;
}

/** Resolve per-tenant WhatsApp credentials. Returns null when not configured. */
export async function resolveWhatsAppCreds(tenantId: string): Promise<WhatsAppCreds | null> {
  const admin = createAdminClient();
  const { data: raw, error } = await admin
    .from("tenant_secrets")
    .select("whatsapp_phone_number_id, whatsapp_access_token, whatsapp_business_account_id, whatsapp_verify_token, whatsapp_app_secret")
    .eq("tenant_id", tenantId)
    .maybeSingle();
  /* Decrypt karo — /api/integrations/seal token ko envelope me band kar deta hai, aur bina
     decrypt ke Meta ko "Bearer enc:…" jaata, har send 401 (S28 me pakda, 28 Sep 2026). */
  const data = decryptTenantSecrets(raw);
  if (error || !data?.whatsapp_phone_number_id || !data.whatsapp_access_token) return null;
  return {
    phoneNumberId:     data.whatsapp_phone_number_id,
    accessToken:       data.whatsapp_access_token,
    businessAccountId: data.whatsapp_business_account_id,
    verifyToken:       data.whatsapp_verify_token,
    appSecret:         data.whatsapp_app_secret,
  };
}

/** Normalise a phone number to E.164 (no +, no spaces). Meta wants this. */
export function toE164(raw: string): string {
  // Strip non-digits, then drop a leading 91 if it's already there twice
  // (e.g. "+919876543210" → "919876543210").
  const digits = raw.replace(/\D/g, "");
  return digits;
}

export type WhatsAppSendInput =
  | { kind: "text";     text:     string }
  | {
      kind: "template";
      name: string;
      language: string;                // e.g. "en_US"
      components?: Array<unknown>;     // Meta's component shape
    }
  | {
      /** Send a PDF (or other binary) as a WhatsApp document. The buffer
       *  is uploaded to Meta's /media endpoint first; we then send a
       *  message of type "document" referencing the returned media_id.
       *  Caption is optional — shows below the document in WhatsApp. */
      kind:     "document";
      buffer:   Buffer;
      mime:     string;                // e.g. "application/pdf"
      filename: string;                // shown to recipient
      caption?: string;
    }
  | {
      /** Send an audio clip (e.g. a TTS reminder voice note). Uploaded to Meta's
       *  /media endpoint like a document; sent as a type:"audio" message. */
      kind:     "audio";
      buffer:   Buffer;
      mime:     string;                // e.g. "audio/wav" | "audio/ogg"
      filename: string;                // e.g. "reminder.wav" (media upload needs one)
    };

export interface WhatsAppSendResult {
  wamid:  string | null;
  status: WhatsAppMessageStatus;
  raw:    unknown;
}

/**
 * Outbound send + DB row insert in one call.
 *
 * Persistence: rows are written even on failure so the Inbox surfaces
 * red-status messages and we can retry from the UI later.
 */
export async function sendWhatsApp(opts: {
  tenantId:     string;
  to:           string;
  message:      WhatsAppSendInput;
  related?: {
    leadId?:     string | null;
    quoteId?:    string | null;
    customerId?: string | null;
  };
}): Promise<WhatsAppSendResult> {
  /* R-1403: staging messages only numbers on STAGING_PHONE_ALLOWLIST — checked before creds,
     upload or the outbox row, so a blocked number never reaches Meta. Logged masked. Live: off. */
  const guard = guardPhoneRecipient(opts.to);
  if (!guard.allowed) {
    console.warn(`[sendWhatsApp] dropped ${guard.reason}: to=${guard.masked} — nothing sent`);
    return {
      wamid: null,
      status: "failed",
      raw: { error: `Not sent — staging sends WhatsApp only to numbers on ${PHONE_ALLOWLIST_ENV}.`, reason: guard.reason },
    };
  }

  const creds = await resolveWhatsAppCreds(opts.tenantId);
  if (!creds) {
    throw new WhatsAppNotConfiguredError("WhatsApp credentials are not configured for this workspace. Settings → Integrations → WhatsApp Business.");
  }

  const admin = createAdminClient();
  const to    = toE164(opts.to);

  // For documents we have to upload the file to Meta's /media endpoint
  // first; that returns a media_id we then reference in the message body.
  let uploadedMediaId: string | null = null;
  if (opts.message.kind === "document" || opts.message.kind === "audio") {
    uploadedMediaId = await uploadWhatsAppMedia(
      { phoneNumberId: creds.phoneNumberId, accessToken: creds.accessToken },
      opts.message.buffer,
      opts.message.mime,
      opts.message.filename,
    );
  }

  // Build the Meta payload
  let payload: Record<string, unknown>;
  let rowType: WhatsAppMessageType;
  if (opts.message.kind === "text") {
    rowType = "text";
    payload = {
      messaging_product: "whatsapp",
      recipient_type:    "individual",
      to,
      type:              "text",
      text:              { preview_url: false, body: opts.message.text },
    };
  } else if (opts.message.kind === "document") {
    rowType = "document";
    payload = {
      messaging_product: "whatsapp",
      recipient_type:    "individual",
      to,
      type:              "document",
      document: {
        id:       uploadedMediaId,
        filename: opts.message.filename,
        ...(opts.message.caption ? { caption: opts.message.caption } : {}),
      },
    };
  } else if (opts.message.kind === "audio") {
    rowType = "audio";
    payload = {
      messaging_product: "whatsapp",
      recipient_type:    "individual",
      to,
      type:              "audio",
      audio: { id: uploadedMediaId },
    };
  } else {
    rowType = "template";
    payload = {
      messaging_product: "whatsapp",
      recipient_type:    "individual",
      to,
      type:              "template",
      template: {
        name:     opts.message.name,
        language: { code: opts.message.language },
        ...(opts.message.components ? { components: opts.message.components } : {}),
      },
    };
  }

  // Stub-insert as 'pending' so Inbox shows the row immediately.
  const { data: pendingRow } = await admin
    .from("whatsapp_messages")
    .insert({
      tenant_id:           opts.tenantId,
      contact_phone:       `+${to}`,
      direction:           "outbound",
      type:                rowType,
      // Text-bearing body: text body for text msgs, caption for documents
      text_body:
        opts.message.kind === "text"     ? opts.message.text     :
        opts.message.kind === "document" ? (opts.message.caption ?? null) :
                                            null,
      template_name:       opts.message.kind === "template" ? opts.message.name : null,
      template_lang:       opts.message.kind === "template" ? opts.message.language : null,
      template_params:     opts.message.kind === "template" ? opts.message.components ?? null : null,
      // Media references — set for document + audio sends
      media_id:            (opts.message.kind === "document" || opts.message.kind === "audio") ? uploadedMediaId : null,
      media_mime:          (opts.message.kind === "document" || opts.message.kind === "audio") ? opts.message.mime     : null,
      media_filename:      (opts.message.kind === "document" || opts.message.kind === "audio") ? opts.message.filename : null,
      status:              "pending",
      related_lead_id:     opts.related?.leadId     ?? null,
      related_quote_id:    opts.related?.quoteId    ?? null,
      related_customer_id: opts.related?.customerId ?? null,
    })
    .select("id")
    .single();

  // Fire the actual Meta call
  let res: Response;
  try {
    res = await fetch(`${META_GRAPH_BASE}/${encodeURIComponent(creds.phoneNumberId)}/messages`, {
      method:  "POST",
      headers: {
        "Authorization": `Bearer ${creds.accessToken}`,
        "Content-Type":  "application/json",
      },
      body:   JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "network error";
    if (pendingRow?.id) {
      await admin.from("whatsapp_messages").update({
        status: "failed", error_message: msg,
      }).eq("id", pendingRow.id);
    }
    throw new Error(`WhatsApp send failed: ${msg}`);
  }

  const json: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const errMsg =
      json && typeof json === "object"
        ? (json as { error?: { message?: string; code?: number } }).error?.message
        : null;
    const friendly: string = errMsg ?? `Meta responded ${res.status}`;
    if (pendingRow?.id) {
      await admin.from("whatsapp_messages").update({
        status:       "failed",
        error_code:   String((json as { error?: { code?: number } }).error?.code ?? res.status),
        error_message: friendly,
      }).eq("id", pendingRow.id);
    }
    throw new Error(`WhatsApp send failed: ${friendly}`);
  }

  // Success — pluck wamid, flip status to 'sent'
  const wamid =
    (json as { messages?: Array<{ id?: string }> }).messages?.[0]?.id ?? null;
  if (pendingRow?.id) {
    await admin.from("whatsapp_messages").update({
      wamid,
      status: "sent",
    }).eq("id", pendingRow.id);
  }
  return { wamid, status: "sent", raw: json };
}

/**
 * Upload a binary blob (PDF / image / etc) to Meta's /media endpoint
 * for the configured phone number. Returns the media_id Meta hands back,
 * which can then be referenced in a "document"/"image"/"video" message.
 *
 *   POST /{phone_number_id}/media
 *   Headers:  Authorization: Bearer ...
 *   Body:     multipart/form-data
 *             - messaging_product: "whatsapp"
 *             - type:              "<mime>"  (Meta accepts the actual MIME)
 *             - file:              <binary>
 */
async function uploadWhatsAppMedia(
  creds:    { phoneNumberId: string; accessToken: string },
  buffer:   Buffer,
  mime:     string,
  filename: string,
): Promise<string> {
  // Node's global Blob / FormData are stable in Node 18+. Cast Buffer to
  // a fresh Uint8Array to satisfy the BlobPart typing (Buffer's underlying
  // ArrayBufferLike isn't assignable to the strict ArrayBuffer that Blob
  // expects in current Node typings).
  const blob = new Blob([new Uint8Array(buffer)], { type: mime });
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type",              mime);
  form.append("file",              blob, filename);

  const res = await fetch(`${META_GRAPH_BASE}/${encodeURIComponent(creds.phoneNumberId)}/media`, {
    method:  "POST",
    headers: {
      "Authorization": `Bearer ${creds.accessToken}`,
      // NOTE: do NOT set Content-Type — fetch will fill in the multipart
      // boundary automatically. Setting it manually breaks the upload.
    },
    body:   form,
    signal: AbortSignal.timeout(30_000),  // PDFs can be ~MB, give it room
  });
  const json = (await res.json().catch(() => ({}))) as {
    id?: string;
    error?: { message?: string; type?: string; code?: number; error_subcode?: number; error_user_msg?: string };
  };
  if (!res.ok || !json.id) {
    const err = json.error;
    const detail = err
      ? [
          err.message,
          err.code !== undefined ? `code ${err.code}` : null,
          err.error_subcode != null ? `subcode ${err.error_subcode}` : null,
          err.type,
          err.error_user_msg,
        ].filter(Boolean).join(" · ")
      : `Meta /media responded ${res.status}`;
    // Log the full payload to the server console so the operator can see
    // exactly what Meta said. The toast only carries the short reason.
    console.error("[whatsapp/media] upload failed", { status: res.status, body: json });
    throw new Error(`WhatsApp media upload failed: ${detail}`);
  }
  return json.id;
}
