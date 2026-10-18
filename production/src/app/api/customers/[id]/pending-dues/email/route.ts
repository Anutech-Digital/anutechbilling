/**
 * POST /api/customers/{id}/pending-dues/email — R-1526: a PERSON pressed "Send email" on the
 * pending-dues statement they previewed. Emails the statement PDF to the customer's own billing
 * email, then logs the follow-up (kind email, next date required).
 *
 *   • Sent only through lib/messaging's sendCustomerEmail (messaging-chokepoint.test.ts) — the
 *     company's "Customer messages" switch applies and email_log records it.
 *   • The body carries NO recipient and NO amounts: the address is the customer's primary
 *     contact (legacy contact_email as the floor) and the PDF is rendered HERE from the books at
 *     the moment of sending — never what the browser showed a minute ago.
 *   • Validated BEFORE sending (next follow-up date, something owed). Logged only when the email
 *     really left; if it left but the log failed, the answer says so — never a second send.
 *   • The follow-up goes through followup-log.server.ts (R-1517 rules: who it is assigned to).
 */
import { z } from "zod";
import { withRoute, RouteError } from "@/lib/api/with-route";
import { sendCustomerEmail } from "@/lib/messaging";
import { primaryContactEmail } from "@/lib/contacts/primary";
import { istToday } from "@/lib/dates/ist";
import { followupRequestSchema, NEXT_REQUIRED } from "@/lib/collections/followup-rules";
import { logFollowup } from "@/lib/collections/followup-log.server";
import { emailTarget, reminderNote } from "@/lib/collections/reminder-draft";
import { pendingDuesAbout, pendingDuesFileName } from "@/lib/collections/pending-dues";
import { pendingDuesPdfFor } from "@/lib/collections/pending-dues.server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const bodySchema = z.object({
  subject: z.string().trim().min(1, "Write a subject for the email.").max(300, "Keep the subject under 300 characters."),
  message: z.string().trim().min(1, "The message is empty — write a short note first.").max(4000, "Keep the message under 4,000 characters."),
  nextFollowUpOn: z.string({ required_error: NEXT_REQUIRED }).regex(ISO_DATE, NEXT_REQUIRED),
}).strict("Only the email fields may be sent — reload the page and try again.");

const idSchema = z.string().uuid();

export const POST = withRoute(
  {
    route: "api/customers/pending-dues/email",
    input: bodySchema,
    pages: ["/collections"],
    permission: "can_contact_customers",
    roleHint: "Your role cannot email customers. Ask your manager to send this statement.",
  },
  async ({ supabase, input, params, user, tenantId, role }) => {
    const customerId = params.id ?? "";
    if (!idSchema.safeParse(customerId).success) throw new RouteError(404, "Customer not found — reload the page and try again.");

    const out = await pendingDuesPdfFor(supabase, { customerId, tenantId, today: istToday() });
    if (!out) throw new RouteError(404, "This customer is not in your list any more — reload the page and pick them again.");
    if (out.statement.total <= 0) {
      throw new RouteError(409, "This customer owes nothing now — there is no statement to send. Reload the page.");
    }

    const about = pendingDuesAbout(out.statement);
    const followup = followupRequestSchema.parse({
      customerId,
      kind: "email",
      note: reminderNote(input.message),
      nextFollowUpOn: input.nextFollowUpOn,
      invoiceId: about.invoiceId ?? undefined,
      quoteId: about.quoteId ?? undefined,
      subscriptionId: about.subscriptionId ?? undefined,
    });

    const target = emailTarget((await primaryContactEmail(supabase, customerId)).email);
    if (!target.ok) throw new RouteError(422, target.reason);

    const sent = await sendCustomerEmail({
      to: target.to,
      subject: input.subject,
      text: input.message,
      attachments: [{
        filename: pendingDuesFileName(out.statement.customerName, out.statement.asOn),
        content: out.pdf,
        contentType: "application/pdf",
      }],
      route: { tenantId },
      kind: "pending_dues_statement",
    });
    if (sent.status === "failed") {
      throw new RouteError(502, `${sent.errorMessage ?? "The email could not be sent."} Nothing was sent and nothing was logged — fix that and press Send again, or use WhatsApp.`);
    }
    if (sent.status !== "sent") {
      throw new RouteError(503, "Email is not set up for your company, so nothing was sent and nothing was logged. Connect email in Settings → Integrations, or use WhatsApp.");
    }

    try {
      const row = await logFollowup(supabase, { input: followup, userId: user.id, tenantId, role });
      return { sentTo: target.to, total: out.statement.total, followupId: row.id, logged: true };
    } catch (e) {
      if (!(e instanceof RouteError)) console.error("[api/customers/pending-dues/email] email sent, follow-up log failed:", e);
      const why = e instanceof RouteError ? e.publicMessage : "the follow-up could not be saved";
      return {
        sentTo: target.to,
        total: out.statement.total,
        followupId: null,
        logged: false,
        warning: `The statement went to ${target.to}, but the follow-up was not logged (${why}). Log it with Follow-up — do not send the email again.`,
      };
    }
  },
);
