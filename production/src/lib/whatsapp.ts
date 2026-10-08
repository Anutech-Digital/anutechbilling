/**
 * WhatsApp Business links — the pre-filled `https://wa.me/…` messages a reseller
 * sends by hand from the app.
 *
 * ─── THESE MESSAGES WERE SIGNED WITH THE WRONG COMPANY ──────────────────────
 * All three used to end with a hardcoded `*Excel Technologies*`. Excel Technologies is
 * HISTORICAL — the same tenant row was renamed to ANUTECH DIGITAL PVT LTD in Aug 2026
 * (CLAUDE.md §1). So every payment reminder, follow-up and renewal notice reaching a
 * customer's phone named a company they have no relationship with, over an invoice
 * number that is real. That reads as a scam, which is the exact opposite of what a
 * payment reminder needs to read as.
 *
 * It would also have been wrong for every OTHER tenant of this multi-tenant app, not
 * just this one. A hardcoded company name in a shared codebase is a bug the day a
 * second customer signs up.
 *
 * ─── WHEN THE SENDER IS UNKNOWN, THE MESSAGE IS UNSIGNED ────────────────────
 * `sender` is optional and there is no default name. An unsigned message is slightly
 * worse than a signed one; a message signed with someone else's company is far worse.
 * The caller passes what `useCurrentUser` gives it, and if that has not arrived the
 * customer simply gets no sign-off line.
 *
 * ─── AND A REMINDER NOW CARRIES A WAY TO PAY ────────────────────────────────
 * The invoice reminder used to say "kindly arrange the payment" and stop — a nag with
 * no next step, which puts the work back on the customer at the moment they were
 * willing to act. `lib/payments/upi.ts` (tested) and `tenant_settings.upi_vpa`
 * (migration 0227) both already existed and neither was wired in here.
 *
 * A `upi://pay?…` link is tappable on the phone the message is being read on, opens
 * GPay/PhonePe/Paytm with the amount and the invoice number already filled, and needs
 * no gateway. Its honest limitation, unchanged from upi.ts: the money lands in the
 * bank, not through a webhook, so somebody still records the payment. That is what
 * the bank-credit matcher is for.
 */
import { rupee, formatDate, toWhatsAppDigits } from "@/lib/utils";
import { buildUpiIntent } from "@/lib/payments/upi";
import type { Invoice, Lead } from "@/lib/supabase/database.types";

/**
 * Who is sending. Every field optional, because a half-known sender should degrade
 * one line at a time rather than block the message.
 */
export interface WhatsAppSender {
  /** Registered business name, used for the sign-off and as the UPI payee. */
  businessName?: string | null;
  /** `tenant_settings.upi_vpa`. Absent → the message carries no pay link. */
  upiVpa?: string | null;
  /** Payee name shown in the UPI app; falls back to businessName. */
  upiPayeeName?: string | null;
}

/**
 * Format phone number into international WhatsApp E.164 format (e.g. 919876543210)
 */
export function formatWhatsAppPhone(phone: string | null | undefined): string {
  if (!phone) return "";
  const cleaned = phone.replace(/\D/g, "");
  if (cleaned.length === 10) {
    return `91${cleaned}`;
  }
  return cleaned;
}

/**
 * The sign-off, or nothing at all.
 *
 * Returns "" rather than a placeholder for the reason in the header: no name beats
 * the wrong name on a message about money.
 */
export function signOff(sender?: WhatsAppSender | null): string {
  const name = sender?.businessName?.trim();
  return name ? `\n\n*${name}*` : "";
}

/**
 * A tappable UPI line, when — and only when — the reseller has set a valid VPA.
 *
 * Returns "" on a missing or malformed VPA. buildUpiIntent already refuses to build a
 * broken intent, because a typo'd VPA does not fail at scan time: it silently sends
 * the customer's money somewhere else.
 */
