/**
 * POST /api/v1/integrations/support-email-inbound
 *
 * Mail sent to support@ lands here — a forwarder (Cloudflare Email Routing / Postmark /
 * SendGrid / Mailgun, or the Apps Script forwarder this deployment already uses) POSTs the
 * parsed message, and the AI support agent answers it or fetches a person.
 *
 *   1. Verify the shared secret (INBOUND_EMAIL_SECRET) — fail closed.
 *   2. Normalise the provider payload.
 *   3. Claim the message id in `inbound_emails` (UNIQUE) → a provider retry cannot answer the
 *      same customer twice.
 *   4. Strip the quoted thread, then run the agent: find or open the ticket, understand the
 *      message, answer / ask / escalate.
 *   5. Record the ticket id back on the `inbound_emails` row, so the Inbox and the Support
 *      screen show the same event.
 *
 * ─── WHY A SECOND INGEST ENDPOINT RATHER THAN ONE MORE BRANCH ───────────────
 * `api/webhooks/inbound-email` already routes support@ to a `support` branch and opens a ticket
 * (lib/inbound/routing.ts), and that branch now runs this same agent — the two paths share
 * `runSupportAgentForMessage`, so there is one agent and one set of guards whichever door the
 * mail comes through.
 *
 * This endpoint exists because the two doors have genuinely different operational shapes. The
 * shared webhook is one URL a reseller points ALL their mail at, and it routes on the recipient
 * address; a support desk that wants its own forwarder, its own secret rotation and its own
 * failure mode should not have to share either. Pointing support@ here also removes the
 * classification step entirely: the URL is the statement of intent, which is stronger than an
 * address parsed out of a payload.
 *
 * ─── WHY IT SITS UNDER /api/v1 ──────────────────────────────────────────────
 * Stated plainly because it is a genuine inconsistency: the rest of `/api/v1` is an
 * API-KEY-authenticated surface for customers (`lib/api-keys/auth.ts`), and this route is a
 * shared-secret webhook. It is here because the brief named this path, and the auth is the one
 * a mail forwarder can actually use — an inbound-parse provider cannot mint an API key. A
 * reader who expects every /api/v1 route to be key-authenticated should read the guard below,
 * not assume it.
 *
 * Public route — the secret is the only guard, matching the sales webhook's fail-closed posture.
 * Uses the admin client (no session): a mail provider is not one of our users.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { acceptedSecrets, secretMatches, readInboundSecret, querySecretAllowed, querySecretWarning } from "@/lib/inbound/verify-secret";
import { normaliseSupportEmail } from "@/lib/inbound/support-inbound";
import { stripQuoted } from "@/lib/inbound/strip-quoted";
import { localPart } from "@/lib/inbound/routing";
import { runSupportAgentForMessage } from "@/lib/ai/run-support-agent";
import { inboundTenantId, inboundTenantMissingMessage } from "@/lib/inbound/tenant";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/* May hold SEVERAL secrets, comma-separated, so the value can be rotated without a window in
   which the forwarder is refused — lib/inbound/verify-secret.ts explains why a window here
   loses mail rather than merely failing requests. The SAME variable as the sales webhook, on
   purpose: two secrets to rotate is one that eventually does not get rotated. */
const INBOUND_SECRET = process.env.INBOUND_EMAIL_SECRET?.trim() || "";

const SELLER_NAME = process.env.SELLER_LEGAL_NAME?.trim() || "ANUTECH DIGITAL PVT LTD";
const FROM_EMAIL =
  process.env.RESEND_FROM_DEFAULT?.trim() || "ResellerOS <onboarding@resend.dev>";
/* The address the agent signs as. Env-overridable for the same reason the seller name is: this
   deployment can point a second reseller's mail at their own tenant, and a hardcoded
   support@anutech.in would have that reseller's customers replying to somebody else's desk. */
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL?.trim() || "support@anutech.in";
const APP_URL = process.env.NEXT_PUBLIC_APP_URL?.trim() || "https://resellersos.web.app";
/* R-1555: the tenant comes from lib/inbound/tenant.ts per request — no hard-coded fallback on a deployment. */

/**
 * Senders whose mail must never open a ticket.
 *
 * The same class the sales pipeline suppresses, and it matters more here: a bounce notice or an
 * out-of-office auto-reply arriving at support@ would open a ticket, get an answer, and the
 * answer would bounce again. Two automated systems can keep that up all night.
 */
const MACHINE_SENDERS = new Set([
  "noreply",
  "no-reply",
  "donotreply",
  "do-not-reply",
  "postmaster",
  "mailer-daemon",
  "abuse",
  "bounce",
  "bounces",
]);

