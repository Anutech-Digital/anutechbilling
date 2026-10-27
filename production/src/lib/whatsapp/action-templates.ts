/**
 * WhatsApp action-message presets (quote / invoice / renewal / welcome / custom).
 *
 * R-1924 (G-ONBOARD OB-3, 26 Oct 2026): every line about the SENDER comes from the
 * logged-in company (tenants: name, email, phone, upi_vpa, remit_* bank fields, read
 * through useCurrentUser). These presets used to hardcode one company's own name, bank
 * account, UPI and support mail, so a new tenant's customers were asked to pay someone
 * else. A detail the company has not filled in is left out — never a made-up placeholder.
 * Guarded by tenant-template-brand-scan.test.ts.
 */
import type { CurrentUserInfo } from "@/lib/hooks/useCurrentUser";

export type WhatsAppCategory = "quote" | "invoice" | "renewal" | "welcome" | "custom";

export interface WhatsAppSender {
  name: string;
  email: string | null;
  phone: string | null;
  upiVpa: string | null;
  bankName: string | null;
  accountName: string | null;
  accountNumber: string | null;
  ifsc: string | null;
  branch: string | null;
}

export interface WhatsAppTemplateVars {
  quoteNumber?: string;
  invoiceNumber?: string;
  amount?: string;
  dueDate?: string;
  domain?: string;
  productName?: string;
  seats?: number;
  link?: string;
}

type SenderFields = Pick<
  CurrentUserInfo,
  | "tenantName" | "tenantEmail" | "tenantPhone" | "tenantUpiVpa"
  | "tenantRemitBankName" | "tenantRemitAccountName" | "tenantRemitAccountNumber"
  | "tenantRemitIfsc" | "tenantRemitBranch"
>;

const clean = (v: string | null | undefined): string | null => (v && v.trim() ? v.trim() : null);

/** The logged-in company as the sender. Before the user loads: a neutral "our team". */
export function senderFromUser(me: SenderFields | null | undefined): WhatsAppSender {
  return {
    name: clean(me?.tenantName) ?? "our team",
    email: clean(me?.tenantEmail),
    phone: clean(me?.tenantPhone),
    upiVpa: clean(me?.tenantUpiVpa),
    bankName: clean(me?.tenantRemitBankName),
    accountName: clean(me?.tenantRemitAccountName),
    accountNumber: clean(me?.tenantRemitAccountNumber),
    ifsc: clean(me?.tenantRemitIfsc),
    branch: clean(me?.tenantRemitBranch),
  };
}

/** "Bank Details" block from the company's own remittance fields — empty when it has none. */
function paymentBlock(s: WhatsAppSender): string {
  const bank: string[] = [];
  // A bank block needs an account number to be usable; without it only UPI (if any) is shown.
  if (s.accountNumber) {
    if (s.bankName) bank.push(`Bank: ${s.bankName}${s.branch ? `, ${s.branch}` : ""}`);
    bank.push(`A/c Name: ${s.accountName ?? s.name}`);
    bank.push(`A/c No: ${s.accountNumber}`);
    if (s.ifsc) bank.push(`IFSC: ${s.ifsc}`);
  }
  if (s.upiVpa) bank.push(`UPI ID: ${s.upiVpa}`);
  if (!bank.length) return "";
  const title = s.accountNumber ? "*Bank Details for RTGS/NEFT/UPI:*" : "*Pay by UPI:*";
  return `${title}\n${bank.join("\n")}\n\n`;
}

export function buildWhatsAppTemplates(input: {
  recipientName: string | null | undefined;
  companyName: string | null | undefined;
  vars: WhatsAppTemplateVars;
  sender: WhatsAppSender;
}): Record<WhatsAppCategory, string> {
  const { vars, sender } = input;
  const cName = input.recipientName || input.companyName || "Valued Client";
  const co = input.companyName || "your organization";
  const link = (label: string) => (vars.link ? `${label}${vars.link}\n\n` : "");
  const contact = [sender.phone ? `call us at ${sender.phone}` : null, sender.email ? `email ${sender.email}` : null]
    .filter(Boolean).join(" or ");

  return {
    quote: `Hi ${cName},\n\n` +
      `Greetings from ${sender.name}! 🚀\n\n` +
      `We have generated Quote *${vars.quoteNumber || "Q-2026-XXXX"}* for ${co}.\n` +
      `• *Plan/Product:* ${vars.productName || "Google Workspace / M365"}\n` +
      `• *Seats:* ${vars.seats || 10} licenses\n` +
      `• *Total Value:* ${vars.amount || "₹XX,XXX"}\n\n` +
      link("You can view, download, and approve your quote online here:\n") +
      `Please let us know if you need any adjustments or custom licensing terms!`,

    invoice: `Hi ${cName},\n\n` +
      `Hope you are having a productive day!\n\n` +
      `This is a gentle payment reminder for GST Invoice *${vars.invoiceNumber || "INV-XXXX"}* issued to ${co}.\n` +
      `• *Amount Due:* *${vars.amount || "₹XX,XXX"}*\n` +
      `• *Due Date:* ${vars.dueDate || "Immediate"}\n\n` +
      paymentBlock(sender) +
      `Kindly share the transaction UTR once processed. Thank you!\n\n— ${sender.name}`,

    renewal: `Hi ${cName},\n\n` +
      `⚠️ *Subscription Expiration Warning*\n\n` +
      `Your subscription for *${vars.domain || co}* (${vars.productName || "Cloud Service"}) is due for renewal on *${vars.dueDate || "soon"}*.\n\n` +
      `To avoid service interruption, admin lockout, or email bounce, please confirm your renewal quote *${vars.quoteNumber || "Q-XXXX"}* (${vars.amount || "₹XX,XXX"}).\n\n` +
      link("Quick Link: ") +
      `Reply YES to auto-renew${contact ? `, or ${contact}` : ""}.\n\n— ${sender.name}`,

    welcome: `Hi ${cName},\n\n` +
      `🎉 Welcome to ${sender.name}!\n\n` +
      `Your service provisioning for *${co}* is now COMPLETE.\n` +
      `• *Domain/Tenant:* ${vars.domain || "Your Workspace"}\n` +
      `• *Licenses Active:* ${vars.seats || 10} seats\n\n` +
      `Your admin console is active. For technical support or license additions, reply to this chat` +
      `${sender.email ? ` or email ${sender.email}` : ""}.`,

    custom: `Hi ${cName},\n\n`,
  };
}
