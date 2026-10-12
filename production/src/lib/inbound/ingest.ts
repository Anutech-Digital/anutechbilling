/**
 * Inbound email → Lead. The work, with no door on it.
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
 *   5. A reply from somebody who already has an OPEN lead is filed on that
 *      conversation and is NEVER classified — the classifier is for strangers.
 *      Only when nobody matches: enquiry → create a Lead, non-enquiry → Spam /
 *      System. That ORDER is load-bearing; see lib/inbound/disposition.ts for the
 *      bug it fixes.
 *   5b. PHASE 1 — a reply that CHANGES what the customer wants (seats, product) is
 *      written into the lead, with the customer's own sentence recorded as the reason.
 *      Deterministic, not a model: lib/inbound/extract.ts. The quoted thread is
 *      stripped first, because a reply carries our previous message — and the numbers
 *      being corrected — underneath it.
 *   6. Notify the reseller owner (best-effort email).
 *
 * Public route — the secret is the only guard (mirrors the Razorpay webhook's
 * fail-closed posture). Uses the admin client (no session). v1 routes leads to
 * the single buy-page tenant; multi-tenant maps the ingest address → tenant later.
 */
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { resolveGeminiConfig, geminiJson } from "@/lib/ai/gemini";
import { sendInternalEmail } from "@/lib/messaging";
import { decideFollowUp, type FollowUpInput } from "@/lib/inbound/follow-up";
import { decideInboundRoute } from "@/lib/inbound/routing";
import { decideDisposition } from "@/lib/inbound/disposition";
import { continuesThread } from "@/lib/inbound/thread-match";
import { stripQuoted } from "@/lib/inbound/strip-quoted";
import { isSelfTest, selfTestMarkerMisplaced, SELF_TEST_MARKER } from "@/lib/inbound/self-test";
import { autoQuoteForLead, agentMaySendSeparateReply } from "@/lib/quotes/auto-quote-for-lead";
import { readEnquiryFacts } from "@/lib/inbound/read-enquiry";
import { shouldRequoteOnReply } from "@/lib/quotes/requote-on-reply";
import { runSalesAgentForLead } from "@/lib/ai/run-sales-agent";
import { runSupportAgentForMessage } from "@/lib/ai/run-support-agent";
import { planCorrections, correctionDetail } from "@/lib/leads/apply-correction";
import { extractAttachments, pickBillAttachment } from "@/lib/inbound/attachments";
import { readBillWithGemini } from "@/lib/ai/read-bill";
import { sanitizeExtractedBill } from "@/app/api/ai/extract-bill/sanitize";
import type { SupabaseClient } from "@supabase/supabase-js";

/* The trading name the AI sales agent signs as. Env-overridable because this route already
   supports pointing a second reseller's forwarded mail at their own tenant via
   INBOUND_EMAIL_TENANT_ID — a hardcoded name would have that reseller's customers receiving
   mail signed by somebody else's company. */
const SELLER_NAME = process.env.SELLER_LEGAL_NAME?.trim() || "ANUTECH DIGITAL PVT LTD";
const FROM_EMAIL     = process.env.RESEND_FROM_DEFAULT?.trim() || "ResellerOS <onboarding@resend.dev>";
/* The address the AI support agent signs as. Env-overridable for the same reason SELLER_NAME
   is: this route can point a second reseller's mail at their own tenant, and a hardcoded
   support@anutech.in would have that reseller's customers replying to somebody else's desk. */
const SUPPORT_EMAIL  = process.env.SUPPORT_EMAIL?.trim() || "support@anutech.in";
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

  /* ── PEHLE YE APNA `fetch` KARTA THA ──────────────────────────────────────
     Wo `geminiJson` ki lagbhag hu-ba-hu copy thi — wahi request shape, wahi ```json fence
     ka safai — bas uski SAARI suraksha ke bina: **koi timeout nahi, koi circuit breaker
     nahi, koi retry nahi**. Aur ye har inbound email ke raaste par hai.

     23 Aug 2026 ko iski keemat log me dikhi: `[inbound-email] Gemini failed: 429` —
     **7 second me 8 baar**. Free-tier ka quota `GenerateRequestsPerMinutePerProjectPerModel`
     hai aur uski limit **5 per minute** hai. `geminiJson` ka breaker 3 lagatar failure ke
     baad haath rok deta hai; ye bina breaker tha, isliye quota par hathauda maarta raha.

     Aur timeout ka na hona isse bhi bura tha: Gemini agar fail na ho kar ATAK jaye, to ye
     request uske saath atak jaati — aur ise Apps Script forwarder bulata hai, jo POST ke
     baad thread par label laga deta hai bina jawab dekhe. Yaani ek atki hui call = ek
     enquiry hamesha ke liye gayi.

     Ab ek hi darwaza: lib/ai/gemini.ts. */
  const p = await geminiJson<Partial<ExtractedLead>>({
    apiKey, model, system, user,
    temperature: 0.2,
    label: "inbound-email/extract",
  });
  if (!p) return null;

  return {
    isEnquiry:   p.isEnquiry === true,
    company:     (p.company ?? "").toString().trim(),
    contactName: (p.contactName ?? "").toString().trim(),
    phone:       (p.phone ?? "").toString().trim(),
    product:     (p.product ?? "").toString().trim(),
    summary:     (p.summary ?? "").toString().trim(),
  };
}

/**
 * Everything this endpoint does once it believes the caller — normalise, route, classify,
 * create or append to a lead.
 *
 * ─── WHY IT IS A FUNCTION AND NOT JUST THE REST OF `POST` ───────────────────
 * 30 Aug 2026: the app started reading `sales@anutech.in` directly through the Gmail
 * connector (`/api/cron/gmail-inbox`), because the Apps Script forwarder in front of this
 * webhook had failed silently — a stale copy posting an old `?key=` secret, 401 on every
 * run, and no enquiry reaching the app for two days.
 *
 * That gave this logic a SECOND caller, and there were only two ways to do it. Copying six
 * hundred lines was never one of them; the same argument `lib/ai/read-bill.ts` makes about
 * a copied prompt applies harder here, because these branches create leads and tasks.
 *
 * The other rejected option was to have the cron POST to its own public URL with the
 * secret. That works — it is exactly what the Apps Script did — but it authenticates the
 * process to itself over the network to reach a function it already has in memory, and the
 * failure it would then be able to report is one that cannot happen.
 *
 * So: `POST` owns the door (the secret, the JSON), and this owns the work. The webhook is
 * still the only thing exposed to the internet, and it is unchanged.
 */