export async function POST(request: NextRequest) {
  // ── 1. Secret guard (fail closed) ──────────────────────────────────────
  const secret = readInboundSecret(request);
  if (secret.fromQuery && !querySecretAllowed()) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!secretMatches(secret.value, acceptedSecrets(INBOUND_SECRET))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (secret.fromQuery) console.warn(querySecretWarning("v1/integrations/support-email-inbound"));

  /* R-1555: no company configured → 503, never a silent fallback to the Anutech tenant. */
  const tenantId = inboundTenantId();
  if (!tenantId) {
    console.error(inboundTenantMissingMessage("v1/integrations/support-email-inbound"));
    return NextResponse.json({ error: "not configured" }, { status: 503 });
  }

  // ── 2. Normalise the payload ───────────────────────────────────────────
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const mail = normaliseSupportEmail(body);

  if (!mail.fromEmail) {
    /* 400, not 500: the provider sent something unusable and retrying will send it again. The
       message is named in the response so whoever configured the forwarder can see which field
       was missing. */
    return NextResponse.json({ error: "Missing sender email" }, { status: 400 });
  }

  const admin = createAdminClient();

  // ── 3. Idempotency claim — the UNIQUE on message_id blocks replays ─────
  const { error: claimErr } = await admin.from("inbound_emails").insert({
    tenant_id: tenantId,
    message_id: mail.messageId,
    from_email: mail.fromEmail,
    from_name: mail.fromName || null,
    to_email: mail.toAddress || null,
    /* `support`, the same value lib/inbound/routing.ts assigns, so both ingest paths are one
       group in the Inbox rather than two vocabularies for the same thing. */
    route: "support",
    subject: mail.subject || null,
    body_text: mail.text || null,
    status: "received",
  });

  if (claimErr) {
    if (claimErr.code === "23505") {
      /* Already seen. 200 so the provider stops retrying — a duplicate is a success from its
         point of view, and a non-2xx here would have it deliver again forever. */
      return NextResponse.json({ received: true, duplicate: true });
    }
    console.error("[support-email-inbound] claim insert failed:", claimErr);
    return NextResponse.json({ error: "Could not record the message" }, { status: 500 });
  }

  const finalize = (status: string, ticketId: string | null) =>
    admin
      .from("inbound_emails")
      .update({ status, ticket_id: ticketId })
      .eq("tenant_id", tenantId)
      .eq("message_id", mail.messageId);

  // ── 4. Machine mail is recorded and dropped ────────────────────────────
  const senderBox = localPart(mail.fromEmail);
  if (senderBox && MACHINE_SENDERS.has(senderBox)) {
    /* Recorded deliberately: "we ignored this on purpose" and "we never received it" must not
       look the same when somebody goes looking for a missing message. */
    await finalize("ignored", null);
    return NextResponse.json({
      received: true,
      ignored: true,
      reason: `${senderBox}@ is a machine address, so no ticket was opened`,
    });
  }

  // ── 5. The agent ───────────────────────────────────────────────────────
  /* The quoted thread is stripped FIRST. A reply carries our own previous message underneath
     it, and an agent that reads its own words back treats them as the customer's — AGENTS.md
     L29, which cost a real misread. */
  const stripped = stripQuoted(mail.text);
  const incoming = stripped.text.trim() || mail.text.trim();

  if (!incoming) {
    /* An empty body is not answerable, and a ticket with no question in it would be escalated
       and land on somebody's queue saying nothing. The ticket is still opened — a customer who
       sent only an attachment did try to reach us — but the agent is not run. */
    await finalize("received_empty", null);
    return NextResponse.json({
      received: true,
      note: "Recorded. The message had no readable text, so there was nothing for the agent to read.",
    });
  }

  /* AWAITED, unlike the sales webhook's fire-and-forget call.
     The difference is what the caller does with the answer: this endpoint's response carries
     the ticket id, and a forwarder or an operator testing the hook needs to see whether a
     ticket was opened. The sales webhook returns before its agent runs because a provider is
     waiting on it and the lead is already committed; here the ticket IS the commit, and it is
     created inside this call.

     The cost is stated: this request holds open for the length of one Gemini call, which
     gemini.ts bounds at 15s with a breaker. A provider that times out will retry, and the
     message-id claim above makes the retry a no-op. */
  const result = await runSupportAgentForMessage({
    admin,
    tenantId,
    incoming,
    customerContact: mail.fromEmail,
    channel: "email",
    subject: mail.subject,
    senderName: mail.fromName,
    fromEmail: FROM_EMAIL,
    sellerName: SELLER_NAME,
    supportEmail: SUPPORT_EMAIL,
    appUrl: APP_URL,
  });

  if (!result.ticketId) {
    await finalize("error", null);
    /* 500 so the provider retries — a support request must not be lost because one insert
       failed. The claim row is left in place, so the retry is caught as a duplicate rather than
       opening a second ticket; that is the honest trade: this message needs a human either way,
       and the row is on the Inbox with status `error`. */
    return NextResponse.json({ error: "Could not open a ticket", detail: result.detail }, { status: 500 });
  }

  await finalize("ticket_created", result.ticketId);

  return NextResponse.json({
    received: true,
    route: "support",
    ticketId: result.ticketId,
    outcome: result.outcome,
    detail: result.detail,
  });
}
