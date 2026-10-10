/**
 * Emails an auto-drafted quote to the person who asked for it.
 *
 * ─── WHY THIS IS NOT `POST /api/quotes/[id]/send` ───────────────────────────
 * That route is the OPERATOR's send: it authenticates a session, resolves `me.tenant_id`
 * from it, accepts a custom message and cc list, and reads a CUSTOMER record for the GST
 * place-of-supply. The inbound webhook has none of those — no session, no cc, and no
 * customer at all, because an auto-drafted quote belongs to a lead (`customer_id` is null).
 *
 * Refactoring that 265-line route to serve both was considered and rejected on 23 Aug 2026
 * for one measured reason: it has no tests. `send-consequences.test.ts` covers a pure
 * helper beside it, nothing covers the route itself, and extracting the send stack out of
 * an untested money path is how a working feature breaks quietly. So this is a narrower
 * sender, and the narrowing is listed rather than left to be discovered:
 *
 *   - no cc, no custom message — nobody is present to write one
 *   - no UPI QR. `buildQuoteUpiQr` is worth having and is the first thing to add here, but
 *     a missing QR costs a scan-to-pay convenience, while a wrong one costs a payment
 *   - GST head is the tenant's default, because there is no customer state to compare
 *     against. Identical to what the operator route computes for a lead-quote, where
 *     `customer?.state_code` is likewise undefined — so this is the same answer, not a
 *     different one
 *
 * The DECISION to send at all is not here — see lib/quotes/auto-send-quote.ts. This runs
 * only after that said yes.
 *
 * ─── IT RECORDS EVERYTHING, INCLUDING ITS OWN FAILURES ──────────────────────
 * `quote_send_log` gets a row whatever happens, and the lead's timeline gets a line either
 * way. An automated send that fails silently is worse than one that never ran: the operator
 * sees "quote sent" in the pipeline and stops chasing.
 */
import { sendEmail } from "@/lib/email/send";
import { replyToAddress } from "@/lib/email/reply-to";
import { renderQuotePDF } from "@/lib/pdf";
import { logoDataUri } from "@/lib/pdf/logo";
import { rupee } from "@/lib/utils";
import { quoteEmailBody } from "@/lib/email/quote-body";
import { replySubject } from "@/lib/email/reply-subject";
import { stageAfterQuoteSent } from "@/lib/leads/stage-after-quote-sent";
import type { createAdminClient } from "@/lib/supabase/server";
import type { QuoteLineItem } from "@/lib/supabase/database.types";
import { quoteDisplayTax } from "@/lib/quotes/quote-tax";

export interface SendAutoQuoteArgs {
  tenantId: string;
  quoteId: string;
  leadId: string;
  /** Where the enquiry came from. Already validated by decideAutoSend. */
  recipient: string;
  /** Envelope sender for the deployment. */
  fromEmail: string;
  /**
   * The subject line the CUSTOMER used, so this mail lands in their own thread.
   *
   * ─── WHY IT MATTERS, FROM THE SCREENSHOT ─────────────────────────────────
   * 31 Aug 2026, 17:54 — Pardeep's inbox held TWO mails for one enquiry:
   *
   *     Re: mujhe 40 email ke liye quote chahiye google business starter monthly
   *     Your quote Q-ADPL-2026-27-0107 — ANUTECH DIGITAL PVT LTD        [PDF]
   *
   * The first is the sales agent's reply, in the thread. The second is this mail, and
   * because its subject was written from scratch it started a SEPARATE thread — so one
   * enquiry got two answers in two places, and the one carrying the document looked like
   * an unrelated mail.
   *
   * There is no `In-Reply-To` anywhere in this app: threading here is done by Gmail, from
   * the subject and the participants. So the subject IS the threading mechanism, and
   * `replySubject` is the same helper the reply path already uses.
   *
   * Null falls back to the old standalone subject rather than sending nothing — a cron-driven
   * renewal quote has no incoming mail to reply to, and that case is not a defect.
   */
  incomingSubject?: string | null;
}

/* Typed as the RETURN of createAdminClient rather than as a hand-rolled structural type.
   Writing the shape out by hand is what produced the TS2589 "excessively deep" failure in
   lib/email/owner-alert.ts — the fix there was exactly this, and it is cheaper to copy the
   fix than to rediscover it. */
type Admin = ReturnType<typeof createAdminClient>;

interface QuoteRow {
  id: string;
  customer_name: string | null;
  line_items: unknown;
  subtotal: number | null;
  discount_pct: number | null;
  tax_rate: number | null;
  amount: number | null;
  /* Chitthi ki "Dated" line. Typecheck ne ise pakda — aur ye do galtiyan ek saath thi:
     type me column nahi tha, AUR neeche ke `select` me bhi nahi tha. Sirf type theek
     karne se value `undefined` aati aur chitthi chup chaap bina date ke jati. */
  created_date: string | null;
  expires_date: string | null;
  notes: string | null;
  is_renewal: boolean | null;
  status: string | null;
  billing_cycle: string | null;
}