export function payLine(
  sender: WhatsAppSender | null | undefined,
  amount: number,
  reference: string,
): string {
  const vpa = sender?.upiVpa?.trim();
  if (!vpa) return "";
  const payee = sender?.upiPayeeName?.trim() || sender?.businessName?.trim();
  if (!payee) return "";

  const intent = buildUpiIntent({
    vpa,
    payeeName: payee,
    amount,
    note: reference,
    ref: reference,
  });
  if (!intent.ok) return "";

  return `\n\n💳 Pay now by UPI (GPay / PhonePe / Paytm):\n${intent.uri}`;
}

/**
 * Generate WhatsApp URL for Invoice Payment Reminder
 */
export function getInvoiceWhatsAppUrl(
  invoice: Partial<Invoice>,
  phone?: string | null,
  sender?: WhatsAppSender | null,
): string {
  const targetPhone = formatWhatsAppPhone(phone || "");
  const amount = invoice.net_payable || invoice.amount || 0;
  const amountStr = rupee(amount);
  const invNumber = invoice.id || "";
  /* R-245: with no due date the line used to read "which is due on *due date*" — the
     placeholder went to the customer. No date → the clause is left out. */
  const dueClause = invoice.due_date ? ` which is due on *${formatDate(invoice.due_date)}*` : "";

  const message = `Namaste 🙏,

This is a friendly reminder regarding Tax Invoice *${invNumber}* for *${amountStr}*${dueClause}.

Kindly arrange the payment at your earliest convenience. If already paid, please ignore this message.${payLine(sender, amount, invNumber)}

Thank you!${signOff(sender)}`;

  return `https://wa.me/${targetPhone}?text=${encodeURIComponent(message)}`;
}

/**
 * R-245: the reminder link, or why there is none.
 *
 * The invoice list used to call `getInvoiceWhatsAppUrl(inv, null, …)` — a `wa.me/?text=…`
 * link with no recipient, so WhatsApp opened a contact picker and the owner had to find
 * the customer by hand. Every caller now passes the customer's phone; with no usable
 * phone it gets `no_phone` and shows "Add phone" instead of opening WhatsApp blind (the
 * quote page's rule).
 */
export type InvoiceWhatsAppTarget =
  | { ok: true; url: string }
  | { ok: false; reason: "no_phone" };

export function invoiceWhatsAppTarget(
  invoice: Partial<Invoice>,
  phone: string | null | undefined,
  sender?: WhatsAppSender | null,
): InvoiceWhatsAppTarget {
  const digits = toWhatsAppDigits(phone);
  if (!digits) return { ok: false, reason: "no_phone" };
  return { ok: true, url: getInvoiceWhatsAppUrl(invoice, digits, sender) };
}

/**
 * Generate WhatsApp URL for Lead Follow-up / Quote
 */
export function getLeadWhatsAppUrl(
  lead: Partial<Lead>,
  phone?: string | null,
  sender?: WhatsAppSender | null,
): string {
  const targetPhone = formatWhatsAppPhone(phone || lead.contact_phone || "");
  const company = lead.company || "your business";
  const plan = lead.plan || "Google Workspace";
  const seats = lead.seats ? `${lead.seats} users` : "";

  const message = `Namaste ${lead.contact_name || "there"} 👋,

Following up on your query for *${plan}* (${seats}) for *${company}*.

We have special discount rates available this week. Would you like us to share a quick quote?

Best regards,${signOff(sender)}`;

  return `https://wa.me/${targetPhone}?text=${encodeURIComponent(message)}`;
}

/**
 * Generate WhatsApp URL for License Renewal Notice
 */
export function getRenewalWhatsAppUrl(
  customerName: string,
  plan: string,
  expiryDate: string,
  phone?: string | null,
  sender?: WhatsAppSender | null,
): string {
  const targetPhone = formatWhatsAppPhone(phone || "");

  const message = `Namaste 👋,

Your *${plan}* subscription for *${customerName}* is set to expire on *${expiryDate}*.

To prevent any interruption to your emails and cloud services, kindly confirm your renewal.

Best regards,${signOff(sender)}`;

  return `https://wa.me/${targetPhone}?text=${encodeURIComponent(message)}`;
}
