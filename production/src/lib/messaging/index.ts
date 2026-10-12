/**
 * R-897: THE door for every message the app sends — customers through sendCustomerMessage(),
 * everyone else (the owner, staff, sign-in mail) through sendInternalEmail/WhatsApp().
 *
 * ─── sendCustomerMessage — customer email + WhatsApp ────────────────────────────
 * Refused while the company's "Customer messages" switch (automation_jobs, job
 * 'customer_messages') is not ON. A missing row is OFF, so after the cutover nothing reaches a
 * customer until the owner turns it on in /automation — from a job OR from a person pressing
 * Send. Inside a cron pass (lib/automation/cron-gate.ts) it also refuses a company the job is
 * not on for, and in a practice run it only records "would send to X" and sends nothing.
 * A refused email is still written to email_log (status failed, with the reason), so a switch
 * that is off never looks like an outage.
 *
 * ─── sendInternalEmail / sendInternalWhatsApp — NOT gated ────────────────────────
 * For mail to the company itself: owner alerts, staff notices, invites, password resets,
 * email verification, the ops digest. Gating those would lock people out of their own app or
 * hide the alert that says something broke. Using one is a reviewable choice: it says in the
 * code "this does not go to a customer". messaging-chokepoint.test.ts fails the build if any
 * other file imports the raw senders (sendEmail / sendWhatsApp).
 *
 * The switch read fails CLOSED (lib/automation/gate.server.ts): no answer = OFF.
 */
import "server-only";
import { sendEmail, isEmailConfigured, type EmailMessage, type EmailSendResult } from "@/lib/email/send";
import { recordEmail } from "@/lib/email/log";
import { sendWhatsApp, type WhatsAppSendResult } from "@/lib/whatsapp/client";
import { automationState } from "@/lib/automation/gate.server";
import { cronTenantAllowed, currentCronRun, noteWouldSend } from "@/lib/automation/cron-gate";
import { CUSTOMER_MESSAGES } from "@/lib/automation/jobs";

export { isEmailConfigured };
export type { EmailMessage, EmailSendResult, WhatsAppSendResult };

export type WhatsAppSendOpts = Parameters<typeof sendWhatsApp>[0];

export const CUSTOMER_MESSAGES_OFF =
  "Customer messages are switched off for this company. The owner can turn them on in Automation.";

/** Thrown by sendCustomerWhatsApp when the message may not go — callers already catch send errors. */
export class CustomerMessageRefusedError extends Error {
  constructor(readonly reason: "customer_messages_off" | "job_off", message: string) {
    super(message);
    this.name = "CustomerMessageRefusedError";
  }
}

export type CustomerMessage =
  | { channel: "email"; tenantId: string; email: EmailMessage }
  | { channel: "whatsapp"; tenantId: string; whatsapp: WhatsAppSendOpts };

export type CustomerMessageResult =
  | { sent: true; email?: EmailSendResult; whatsapp?: WhatsAppSendResult }
  | { sent: false; reason: "customer_messages_off" | "job_off" | "dry_run"; message: string };

/**
 * The one decision: may this customer message go now? Returns the refusal, or null to send.
 * In a practice run the would-send entry is recorded here.
 */
async function refusal(tenantId: string, to: string, channel: "email" | "whatsapp", kind: string | null):
  Promise<Exclude<CustomerMessageResult, { sent: true }> | null> {
  const run = currentCronRun();
  if (run && !cronTenantAllowed(tenantId)) {
    return { sent: false, reason: "job_off", message: `Not sent — "${run.job}" is not on for this company.` };
  }
  if (run?.mode === "dry") {
    noteWouldSend({ tenantId, to, channel, kind });
    return { sent: false, reason: "dry_run", message: `Practice run — would send to ${to}; nothing was sent.` };
  }
  const state = await automationState(tenantId, CUSTOMER_MESSAGES);
  if (state !== "on") return { sent: false, reason: "customer_messages_off", message: CUSTOMER_MESSAGES_OFF };
  return null;
}

export async function sendCustomerMessage(m: CustomerMessage): Promise<CustomerMessageResult> {
  if (m.channel === "email") {
    const no = await refusal(m.tenantId, m.email.to, "email", m.email.kind ?? null);
    if (no) {
      await recordEmail(
        { tenantId: m.tenantId, recipient: m.email.to, subject: m.email.subject, kind: m.email.kind ?? null, provider: "stub" },
        { status: "failed", providerId: null, errorMessage: no.message, provider: "stub" },
      );
      return no;
    }
    return { sent: true, email: await sendEmail(m.email) };
  }
  const no = await refusal(m.tenantId, m.whatsapp.to, "whatsapp", m.whatsapp.message.kind);
  if (no) return no;
  return { sent: true, whatsapp: await sendWhatsApp({ ...m.whatsapp, tenantId: m.tenantId }) };
}

/**
 * Customer email with sendEmail()'s shape, so a caller changes one word. The company is the
 * message's own `route.tenantId` (or `automated.tenantId`); a message naming no company is
 * refused — there is no switch to ask. A refusal comes back as status "failed" with the reason
 * in errorMessage (and is in email_log); a practice run as status "stubbed".
 */
export async function sendCustomerEmail(msg: EmailMessage): Promise<EmailSendResult> {
  const tenantId = msg.route?.tenantId ?? msg.automated?.tenantId ?? null;
  if (!tenantId) {
    console.error(`[messaging] customer email to ${msg.to} names no company — refused`);
    return { status: "failed", providerId: null, errorMessage: "Not sent — no company on this message.", provider: "stub" };
  }
  const r = await sendCustomerMessage({ channel: "email", tenantId, email: msg });
  if (r.sent) return r.email as EmailSendResult;
  return {
    status: r.reason === "dry_run" ? "stubbed" : "failed",
    providerId: null,
    errorMessage: r.message,
    provider: "stub",
  };
}

/**
 * Customer WhatsApp with sendWhatsApp()'s shape. Refused → throws CustomerMessageRefusedError
 * (every caller already handles a thrown send); practice run → status "pending", nothing sent.
 */
export async function sendCustomerWhatsApp(opts: WhatsAppSendOpts): Promise<WhatsAppSendResult> {
  const r = await sendCustomerMessage({ channel: "whatsapp", tenantId: opts.tenantId, whatsapp: opts });
  if (r.sent) return r.whatsapp as WhatsAppSendResult;
  if (r.reason === "dry_run") return { wamid: null, status: "pending", raw: { dryRun: true } };
  throw new CustomerMessageRefusedError(r.reason, r.message);
}

/** NOT gated — mail to the company itself (owner/staff alerts, invites, sign-in). See header. */
export function sendInternalEmail(msg: EmailMessage): Promise<EmailSendResult> {
  return sendEmail(msg);
}

/** NOT gated — WhatsApp to the company's own people (e.g. a join request to the owner). */
export function sendInternalWhatsApp(opts: WhatsAppSendOpts): Promise<WhatsAppSendResult> {
  return sendWhatsApp(opts);
}