export async function ingestInboundEmail(body: Record<string, unknown>): Promise<NextResponse> {
  // ── 2. Normalise payload across common inbound-parse providers ─────────
  const str = (...keys: string[]): string => {
    for (const k of keys) {
      const v = body[k];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    return "";
  };

  /**
   * Normalise headers across inbound-parse providers.
   *
   * Needed because the bulk-mail suppression in lib/inbound/follow-up.ts keys off
   * `List-Unsubscribe`, `Precedence` and `Auto-Submitted`. Without this the
   * headers arrive as undefined and that whole defence is dead code -- it would
   * look implemented and never fire once. Each provider ships a different shape:
   *
   *   Mailgun  "message-headers"  JSON (or string) array of [name, value]
   *   Postmark "Headers"          array of { Name, Value }
   *   SendGrid "headers"          one raw "Name: value" block, CRLF separated
   *
   * Keys are lower-cased; header names are case-insensitive per RFC 5322.
   */
  const extractHeaders = (): Record<string, string> => {
    const out: Record<string, string> = {};
    const put = (k: unknown, v: unknown) => {
      if (typeof k === "string" && k.trim() && typeof v === "string") {
        out[k.trim().toLowerCase()] = v.trim().slice(0, 500);
      }
    };

    let mg = body["message-headers"] ?? body["message_headers"];
    if (typeof mg === "string") { try { mg = JSON.parse(mg); } catch { mg = null; } }
    if (Array.isArray(mg)) {
      for (const pair of mg) if (Array.isArray(pair)) put(pair[0], pair[1]);
    }

    const pm = body["Headers"] ?? body["headers_json"];
    if (Array.isArray(pm)) {
      for (const h of pm) {
        const o = h as { Name?: unknown; Value?: unknown; name?: unknown; value?: unknown };
        put(o.Name ?? o.name, o.Value ?? o.value);
      }
    }

    const sg = body["headers"];
    if (typeof sg === "string") {
      for (const line of sg.split(/\r?\n/)) {
        const i = line.indexOf(":");
        if (i > 0) put(line.slice(0, i), line.slice(i + 1));
      }
    } else if (sg && typeof sg === "object" && !Array.isArray(sg)) {
      for (const [k, v] of Object.entries(sg as Record<string, unknown>)) put(k, v);
    }

    return out;
  };
  const rawHeaders = extractHeaders();

  const rawFrom   = str("from", "sender", "From", "from_email");
  /* The recipient. Every provider names it differently, and it was not being
     read at all — which is why every message became a Lead regardless of whether
     it was sent to sales@, support@ or billing@. */
  const rawTo     = str("to", "To", "recipient", "recipients", "envelope_to", "OriginalRecipient");
  const { name: parsedName, email: fromEmail } = parseFrom(rawFrom);
  const fromName  = str("fromName", "from_name", "sender_name") || parsedName;
  const subject   = str("subject", "Subject");

  /**
   * What the SALES AGENT reads — subject line included.
   *
   * ─── THE SUBJECT WAS INVISIBLE TO IT, AND THAT LOST A REAL ENQUIRY ────────
   * 30 Aug 2026, on production, minutes after the pipeline was fixed. Pardeep emailed
   * sales@ with the whole request in the SUBJECT and nothing in the body:
   *
   *   Subject: mujhe 60 email ke liye quote chahiye google workspace business starter
   *   Body:    "--  Regards, Pardeep Sharma | Sales Co-ordinator | sales@omegaco.test"
   *
   * The mail arrived in 63 seconds and became a lead. Then nothing. `ai_action_log` said
   * `reply.send / held — "Qualifier requested a colleague to take over the lead"`.
   *
   * The agent was handed `incoming: fresh.text || text` — the BODY, and only the body. So
   * all it could see was a signature reading "Sales Co-ordinator", and it concluded a
   * colleague was passing a lead along. Given that input the handover was a sensible
   * decision; the input was the bug.
   *
   * Writing the whole request in the subject and leaving the body empty is completely
   * ordinary — Pardeep did it without thinking about it. `extractEntities` has always read
   * subject AND body for exactly that reason (that is why seats still came out right); the
   * agent alone was reading half the email.
   *
   * Labelled rather than concatenated, so the model can tell the two apart the way a person
   * reading an inbox does.
   */
  const withSubject = (body: string): string =>
    subject.trim() ? `Subject: ${subject.trim()}\n\n${body}`.trim() : body;
  const text      = str("text", "body-plain", "plain", "TextBody", "stripped-text", "body");
  const html      = str("html", "body-html", "HtmlBody", "stripped-html");
  const messageId = str("messageId", "message_id", "Message-Id", "MessageID", "Message-ID")
    || `noid-${fromEmail}-${subject}`.slice(0, 200);

  /* ── Thread ke headers (RFC 5322) ─────────────────────────────────────────
     26 Aug 2026 ko joda. Ye batate hain ki mail kisi cheez ka JAWAB hai — aur usi par tay
     hota hai ki jaane-pehchane sender ka mail purani lead par jude ya nayi lead bane.
     Poori wajah lib/inbound/thread-match.ts me.

     `rawHeaders` pehle se bana hua hai (lowercased keys) aur pehle se do jagah jaata hai;
     ye sirf usme se do khaane padh raha hai. `str()` bhi try kiya jaata hai kyunki kuch
     provider inhe top-level field ki tarah bhejte hain, header map me nahi. */
  const inReplyTo  = (rawHeaders["in-reply-to"] ?? str("inReplyTo", "in_reply_to") ?? "").trim();
  const references = (rawHeaders["references"]  ?? str("references")               ?? "").trim();

  if (!fromEmail) {
    return NextResponse.json({ error: "Missing sender email" }, { status: 400 });
  }

  const admin    = createAdminClient();
  const tenantId = INBOUND_TENANT_ID;

  // ── 2b. Route on WHO IT WAS SENT TO, before anything is created ─────────
  // The address the sender chose is a fact and it is their own statement of
  // intent; the model is used inside the branch, not to pick the branch.
  const routing = decideInboundRoute(rawTo, rawFrom);
  console.log(`[inbound-email] route=${routing.route} — ${routing.reason}`);

  // ── 3. Idempotency claim — insert the message_id; UNIQUE blocks replays ─
  const { error: claimErr } = await admin.from("inbound_emails").insert({
    tenant_id:  tenantId,
    message_id: messageId,
    from_email: fromEmail,
    from_name:  fromName || null,
    to_email:   rawTo || null,
    route:      routing.route,
    subject:    subject || null,
    body_text:  text || null,
    body_html:  html || null,
    /* Thread ke headers. Faisla inhe padhe bina bhi ho jata hai (subject se), par darj hone
       par do cheezein milti hain: ek galat faisle ko baad me naapa ja sakta hai, aur ye
       pata chalta hai ki forwarder headers bhejta hai ya nahi — jo abhi maloom NAHI hai. */
    in_reply_to:       inReplyTo || null,
    thread_references: references || null,
    status:     "received",
  });
  if (claimErr) {
    if (claimErr.code === "23505") {
      return NextResponse.json({ received: true, duplicate: true });
    }
    console.error("[inbound-email] claim insert failed:", claimErr);
    return NextResponse.json({ error: "Could not record email" }, { status: 500 });
  }

  const finalize = (status: string, leadId: string | null, ticketId?: string | null) =>
    admin.from("inbound_emails").update({
      status,
      lead_id: leadId,
      ...(ticketId !== undefined ? { ticket_id: ticketId } : {}),
    })
      .eq("tenant_id", tenantId).eq("message_id", messageId);

  // ── 3b. Branch on the route ────────────────────────────────────────────
  //
  // Each branch returns; only `sales` falls through to the Gemini + lead path
  // below, which is exactly what this endpoint did for EVERY message before.

  if (routing.route === "ignored") {
    // Bounce notices and auto-replies. Recorded, deliberately: "we ignored this
    // on purpose" and "we never received it" must not look the same later.
    await finalize("ignored", null);
    return NextResponse.json({ received: true, route: "ignored", reason: routing.reason });
  }

  if (routing.route === "support") {
    /* Handed to the AI support agent, which opens (or reuses) the ticket and then answers,
       asks, or escalates. Added 24 Aug 2026.
     *
     * ─── THE TICKET INSERT MOVED, IT WAS NOT DUPLICATED ─────────────────────
     * This branch used to insert the ticket itself. `runSupportAgentForMessage` now does it,
     * with two behaviours this branch could not have: an existing OPEN ticket from the same
     * sender is REUSED rather than duplicated (a customer replying three times used to get
     * three tickets), and a ticket resolved in the last 48 hours is reopened, which is what
     * the resolution note tells the customer will happen. Leaving the insert here as well
     * would mean two tickets per message — the same "two drafters on one webhook" mistake
     * `run-sales-agent.ts`'s header describes for replies.
     *
     * customer_id still stays null there, for the same reason it did here: the sender may not
     * be a known customer and guessing one would attach a stranger's ticket to a real account.
     *
     * AWAITED, unlike the sales branch's fire-and-forget agent call. The response carries the
     * ticket id and the ticket is created inside this call, so returning first would mean
     * reporting a ticket that does not exist yet. */
    const stripped = stripQuoted(text || html || "");
    const incoming = stripped.text.trim() || (text || html || "").trim();

    if (!incoming) {
      /* No readable text, so there is nothing for the agent to read — but the customer did try
         to reach us, so the message is recorded rather than dropped. No ticket is opened: one
         with no question in it would be escalated and land on somebody's queue saying nothing. */
      await finalize("received_empty", null, null);
      return NextResponse.json({
        received: true, route: "support",
        note: "Recorded. The message had no readable text, so no ticket was opened.",
      });
    }

    const support = await runSupportAgentForMessage({
      admin,
      tenantId,
      incoming,
      customerContact: fromEmail,
      channel: "email",
      subject,
      senderName: fromName,
      fromEmail: FROM_EMAIL,
      sellerName: SELLER_NAME,
      supportEmail: SUPPORT_EMAIL,
      appUrl: APP_URL,
    });

    if (!support.ticketId) {
      console.error("[inbound-email] support ticket could not be opened:", support.detail);
      await finalize("error", null, null);
      // 500 so the provider retries — a support request must not be lost
      // because one insert failed.
      return NextResponse.json({ error: "Could not open a ticket" }, { status: 500 });
    }

    await finalize("ticket_created", null, support.ticketId);
    return NextResponse.json({
      received: true, route: "support", ticketId: support.ticketId,
      outcome: support.outcome, detail: support.detail,
    });
  }

  if (routing.route === "billing") {
    /* Read the bill, store the original, post NOTHING to the books.
     *
     * /api/ai/extract-bill has always refused to write money from an extraction
     * — "AI can misread amounts, and this feeds GST input credit + P&L, so a
     * human must confirm". That rule matters MORE here, not less: an emailed
     * bill is less trustworthy than an uploaded one, because nobody was looking
     * when it arrived, and anyone who learns the ingest address could otherwise
     * post entries into the books. So `extracted_bill` is a suggestion and
     * `bill_id` stays null until a person reviews it. */
    const attachment = pickBillAttachment(extractAttachments(body));

    if (!attachment) {
      await finalize("billing_no_attachment", null, null);
      return NextResponse.json({
        received: true, route: "billing",
        note: "Recorded. No readable PDF or image was attached, so there was nothing to read.",
      });
    }

    // Mailgun sends a URL instead of bytes. Fetching it needs that provider's
    // credentials, which are not configured — say so plainly rather than
    // recording a success that read nothing.
    if (!attachment.base64) {
      await finalize("billing_attachment_url_only", null, null);
      return NextResponse.json({
        received: true, route: "billing", attachment: attachment.filename,
        note: "Recorded. The provider sent a link instead of the file, and fetching it is not wired.",
      });
    }

    // Keep the original. Without it the extraction cannot be checked, and an
    // audit asks for the invoice — not for what a model thought it said.
    let storedPath: string | null = null;
    try {
      const path = `${tenantId}/inbound-bills/${messageId.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80)}-${attachment.filename}`;
      const { error: upErr } = await admin.storage
        .from("documents")
        .upload(path, Buffer.from(attachment.base64, "base64"), {
          contentType: attachment.mimeType, upsert: true,
        });
      if (upErr) console.error("[inbound-email] attachment upload failed:", upErr.message);
      else storedPath = path;
    } catch (e) {
      console.error("[inbound-email] attachment upload crashed:", (e as Error).message);
    }

    const gem = await resolveGeminiConfig(admin, tenantId);
    let extracted: unknown = null;
    if (gem.apiKey) {
      const ai = await readBillWithGemini({
        apiKey: gem.apiKey, model: gem.model,
        mimeType: attachment.mimeType, base64: attachment.base64,
      });
      if (ai) extracted = sanitizeExtractedBill(ai);
    }

    await admin.from("inbound_emails").update({
      status:          extracted ? "bill_extracted" : "billing_unread",
      attachment_path: storedPath,
      attachment_name: attachment.filename,
      attachment_mime: attachment.mimeType,
      extracted_bill:  (extracted as never) ?? null,
    }).eq("tenant_id", tenantId).eq("message_id", messageId);

    return NextResponse.json({
      received: true, route: "billing",
      attachment: attachment.filename,
      stored: Boolean(storedPath),
      extracted: Boolean(extracted),
      note: extracted
        ? "Read and saved as a suggestion. No vendor bill was created — a person must review the figures first."
        : gem.apiKey
          ? "Attachment stored, but the bill could not be read. Review it by hand."
          : "Attachment stored. No Gemini key is configured, so nothing was read.",
    });
  }

  /**
   * Create a follow-up task for an email that earns one.
   *
   * IDEMPOTENT BY DESIGN. A thread with five replies must produce one task, not
   * five — a task list that duplicates itself is one nobody trusts. So an
   * existing OPEN follow-up on the same lead wins: its due date is pulled
   * forward if the new email is more urgent, and nothing new is inserted.
   *
   * Best-effort throughout. This runs after the lead is already saved, so a
   * failure here must never turn a captured lead into a 500 and a webhook retry.
   */
  const createFollowUpTask = async (
    db: SupabaseClient,
    leadId: string,
    ownerId: string | null,
    signals: FollowUpInput,
  ): Promise<void> => {
    try {
      const d = decideFollowUp(signals);
      if (!d.create) {
        console.log(`[inbound-email] no follow-up task: ${d.suppressedBy} — ${d.reason}`);
        return;
      }

      const dueAt = new Date(Date.now() + d.dueInHours * 3_600_000).toISOString();

      const { data: open } = await db
        .from("tasks")
        .select("id, due_at")
        .eq("tenant_id", tenantId)
        .eq("lead_id", leadId)
        .eq("status", "pending")
        .order("due_at", { ascending: true })
        .limit(1)
        .maybeSingle();

      if (open) {
        // Only ever pull the date FORWARD. Pushing it back would let a chatty
        // low-signal reply delay a follow-up that was already urgent.
        if (open.due_at && dueAt < open.due_at) {
          await db.from("tasks").update({ due_at: dueAt }).eq("id", open.id);
        }
        return;
      }

      await db.from("tasks").insert({
        tenant_id: tenantId,
        lead_id:   leadId,
        owner_id:  ownerId,          // null lands in the unassigned bucket (0007)
        title:     d.title,
        notes:     d.reason,
        kind:      "followup",
        due_at:    dueAt,
        status:    "pending",
      });
    } catch (e) {
      console.error("[inbound-email] follow-up task failed:", e);
    }
  };

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

  /* ── EVERYTHING THAT HAPPENS ONCE A LEAD ROW EXISTS ───────────────────────────
     Timeline entry, follow-up task, quote, AI reply — in that order, for both branches.
     It was written twice, and the two copies drifted every time something was added:

       23 Aug 2026  the quote block existed on the create branch alone. A reply naming
                    "50 Business Starter on annual billing" corrected the lead and priced
                    nothing.
       31 Aug 2026  the AI product matcher, added the day before for exactly the wording
                    "google workspace starter", was on the create branch alone. `readEnquiryFacts`
                    closed that half; this closes the other.

     Twice the repair was "call it on both branches too", and twice a test was added to count
     the call sites. That is a guard against forgetting, and forgetting was never the real
     problem — having two places to remember was. One list of steps means the next capability
     is added once and reaches both doors by construction.

     The "Reply from X" / "Email from X" timeline line is NOT here, deliberately. It belongs
     beside its own branch's lead write — the append branch files the mail before rewriting
     the lead, the create branch after inserting it — and moving it in here would push it
     BELOW the correction rows it explains ("Seats: (blank) -> 48, from the customer's reply").
     A one-line insert next to the write it describes is not the kind of step that drifts.

     A CLOSURE rather than a module: it reads tenantId, fromEmail, subject, text, rawHeaders,
     ai, extracted, senderIsOurs and selfTest straight from this request's scope. Lifting it
     out would mean threading nine unchanging values through a signature, which is its own way
     of getting one wrong. The two branches differ ONLY in what they pass here. */
  const afterLeadWritten = async (args: {
    leadId: string;
    company: string;
    /** Changes what the follow-up task is told. The timeline line is written by the caller. */
    isReply: boolean;
    ownerId: string | null;
    facts: import("@/lib/inbound/read-enquiry").EnquiryFacts["facts"];
    item: import("@/lib/inbound/read-enquiry").EnquiryFacts["item"];
    /** The seat count to price at — the LEAD's, once corrections have been applied. */
    seats: number | null;
    /** What the sales agent reads. Stripped of the quoted thread by the caller. */
    incoming: string;
    /**
     * Null → draft a quote. A string → do not, and say this on the timeline instead.
     *
     * Only the reply branch ever fills it: `shouldRequoteOnReply` is what stops a
     * five-message thread about the same fifty seats minting five GST documents, and a
     * brand-new lead has nothing to compare against.
     */
    skipQuoteBecause: string | null;
    /** Prefix for the draft's notes — lets a re-quote say why it was raised. */
    notePrefix?: string;
    /**
     * Correct THIS unsent draft instead of taking a new document number.
     *
     * Only the reply branch fills it, and only when `shouldRequoteOnReply` found a draft
     * priced on the other term. See lib/quotes/auto-quote-for-lead.ts.
     */
    repriceDraftId?: string;
  }): Promise<void> => {
    /* `ownerId` null lands in the unassigned bucket, which is what 0007 designed it for —
       a freshly captured email lead belongs to nobody yet. Awaited, and FIRST: it writes no
       mail, so it cannot collide with anything below, and the operator's task should exist
       even if the customer-facing work later fails. */
    await createFollowUpTask(admin, args.leadId, args.ownerId, {
      fromEmail, subject, bodyText: text,
      /* `ai` is null when Gemini did not run. Passing `extracted.isEnquiry` would pass the
         stub's default-true and let an unclassified email create a task on a guess. */
      isEnquiry: ai ? ai.isEnquiry : null,
      summary: extracted.summary,
      headers: rawHeaders,
      isReplyToExistingLead: args.isReply,
    });

    /* ══ ONE ENQUIRY, ONE ANSWER ══════════════════════════════════════════════
       Pardeep sent a screenshot at 17:54 on 31 Aug 2026 — two mails in his inbox for one
       enquiry, and he asked why this keeps coming back:

           Re: mujhe 40 email ke liye quote chahiye google business starter monthly
           Your quote Q-ADPL-2026-27-0107 — ANUTECH DIGITAL PVT LTD        [PDF]

       It was NOT the duplicate-quote defect returning. Only one quotation was raised
       (Q-0107); the guard in `auto-quote-for-lead.ts` held. What produced two mails was
       this block, and specifically the word `void` in front of both calls.

       The quote step and the sales agent were fired as two independent promises. They ran at
       the same time, and neither could see the other:

         · the agent read the lead's latest quote BEFORE the quote existed, so it answered in
           prose — and, having nothing to attach, attached nothing;
         · the quote step then mailed the document under a subject it wrote itself, which
           Gmail filed as a separate thread, because threading in this app comes from the
           subject and nothing else.

       The old comment here claimed the ORDER solved this — "AFTER the quote block, so a
       drafted-and-sent quote is already in the thread". It could not: `void` starts the work
       and moves on, so the order of two `void`s says nothing about which finishes first. A
       comment describing a guarantee the code does not make is worse than no comment.

       ── The fix, and why it is this one ─────────────────────────────────────
       The two steps are now SEQUENCED inside a single `void`, and the agent speaks only when
       the quote step did not write to the customer. `autoQuoteForLead` returns that answer
       rather than `void`, so there is something to branch on.

       Webhook latency is unchanged — still exactly one un-awaited promise, still nothing the
       provider waits on. What changed is that the two halves are now inside it in order,
       which is the only way one can know about the other.

       And when the agent stays quiet, the lead's timeline SAYS SO. A silence with no reason
       is the failure this repo keeps paying for. */
    void (async () => {
      /* ── A CRASH HERE MUST NOT SILENCE THE ANSWER ─────────────────────────
         Sequencing bought one thing and cost another. As two `void` calls, a crash in the
         quote step could not stop the agent — they were independent promises. In a chain it
         can, and then the customer gets NOTHING, which is a worse outcome than the two mails
         this change exists to fix.

         So a throw becomes an outcome like any other refusal: the quotation did not reach
         them, therefore the agent answers. The reason is written on the lead in the same
         sentence shape the planner's own refusals use, so an operator reads one list and not
         two — and `console.error` keeps it in the Cloud Run log, which is where the 13-day
         Contacts outage taught us these have to be. */
      let quote: import("@/lib/quotes/auto-quote-for-lead").AutoQuoteOutcome =
        { emailed: false, reason: args.skipQuoteBecause ?? "the quote step did not run" };

      if (!args.skipQuoteBecause) {
        try {
          quote = await autoQuoteForLead(admin, {
            tenantId,
            leadId:        args.leadId,
            company:       args.company,
            item:          args.item,
            seats:         args.seats,
            term:          args.facts.term.value,
            seatsSource:   args.facts.seats.source,
            productSource: args.facts.product.source,
            termSource:    args.facts.term.source,
            recipient:     fromEmail,
            senderIsOurs,
            isSelfTest:    selfTest,
            fromEmail:     FROM_EMAIL,
            notePrefix:    args.notePrefix,
            repriceDraftId: args.repriceDraftId,
            /* The customer's own subject, so the quotation lands in THEIR thread instead of
               starting a new one. This app has no `In-Reply-To` anywhere — Gmail threads on the
               subject, which is why the standalone "Your quote Q-…" subject broke away. */
            incomingSubject: subject,
          });
        } catch (err) {
          const why = err instanceof Error ? err.message : "unknown error";
          console.error("[inbound-email] auto-quote crashed:", err);
          quote = { emailed: false, reason: `the quote step crashed — ${why}` };
          await admin.from("lead_activities").insert({
            tenant_id: tenantId, lead_id: args.leadId, kind: "note",
            detail:
              `No quote drafted automatically — the quote step crashed (${why}). ` +
              `The customer is still being answered; raise the quotation by hand.`,
          });
        }
      }

      if (args.skipQuoteBecause) {
        await admin.from("lead_activities").insert({
          tenant_id: tenantId, lead_id: args.leadId, kind: "note",
          detail: `No new quote from this reply — ${args.skipQuoteBecause}`,
        });
      }

      if (!agentMaySendSeparateReply(quote)) {
        /* The quotation IS the reply now: same thread, the customer's own subject, the PDF
           attached, and a covering letter that states the seats, the rate, the unit and the
           tax split. A second mail from the agent alongside it would be the app talking over
           itself — which is exactly what the screenshot showed. */
        await admin.from("lead_activities").insert({
          tenant_id: tenantId, lead_id: args.leadId, kind: "note",
          detail:
            `The AI sales agent did not send a separate reply — quotation ${quote.quoteId} ` +
            `was emailed in the customer's own thread, and that is the reply.`,
        });
        return;
      }

      /* No quotation reached them, so they are still owed an answer — a general sales
         question, a missing seat count, a term nobody named. This is the path Pardeep asked
         for on 31 Aug ("koi lead general question poochhe to uska bhi jawab AI de payega"),
         and all seven of `decideAutoReply`'s gates still apply inside it. */
      await runSalesAgentForLead({
        admin,
        tenantId,
        leadId: args.leadId,
        incoming: args.incoming,
        /* The customer's OWN subject, so the reply threads. One line, in one place — which is
           exactly what merging the two branches an hour earlier bought. */
        incomingSubject: subject,
        customerContact: fromEmail,
        channel: "email",
        senderIsOurs,
        isSelfTest: selfTest,
        fromEmail: FROM_EMAIL,
        sellerName: SELLER_NAME,
      }).catch((err) =>
        console.error("[inbound-email] sales agent crashed:", err),
      );
    })().catch((err) => console.error("[inbound-email] answer chain crashed:", err));
  };

  /* ── Who is this from, before deciding what it is ──────────────────────────
     This lookup used to sit BELOW the `isEnquiry` gate, and that ordering was the
     bug reported on 22 Aug 2026 as "message aaya, show nahi ho raha". A mid-thread
     reply — "actually I need 20 users of Standard, not 50 of Starter" — was handed
     to Gemini, asked "is this a sales enquiry?", correctly answered no, and filed as
     `skipped_non_enquiry`, which folders.ts puts under Spam / System. The most
     important message in the thread went to Spam, and nothing on screen said why.

     A message from somebody we are already talking to is never spam: we know who
     they are and what it is about, so there is nothing to classify. The classifier
     is for STRANGERS, which is the only case where the question is open. */
  const { data: existing } = await admin
    .from("leads")
    .select("id, notes, owner_id")
    .eq("tenant_id", tenantId)
    .ilike("contact_email", fromEmail)
    .not("stage", "in", "(won,lost)")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  /* ── Is this our own mail coming back? ────────────────────────────────────
     Every reply on a thread arrives twice: once at the customer-facing address and
     once at the address we send FROM, because that address is in the thread. Those
     echoes used to be filed as spam. On 23 Aug 2026 I made an absent classification
     resolve to `create` so a real first email could not vanish during a Gemini outage
     — and that turned each echo into a NEW LEAD, named from our own domain
     ("anutech", no seats, no plan), sitting in New beside the real one. The operator
     spotted it within the hour.

     Exact addresses, never a domain match: a customer at our own domain is possible
     (a reseller buying for itself), and "anything @anutech.in is ours" would silently
     drop them. */
  const ourAddresses = new Set<string>();
  {
    const add = (v: string | null | undefined) => {
      const s = (v ?? "").trim().toLowerCase();
      if (s.includes("@")) ourAddresses.add(s);
    };
    const { data: t } = await admin
      .from("tenants").select("email").eq("id", tenantId).maybeSingle();
    add((t as { email?: string | null } | null)?.email);

    const { data: staff } = await admin
      .from("users").select("id, email").eq("tenant_id", tenantId);
    const staffRows = (staff ?? []) as { id: string; email?: string | null }[];
    for (const u of staffRows) add(u.email);

    /* The connected Google account is the one replies actually leave from, and it need
       not equal any users.email — that is the point of the "Send as" picker.

       Scoped to THIS tenant's user ids. `user_google_tokens` has no tenant_id column,
       so an unfiltered read here would pull every tenant's connected address into
       `ourAddresses` — and then a genuine enquiry from another reseller's sending
       address would be silently dropped as "ours". This runs under the admin client,
       so there is no RLS to catch that; the filter IS the boundary. */
    const staffIds = staffRows.map((u) => u.id).filter(Boolean);
    if (staffIds.length > 0) {
      const { data: senders } = await admin
        .from("user_google_tokens").select("google_email").in("user_id", staffIds);
      for (const g of (senders ?? []) as { google_email?: string | null }[]) add(g.google_email);
    }
  }
  const senderIsOurs = ourAddresses.has(fromEmail.trim().toLowerCase());

  /* The operator testing the pipeline from their own address. Deliberate, and it has to say
     so in the subject — lib/inbound/self-test.ts explains why an address cannot carry
     intent and what accident each rule there is refusing. Unmarked mail from our own
     addresses skips exactly as it did before this existed. */
  const selfTest = isSelfTest({ senderIsOurs, subject });

  /* ── Purani baatcheet ka jawab, ya naya sauda? ────────────────────────────
     26 Aug 2026, Pardeep: "ek email id se to customer mujhse kai baar quote maang sakta
     hai, kai reseller aise hain jo apne multiple clients ke liye quote maangte hain".

     Uske pehle neeche wali `openLeadId` shakha bina shart chalti thi, to ek email id se
     doosra sauda shuru karna namumkin tha. Niyam ab lib/inbound/thread-match.ts me hai.

     Ye query SIRF tab chalti hai jab koi khuli lead mili ho — warna ek bemaani round-trip
     har ajnabi ke mail par lagta. */
  let leadSubjects: string[] = [];
  if (existing?.id) {
    const { data: prior } = await admin
      .from("inbound_emails")
      .select("subject")
      .eq("tenant_id", tenantId)
      .eq("lead_id", existing.id)
      .order("created_at", { ascending: false })
      .limit(25);
    leadSubjects = ((prior ?? []) as { subject?: string | null }[])
      .map((r) => r.subject ?? "")
      .filter(Boolean);
  }
  const continuesOpenLead = existing?.id
    ? continuesThread({ inReplyTo, references, subject, leadSubjects })
    : undefined;

  const disposition = decideDisposition({
    senderIsOurs,
    isSelfTest: selfTest,
    openLeadId: existing?.id ?? null,
    continuesOpenLead,
    /* `ai` is null when Gemini did not run. Passing extracted.isEnquiry here would
       pass the webhook's default-TRUE fallback and hide that distinction — and the
       difference between "the model said no" and "the model never answered" is the
       difference between spam and an untriaged customer email. */
    isEnquiry: ai ? ai.isEnquiry : null,
  });

  if (disposition.action === "skip") {
    console.info(`[webhooks/inbound-email] skipping ${fromEmail}: ${disposition.reason}`);
    /* Deliberate but malformed, named separately from the accidents. Measured 23 Aug 2026: a
       forwarded self-test arrived as "Fwd: [selftest] …" and the log said only "sent from one
       of our own addresses" — true, and silent about the fact that a marker had been typed at
       all. Tracing that cost a five-minute poll and a round trip.

       Diagnostic only; the refusal itself is unchanged and stays unchanged, because relaxing
       the position rule would let our own AI-written "Re: [selftest] …" reply back in and
       close a loop. See lib/inbound/self-test.ts. */
    if (selfTestMarkerMisplaced(subject)) {
      console.warn(
        `[webhooks/inbound-email] NOTE: "${SELF_TEST_MARKER}" is in this subject but not at the ` +
        `START, so it does not count as a self-test. Compose a new mail beginning with the ` +
        `marker rather than forwarding or replying to one. Subject was: ${subject}`,
      );
    }
    await finalize("skipped_non_enquiry", null);
    return NextResponse.json({ received: true, skipped: "non_enquiry", reason: disposition.reason });
  }

  const company = extracted.company || fromName || (fromEmail.split("@")[1]?.split(".")[0]) || "Email lead";
  const note    = [
    `Inbound email lead (auto-captured).`,
    `From: ${fromName ? `${fromName} ` : ""}<${fromEmail}>`,
    subject ? `Subject: ${subject}` : null,
    extracted.summary ? `Summary: ${extracted.summary}` : null,
    text ? `\n--- original ---\n${text.slice(0, 1000)}` : null,
  ].filter(Boolean).join("\n");

  // ── 5. Append to the open lead this sender already has ────────────────────
  //     The lookup itself moved above the classifier gate — see the comment there.
  if (disposition.action === "append" && existing) {
    await admin.from("leads").update({
      notes: `${existing.notes ? existing.notes + "\n\n" : ""}[New email ${new Date().toISOString().slice(0, 10)}] ${subject || extracted.summary}`,
    }).eq("id", existing.id);
    // Log on the lead's activity timeline (visible in the drawer).
    await admin.from("lead_activities").insert({
      tenant_id: tenantId, lead_id: existing.id, kind: "email_in",
      detail: `Reply from ${fromEmail}${subject ? ` · ${subject}` : ""}`,
    });

    /* ── PHASE 1: write the customer's correction INTO the lead ──────────────
       Three attempts at fixing the reply DRAFT all missed the point: after a
       customer said twice that they wanted 20 users of Standard rather than 50 of
       Starter, `leads.seats` still read 50 and `leads.plan` still read Starter.
       While that is true, every quote, draft and renewal derived from the row is
       wrong too. So the record moves, and the reply is then correct because the
       facts are.

       No model is involved. lib/inbound/extract.ts reads seats and product with
       tested regexes and returns the sentence each value came from, so nothing can
       be invented and the audit trail is free. The quoted thread is stripped FIRST:
       a reply carries our own previous message underneath, containing the very
       numbers being corrected. Reading the raw body would overwrite 20 with 50 and
       cite the customer as the source. */
    const fresh = stripQuoted(text);
    /* msrp and wholesale added 23 Aug 2026: this branch now prices a quote as well as
       correcting the lead, and it used to select only id+name because correcting was all it
       did. `extractEntities` ignores the extra columns. */
    const { data: leadFacts } = await admin
      .from("leads")
      .select("seats, plan")
      .eq("id", existing.id)
      .eq("tenant_id", tenantId)
      .maybeSingle();

    /* ── THE BRANCH THAT KEPT BEING FORGOTTEN ─────────────────────────────────
       31 Aug 2026, a real reply: "mujhe 48 email id google workspace starter ke liye qutoe
       chahiye monthly par". Seats, product and term, all three. The app answered with a
       price, promised a quotation — and drafted nothing, because `findProduct` wants the
       whole catalogue name ("Google Workspace BUSINESS Starter") and the AI fallback that
       exists for exactly this wording was wired into the CREATE branch only.

       Both branches now read the mail through `readEnquiryFacts`, so there is one place to
       add the next capability instead of two — and resolving BEFORE `planCorrections` makes
       the rest of the chain agree: the correction writes the CATALOGUE's own name onto the
       lead, `shouldRequoteOnReply` then sees a product, and the draft is priced from that
       row.

       NO `|| text` here, unlike the create branch: what sits under a reply's quote line is
       our own earlier message, carrying the very numbers being corrected. */
    const { catalogue: priced, facts: replyFacts, item: replyItem } =
      await readEnquiryFacts(admin, {
        tenantId, fromName, fromEmail, subject,
        body: fresh.text,
        bodyWithSubject: withSubject(fresh.text),
        gemini,
      });

    const plan = planCorrections({
      current: {
        seats: (leadFacts as { seats?: number | null } | null)?.seats ?? null,
        plan:  (leadFacts as { plan?: string | null } | null)?.plan ?? null,
      },
      freshText: fresh.text,
      extracted: replyFacts,
    });

    if (plan.corrections.length > 0) {
      const patch: { seats?: number; plan?: string } = {};
      for (const c of plan.corrections) {
        if (c.field === "seats") patch.seats = c.value as number;
        if (c.field === "plan")  patch.plan  = c.value as string;
      }
      const { error: corrErr } = await admin
        .from("leads")
        .update(patch)
        .eq("id", existing.id)
        .eq("tenant_id", tenantId);

      if (corrErr) {
        /* The email is still filed and the reply still readable — only the record
           did not move. Said out loud rather than swallowed, because a correction
           that silently failed to apply is the state this whole change exists to
           remove. */
        console.error(`[webhooks/inbound-email] lead ${existing.id}: correction failed to apply: ${corrErr.message}`);
      } else {
        /* One row per field, each quoting the customer's own sentence. One combined
           row would make a single change impossible to undo on its own — and "says
           who?" is the first question anybody asks of an automated write. */
        await admin.from("lead_activities").insert(
          plan.corrections.map((c) => ({
            tenant_id: tenantId,
            lead_id: existing.id,
            kind: "correction_in",
            detail: correctionDetail(c),
          })),
        );
        console.info(
          `[webhooks/inbound-email] lead ${existing.id}: applied ${plan.corrections.length} correction(s) — ` +
          plan.corrections.map((c) => `${c.field} ${c.from ?? "(blank)"}->${c.to}`).join(", "),
        );
      }
    } else if (fresh.text.trim()) {
      /* Nothing to change is the common case and must not fill the log. Recorded at
         debug volume only, with the reasons, so "why didn't it update?" has an
         answer without a database query — the gap that made the Spam misfiling take
         one to diagnose. */
      console.info(
         `[webhooks/inbound-email] lead ${existing.id}: no correction — ` +
         plan.skipped.map((s) => `${s.field}: ${s.reason}`).join("; "),
      );
    }
    await finalize("appended_to_lead", existing.id);

    /* ── RE-QUOTE, when the reply changed what they asked for ─────────────────
       THE BUG THE 23 AUG SELF-TEST FOUND, and it was mine. A mail asking for "50 Google
       Workspace Business Starter users on annual billing" landed here, the extractor rewrote
       the lead (seats 20 -> 50, plan Standard -> Starter), and nothing priced it — because
       the quote block lived on the CREATE branch alone.

       `shouldRequoteOnReply` is asked FIRST and mostly says no. Without it a five-message
       thread about the same fifty seats would mint five GST documents, each taking an
       irreversible number from the gapless Rule 46 series. It is the ONE step that belongs
       to this branch alone — a brand-new lead has no earlier quote to compare against —
       which is why it is a decision passed INTO the shared steps rather than a second copy
       of them.

       The facts come from the lead AFTER the corrections above were applied: the reply's own
       numbers when it changed them, the stored ones when it did not. */
    const { data: freshLead } = await admin
      .from("leads")
      .select("company, seats, plan")
      .eq("id", existing.id)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    const lf = (freshLead ?? {}) as { company?: string | null; seats?: number | null; plan?: string | null };

    const { data: lastQuote } = await admin
      .from("quotes")
      .select("id, status, seats, plan, billing_cycle")
      .eq("lead_id", existing.id)
      .eq("tenant_id", tenantId)
      .order("created_date", { ascending: false })
      .limit(1)
      .maybeSingle();

    /* The reply's OWN product wins when it named one, and only then does the lead's stored
       plan get used. Reading `lf.plan` alone was the second half of the 31 Aug bug: an exact
       string compare against whatever earlier free text was saved — on that lead "Google
       Workspace", which matches no catalogue row and never would. */
    const matched = replyItem ?? priced.find((c) => c.name === lf.plan) ?? null;
    const lq = lastQuote as
      { id: string; status: string | null; seats: number | null; plan: string | null;
        billing_cycle: string | null } | null;
    const decision = shouldRequoteOnReply({
      seats:       lf.seats ?? null,
      productName: matched?.name ?? null,
      /* The term the customer has NOW stated. Without it a reply saying "monthly" read as
         "nothing changed", and an unsent draft priced on the assumed annual term sat there
         for ever — see requote-on-reply.ts. */
      term:        replyFacts.term.value,
      latestQuote: lq
        ? { id: lq.id, status: lq.status, seats: lq.seats, plan: lq.plan,
            billingCycle: lq.billing_cycle }
        : null,
    });

    await afterLeadWritten({
      leadId:  existing.id,
      company: lf.company ?? "Customer",
      isReply: true,
      ownerId: existing.owner_id ?? null,
      facts:   replyFacts,
      item:    matched,
      /* The LEAD's seat count, not the reply's: a reply that changes only the product must
         still price the seats the customer gave earlier. */
      seats:   lf.seats ?? null,
      incoming: withSubject(fresh.text || text),
      skipQuoteBecause: decision.requote ? null : decision.reason,
      /* Set only when the existing document is an unsent draft priced on the other term. Then
         the same number gets the right price, instead of a second number being burned and the
         reference already given to the customer going stale. */
      repriceDraftId: decision.repriceDraftId,
      notePrefix: decision.requote
        ? `Re-quoted from a customer reply — ${decision.reason}.`
        : undefined,
    });

    return NextResponse.json({ received: true, appendedToLead: existing.id });
  }

  // ── 6. Create the lead ─────────────────────────────────────────────────
  /* SEATS AND THE CATALOGUE PRODUCT, read here for the first time on this path.
     Traced 23 Aug 2026: `extracted` on this branch is the GEMINI result (`ExtractedLead`),
     and that shape has no `seats` field at all — so a new email lead has always been saved
     without a seat count, however plainly the mail stated one. The regex extractor that
     DOES read seats (`extractEntities`) was only ever run on the append branch below, for
     the Phase 1 correction write-back.

     That was the real break behind "50 Business Starter ka quote email par aa jayega?" —
     not the wording of the mail. Running it here costs one query and no AI call, and it is
     deterministic, which the model's answer is not.

     `stripQuoted` first, for the same reason the append path does it: a reply carries our
     own earlier numbers underneath, and reading THOSE would quote yesterday's figure. */
  /* `|| text` is this branch's own answer and does not belong in the shared reader: a
     forwarded enquiry is often quoted in its entirety, and stripping it would leave nothing
     to read. The reply branch must NOT do that — there, what sits under the quote line is
     our own earlier message, carrying the very numbers being corrected. */
  const freshForFacts = stripQuoted(text).text || text;
  const { facts, item: matchedItem } = await readEnquiryFacts(admin, {
    tenantId, fromName, fromEmail, subject,
    body: freshForFacts,
    /* Wahi matn jo baaki sab padhte hain — subject samet, kyunki asli maang aksar wahin
       hoti hai (dekho `withSubject` ka comment). */
    bodyWithSubject: withSubject(freshForFacts),
    gemini,
  });

  const leadId = "L-" + Date.now().toString(36).toUpperCase();
  const { error: leadErr } = await admin.from("leads").insert({
    id:            leadId,
    tenant_id:     tenantId,
    company,
    contact_name:  extracted.contactName || null,
    contact_email: fromEmail,
    contact_phone: extracted.phone || null,
    /* The catalogue's own name when the regex matched one, because that string is what the
       quote builder and `samePlan` compare against. Gemini's free-text guess stays as the
       fallback — it is better than nothing when the mail named a product we do not sell. */
    plan:          matchedItem?.name || extracted.product || null,
    seats:         facts.seats.value,
    stage:         "new",
    /* Marked at source, not only in the notes. A self-test produces a real lead in the
       pipeline — it counts in the board, in stage-age and in the forecast until somebody
       deletes it — so it has to be FINDABLE by a query, not by reading prose. Anything
       reporting on real demand can exclude this value; nothing does yet, which is worth
       knowing rather than assuming. */
    source:        selfTest ? "email-selftest" : "email-inbound",
    priority:      "medium",
    /* The self-test banner goes FIRST in the notes, above the captured mail. Whoever opens
       this lead in a week must know it is scaffolding before they read anything that looks
       like demand — and must know that deleting the lead does NOT give the quote's document
       number back, because the CGST Rule 46 series is gapless by design. */
    notes: selfTest
      ? `⚠ SELF-TEST LEAD — created deliberately from our own address (${fromEmail}) to ` +
        `exercise the enquiry→quote→email path. Safe to delete. NOTE: if a quote was drafted ` +
        `for it, that quote consumed a real document number from the gapless GST series and ` +
        `deleting the lead does not return it.\n\n${note}`
      : note,
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
  await afterLeadWritten({
    leadId,
    company,
    isReply: false,
    /* Nobody owns a freshly captured email lead yet. */
    ownerId: null,
    facts,
    item: matchedItem,
    seats: facts.seats.value,
    incoming: withSubject(freshForFacts),
    /* A brand-new lead has no earlier quote to compare against, so there is nothing to
       refuse — `shouldRequoteOnReply` only makes sense on the reply branch. */
    skipQuoteBecause: null,
  });

  // ── 7. Notify the reseller owner (best-effort) ─────────────────────────
  const { data: tenant } = await admin.from("tenants").select("email, name").eq("id", tenantId).maybeSingle();
  const ownerEmail = tenant?.email?.trim();
  if (ownerEmail) {
    void sendInternalEmail({
      /* Bina `route` ke ye default Resend par jata hai (send.ts:26), aur wo test mode
            me hai. Tenant ne Gmail chuna hai to mail wahi se jaye. */
      route: { tenantId: tenantId },
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
