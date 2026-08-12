/**
 * WhatsApp Business Integration Helper.
 * Generates formatted WhatsApp web links (https://wa.me/...) with pre-filled templates.
 */
import { rupee, formatDate } from "@/lib/utils";
import type { Invoice, Lead } from "@/lib/supabase/database.types";

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
 * Generate WhatsApp URL for Invoice Payment Reminder
 */
export function getInvoiceWhatsAppUrl(
  invoice: Partial<Invoice>,
  phone?: string | null
): string {
  const targetPhone = formatWhatsAppPhone(phone || "");
  const amountStr = rupee(invoice.net_payable || invoice.amount || 0);
  const invNumber = invoice.id || "";
  const dueDate = invoice.due_date ? formatDate(invoice.due_date) : "due date";

  const message = `Namaste 🙏,

This is a friendly reminder regarding Tax Invoice *${invNumber}* for *${amountStr}* which is due on *${dueDate}*.

Kindly arrange the payment at your earliest convenience. If already paid, please ignore this message.

Thank you!
*Excel Technologies / ResellerOS*`;

  return `https://wa.me/${targetPhone}?text=${encodeURIComponent(message)}`;
}

/**
 * Generate WhatsApp URL for Lead Follow-up / Quote
 */
export function getLeadWhatsAppUrl(
  lead: Partial<Lead>,
  phone?: string | null
): string {
  const targetPhone = formatWhatsAppPhone(phone || lead.contact_phone || "");
  const company = lead.company || "your business";
  const plan = lead.plan || "Google Workspace";
  const seats = lead.seats ? `${lead.seats} users` : "";

  const message = `Namaste ${lead.contact_name || "there"} 👋,

Following up on your query for *${plan}* (${seats}) for *${company}*.

We have special discount rates available this week. Would you like us to share a quick quote?

Best regards,
*Excel Technologies*`;

  return `https://wa.me/${targetPhone}?text=${encodeURIComponent(message)}`;
}

/**
 * Generate WhatsApp URL for License Renewal Notice
 */
export function getRenewalWhatsAppUrl(
  customerName: string,
  plan: string,
  expiryDate: string,
  phone?: string | null
): string {
  const targetPhone = formatWhatsAppPhone(phone || "");
  
  const message = `Namaste 👋,

Your *${plan}* subscription for *${customerName}* is set to expire on *${expiryDate}*.

To prevent any interruption to your emails and cloud services, kindly confirm your renewal.

Best regards,
*Excel Technologies*`;

  return `https://wa.me/${targetPhone}?text=${encodeURIComponent(message)}`;
}
