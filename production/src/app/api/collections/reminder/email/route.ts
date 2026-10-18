/**
 * POST /api/collections/reminder/email — R-1518: a PERSON pressed "Send email" on a payment
 * reminder they read and edited. Sends it to the customer's billing email, then logs the
 * follow-up (kind email, note = the message's first line, next follow-up date required).
 *
 *   • Sent only through lib/messaging's sendCustomerEmail (messaging-chokepoint.test.ts): the
 *     company's "Customer messages" switch still applies, and email_log records it.
 *   • The body carries NO recipient. The address is the customer's primary contact (legacy
 *     contact_email as the floor), read here on the caller's session — so this cannot be used
 *     to mail anyone else in the company's name (same posture as api/leads/[id]/email).
 *   • Validated BEFORE sending: a missing next follow-up date is refused with nothing sent.
 *   • Logged only when the email really left (status "sent"). Refused / not configured → an
 *     error saying so, nothing logged, so pressing Send again cannot double-log. If the email
 *     left but the log failed, the answer says exactly that (the customer has the mail; the
 *     person logs it with Follow-up) — never a second send.
 *   • R-1544: ONE email per press of Send. The dialog sends a requestId; it is claimed in
 *     customer_email_sends BEFORE the send (lib/collections/email-send-once.server.ts), so a
 *     timeout + retry answers "already sent" (or 409 while the first is still going) instead
 *     of mailing the customer again. The linked invoice / quote / subscription must be THIS
 *     customer's (assertFollowupLinks) — checked before anything is sent.
 */
import { z } from "zod";
import { withRoute, RouteError } from "@/lib/api/with-route";
import { sendCustomerEmail } from "@/lib/messaging";
import { primaryContactEmail } from "@/lib/contacts/primary";
import { followupRequestSchema, NEXT_REQUIRED } from "@/lib/collections/followup-rules";
import { assertFollowupLinks, logFollowup } from "@/lib/collections/followup-log.server";
import { claimEmailSend, settleEmailSend } from "@/lib/collections/email-send-once.server";
import { emailTarget, reminderNote } from "@/lib/collections/reminder-draft";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const REOPEN = "Close this reminder and open Remind again, then press Send.";
const opt = (s: z.ZodString) => z.preprocess((v) => (v === "" || v === null ? undefined : v), s.optional());

const reminderEmailSchema = z.object({
  customerId: z.string().uuid("Open Remind from a customer row and try again."),
  subject: z.string().trim().min(1, "Write a subject for the email.").max(300, "Keep the subject under 300 characters."),
  message: z.string().trim().min(1, "The message is empty — write the reminder first.").max(4000, "Keep the message under 4,000 characters."),
  nextFollowUpOn: z.string({ required_error: NEXT_REQUIRED }).regex(ISO_DATE, NEXT_REQUIRED),
  invoiceId: opt(z.string().max(200)),
  quoteId: opt(z.string().max(200)),
  subscriptionId: opt(z.string().uuid()),
  /** R-1544: made when the dialog opens — the same id on a retry means the same email. */
  requestId: z.string({ required_error: REOPEN }).uuid(REOPEN),
}).strict("Only the reminder fields may be sent — reload the page and try again.");

export const POST = withRoute(
  {
    route: "api/collections/reminder/email",
    input: reminderEmailSchema,
    pages: ["/collections"],
    permission: "can_contact_customers",
    roleHint: "Your role cannot email customers. Ask your manager to send this reminder.",
  },
  async ({ supabase, input, user, tenantId, role }) => {
    const followup = followupRequestSchema.parse({
      customerId: input.customerId,
      kind: "email",
      note: reminderNote(input.message),
      nextFollowUpOn: input.nextFollowUpOn,
      invoiceId: input.invoiceId,
      quoteId: input.quoteId,
      subscriptionId: input.subscriptionId,
    });

    const { data: customer, error: custErr } = await supabase
      .from("customers").select("id").eq("id", input.customerId).maybeSingle();
    if (custErr) throw new RouteError(500, "Could not read this customer — reload the page and try again.", custErr.message);
    if (!customer) throw new RouteError(404, "This customer is not in your list any more — reload Payment Follow-up and pick them again.");

    await assertFollowupLinks(supabase, followup);

    const target = emailTarget((await primaryContactEmail(supabase, input.customerId)).email);
    if (!target.ok) throw new RouteError(422, target.reason);

    const claim = await claimEmailSend(supabase, { tenantId, requestId: input.requestId, customerId: input.customerId, kind: "payment_reminder" });
    if (!claim.go) {
      return { sentTo: claim.sentTo ?? target.to, followupId: claim.followupId, logged: !!claim.followupId, alreadySent: true };
    }

    const sent = await sendCustomerEmail({
      to: target.to,
      subject: input.subject,
      text: input.message,
      route: { tenantId },
      kind: "payment_reminder",
    });
    if (sent.status !== "sent") await settleEmailSend(supabase, claim.claimId, { status: "failed" });
    if (sent.status === "failed") {
      throw new RouteError(502, `${sent.errorMessage ?? "The email could not be sent."} Nothing was sent and nothing was logged — fix that and press Send again, or use WhatsApp.`);
    }
    if (sent.status !== "sent") {
      throw new RouteError(503, "Email is not set up for your company, so nothing was sent and nothing was logged. Connect email in Settings → Integrations, or use WhatsApp.");
    }

    try {
      const row = await logFollowup(supabase, { input: followup, userId: user.id, tenantId, role });
      await settleEmailSend(supabase, claim.claimId, { status: "sent", sentTo: target.to, followupId: row.id });
      return { sentTo: target.to, followupId: row.id, logged: true };
    } catch (e) {
      await settleEmailSend(supabase, claim.claimId, { status: "sent", sentTo: target.to, followupId: null });
      if (!(e instanceof RouteError)) console.error("[api/collections/reminder/email] email sent, follow-up log failed:", e);
      const why =e instanceof RouteError ? e.publicMessage :"the follow-up could not be saved";
      return {
        sentTo: target.to,
        followupId: null,
        logged: false,
        warning: `The email went to ${target.to}, but the follow-up was not logged (${why}). Log it with Follow-up — do not send the email again.`,
      };
    }
  },
);