interface TenantRow {
  name: string | null;
  email: string | null;
  phone: string | null;
  gstin: string | null;
  address: string | null;
  logo_url: string | null;
}

/**
 * Did the customer actually receive a mail from this call?
 *
 * Returned rather than swallowed because the caller has to decide whether anything ELSE may
 * write to this customer — see `lib/inbound/ingest.ts`. A boolean that nobody returned is
 * how one enquiry came to get two answers.
 */
export type SendAutoQuoteResult = "sent" | "failed";

export async function sendAutoQuote(
  admin: Admin,
  args: SendAutoQuoteArgs,
): Promise<SendAutoQuoteResult> {
  const note = async (detail: string) => {
    await admin.from("lead_activities").insert({
      tenant_id: args.tenantId, lead_id: args.leadId, kind: "note", detail,
    });
  };

  const { data: q } = await admin
    .from("quotes")
    .select("id, customer_name, line_items, subtotal, discount_pct, tax_rate, amount, created_date, expires_date, notes, is_renewal, status, billing_cycle")
    .eq("id", args.quoteId)
    .eq("tenant_id", args.tenantId)
    .maybeSingle();
  const quote = q as QuoteRow | null;

  if (!quote) {
    await note(`Quote ${args.quoteId} could not be re-read before sending — nothing was sent.`);
    return "failed";
  }
  /* Re-read and re-checked rather than trusted from the caller. Between drafting and here
     the row could have been sent by hand; sending twice is a worse outcome than not
     sending, because the customer gets two prices and has to ask which one counts. */
  if (quote.status !== "draft") {
    await note(`Quote ${args.quoteId} was already ${quote.status} — not sent again.`);
    return "failed";
  }

  const { data: t } = await admin
    .from("tenants").select("name, email, phone, gstin, address, state, logo_url")
    .eq("id", args.tenantId).maybeSingle();
  const tenant = (t ?? {}) as TenantRow;

  /* The mailbox the app READS. Reply-To has to be this, not the owner's address — see
     lib/email/reply-to.ts for the reply that disappeared because it was not. */
  const { data: ingestBoxes } = await admin
    .from("user_google_tokens")
    .select("google_email")
    .eq("tenant_id", args.tenantId);

  const lineItems = (Array.isArray(quote.line_items) ? quote.line_items : []) as QuoteLineItem[];
  const subtotal    = quote.subtotal ?? 0;
  const discountPct = quote.discount_pct ?? 0;
  const discount    = Math.round(subtotal * (discountPct / 100));
  const taxable     = subtotal - discount;
  const taxRate     = quote.tax_rate ?? 18;
  const tax         = quoteDisplayTax(taxable, taxRate, quote.amount); // R-804
  /* The STORED total, not a recompute. quote.amount is what the draft committed to and what
     the operator would see in the app — a PDF that disagrees with the row by a rupee is a
     conversation nobody wants to have with a customer. */
  const total = quote.amount ?? taxable + tax;

  let attachments: { filename: string; content: Buffer; contentType: string }[] | undefined;
  try {
    const blob = await renderQuotePDF({
      upiQrDataUrl:  null,
      upiVpa:        null,
      tenantName:    tenant.name ?? "",
      tenantGstin:   tenant.gstin,
      tenantEmail:   tenant.email,
      tenantPhone:   tenant.phone,
      tenantAddress: tenant.address,
      /* This is the quote the AI sends on its own, so it is the one a customer is most likely
         to see first. Resolved here rather than in the renderer: `logoDataUri` has a deadline
         and returns null on every failure, so a logo can cost the monogram but never the
         send — and this whole block already sits inside a try that degrades to no PDF. */
      tenantLogo:    await logoDataUri(tenant.logo_url),
      quoteId:       quote.id,
      customerName:  quote.customer_name ?? "",
      contactName:   null,
      contactEmail:  args.recipient,
      contactPhone:  null,
      lineItems,
      subtotal,
      discountPct,
      discount,
      taxable,
      taxRate,
      tax,
      total,
      /* No customer record on a lead-quote, so there is no buyer state to compare — the
         tenant's own default applies, exactly as it does on the operator route when
         `customer?.state_code` is undefined. */
      interState:    false,
      validityDays:  30,
      notes:         quote.notes ?? undefined,
      isRenewal:     quote.is_renewal ?? false,
    });
    attachments = [{
      filename:    `Quote-${quote.id}.pdf`,
      content:     Buffer.from(await blob.arrayBuffer()),
      contentType: "application/pdf",
    }];
  } catch (pdfErr) {
    /* Non-fatal, same as the operator route: the mail still carries the figure and the
       link. Logged, and said out loud on the lead, because "the customer got a quote with
       no PDF" is something the person chasing it needs to know. */
    console.warn(`[send-auto-quote] PDF render failed for ${quote.id}:`, (pdfErr as Error).message);
  }

  const seller  = tenant.name?.trim() || "Your reseller";

  /* ── EK ENQUIRY, EK JAWAB ────────────────────────────────────────────────────
     Grahak ke apne subject par `Re:` — isliye ye mail unke usi thread me girta hai aur
     WAHI jawab ban jata hai, ek doosra mail nahi. Bina incoming subject (renewal cron)
     purana standalone subject hi chalta hai. */
  const subject = replySubject(args.incomingSubject, `Your quote ${quote.id} — ${seller}`);
  /* `tenants.state` is select me nahi tha — ise jodna PDF ke place-of-supply se mel
     khata hai. Null ho to wo line chhoot jati hai, galat nahi chhapti. */
  const tenantState = (tenant as { state?: string | null }).state ?? null;


  const result = await sendEmail({
    to:      args.recipient,
    from:    args.fromEmail,
    /* ── THE MAILBOX THE APP READS, not simply "a person" ────────────────────
       This said `tenant.email` until 31 Aug 2026, with the reasoning "a customer answering
       this must reach a person". True while mail left through Resend as onboarding@resend.dev,
       which nobody can answer. False once the app began sending from AND reading the tenant's
       own Gmail: at 14:32 a real reply to a quote went to pardeep@anutech.in, the connector
       reads sales@anutech.in, and `inbound_emails` recorded nothing at all. A conversation
       left the pipeline and no log said so. */
    replyTo: replyToAddress(ingestBoxes, tenant.email),
    kind:    "auto_quote_from_email",
    route:   { tenantId: args.tenantId },
    /* Gated by the workspace kill switch + dial. This is the newest automated send in the
       app and the one carrying a price, so it is the last thing that should be exempt —
       `decideAutoSend` already checked the FACTS (did the customer state a term), and this
       checks the PERMISSION. Two different questions, both required. */
    automated: { tenantId: args.tenantId, action: "quote.send" },
    subject,
    text:
quoteEmailBody({
      quoteId:      quote.id,
      customerName: quote.customer_name,
      /* Supplier ki poori pehchan — GSTIN, address, state. Ek GST document ki chitthi me ye
         hona chahiye; padhne wale ko PDF kholna na pade ki bech kaun raha hai aur kis tax
         head par. */
      supplier: {
        name:    seller,
        gstin:   tenant.gstin,
        address: tenant.address,
        state:   tenantState,
        email:   tenant.email,
        phone:   tenant.phone,
      },
      lineItems,
      billingCycle: quote.billing_cycle,
      subtotal, discountPct, discount, taxRate, tax, total,
      /* Lead-quote par customer ka record nahi hota, to place of supply tenant ka apna hai —
         wahi jawab jo PDF me jata hai. */
      interState:   false,
      createdDate:  quote.created_date,
      expiresDate:  quote.expires_date,
      /* ── VAADE, TATHYA NAHI ─────────────────────────────────────────────────
         Ye chaar cheezein tenant ki apni shartein hain, template ki nahi. Isi wajah se ye
         parameter hain: "free migration" jaisa vaada ye repo model ko gadhne nahi deta, to
         template ko bhi nahi dena chahiye. Doosre reseller ki shartein alag hongi, aur tab ye
         yahan se badalni hain — chitthi ke andar se nahi. */
      terms: {
        payment:      "100% in advance against our GST tax invoice",
        provisioning: "Accounts are provisioned within one working day of payment confirmation",
        migration:    "Existing mail and data are migrated at no extra charge",
      },
    }),
    attachments,
  });

  /* ── THE TWO WRITES BELOW ARE CHECKED NOW, AND WERE NOT ────────────────────
     Measured on the live run of 23 Aug 2026, and this file's own header promised the
     opposite: "quote_send_log gets a row whatever happens".

       email_log            → status "sent", provider gmail   (the mail really went)
       quote_send_log       → EMPTY
       quotes.status        → still "draft"
       lead_activities      → "Quote Q-…-0042 emailed automatically … (PDF attached)"

     All four at once, because the two middle writes were `await admin.from(...)` with the
     `{ error }` never read, and supabase-js does not throw — it hands back an error object
     nobody looked at. So the function sailed past both and wrote a success line. The
     pipeline shows a quote as unsent while the customer holds it, which is the exact
     failure the comment underneath claimed to prevent.

     Note what the DB says about it: both statements succeed when run by hand inside a
     rollback, so the cause is at the client and not a constraint. That is precisely why
     these are now REPORTED rather than diagnosed — an unchecked write hides its own reason,
     and the next run will name it instead of us guessing. */
  const { error: sendLogErr } = await admin.from("quote_send_log").insert({
    tenant_id:       args.tenantId,
    quote_id:        quote.id,
    recipient_email: args.recipient,
    cc_emails:       null,
    subject,
    status:          result.status,
  });
  if (sendLogErr) {
    /* Not fatal — the mail has already gone and `email_log` records that. But an audit trail
       with a hole in it must announce the hole, or the next person reconciling sends will
       conclude the quote was never sent. */
    console.error("[send-auto-quote] quote_send_log insert failed:", sendLogErr);
    await note(
      `Quote ${quote.id} WAS emailed to ${args.recipient}, but the send could not be written ` +
      `to the audit log — ${sendLogErr.message}. The email itself is recorded in email_log.`,
    );
  }

  if (result.status === "failed") {
    await note(
      `Quote ${quote.id} could NOT be emailed to ${args.recipient} — ${result.errorMessage ?? "send failed"}. ` +
      `The draft is saved; send it by hand.`,
    );
    return "failed";
  }

  /* Status moves only on a real send. A quote marked sent that never left would make the
     pipeline lie and stop somebody chasing it — and the inverse, which is what happened,
     leaves a sent quote sitting in the pipeline as a draft somebody will send again.

     `select("id")` so the response carries the rows it touched: an update matching NOTHING
     is a success in supabase-js, and "matched nothing" is indistinguishable from "worked"
     without asking. */
  const { data: updated, error: statusErr } = await admin
    .from("quotes")
    .update({ status: "sent" })
    .eq("id", quote.id)
    .eq("tenant_id", args.tenantId)
    .select("id");

  if (statusErr || (updated ?? []).length === 0) {
    console.error(
      `[send-auto-quote] could not mark ${quote.id} as sent:`,
      statusErr ?? "update matched no rows",
    );
    await note(
      `Quote ${quote.id} was emailed to ${args.recipient}, but it is still marked DRAFT — ` +
      `${statusErr?.message ?? "the status update matched no rows"}. Mark it sent by hand so ` +
      `nobody sends it twice.`,
    );
  }

  await admin.from("lead_activities").insert({
    tenant_id: args.tenantId, lead_id: args.leadId, kind: "email_out",
    detail:
      `Quote ${quote.id} emailed automatically to ${args.recipient} — ${rupee(total)}` +
      `${attachments ? " (PDF attached)" : " (PDF failed to render; figures in the body)"}. ` +
      `Term was stated in their mail.`,
  });

  /* ── AND MOVE THE LEAD INTO "Quote Sent" ───────────────────────────────────
     Wired here AND in api/quotes/[id]/send in the same edit, deliberately. Two of today's
     bugs were exactly this shape — a rule applied to one of its call sites and not the
     others (L75: the auto-quote wired to one webhook branch; L97: the self-test flag reaching
     two gates of three). Darshan's report is the third, and it is the same disease at the
     data layer: only the public buy-page checkout ever set `stage = "quote"`.

     Forward only. stageAfterQuoteSent refuses to drag a Won or Lost lead backwards, and its
     reason is logged either way so a lead that did NOT move is explicable. */
  const { data: leadRow } = await admin
    .from("leads")
    .select("stage")
    .eq("id", args.leadId)
    .eq("tenant_id", args.tenantId)
    .maybeSingle();

  const move = stageAfterQuoteSent((leadRow as { stage?: string | null } | null)?.stage);
  if (move.nextStage) {
    const { error: stageErr } = await admin
      .from("leads")
      .update({ stage: move.nextStage })
      .eq("id", args.leadId)
      .eq("tenant_id", args.tenantId);
    if (stageErr) {
      console.error(`[send-auto-quote] could not move lead ${args.leadId} to Quote Sent:`, stageErr);
      await note(`Quote ${quote.id} was sent but the lead did not move to Quote Sent — ${stageErr.message}. Move it by hand so the board is right.`);
    } else {
      await admin.from("lead_activities").insert({
        tenant_id: args.tenantId, lead_id: args.leadId, kind: "stage",
        detail: `Moved to Quote Sent — ${quote.id} was emailed to ${args.recipient}.`,
      });
    }
  } else {
    console.info(`[send-auto-quote] lead ${args.leadId} stage unchanged — ${move.reason}`);
  }

  /* Mail ja chuki hai. Uske baad ki har nakaami (audit log, stage) ke apne note hain aur wo
     "customer ko kuch nahi mila" nahi banati — isliye "sent". Ye nateeja hi tay karta hai ki
     sales agent chup rahega ya nahi. */
  return "sent";
}
