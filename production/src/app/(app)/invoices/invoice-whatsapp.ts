/**
 * R-245: every "WhatsApp" button on an invoice goes through here.
 *
 * The list's bulk bar and row menu used to open `wa.me/?text=…` with no number (WhatsApp
 * then shows a contact picker), and the invoice page opened the same blind link when the
 * customer had no phone — no warning either way. Now: phone known → the chat with that
 * customer; no phone → a toast with "Add phone" on the customer record (same rule as the
 * quote page's WhatsApp share), and WhatsApp is not opened.
 */
import { toast } from "sonner";
import { invoiceWhatsAppTarget, type WhatsAppSender } from "@/lib/whatsapp";
import type { Customer, Invoice } from "@/lib/supabase/database.types";

/** The customer's phone for an invoice, from the cached customer list. */
export function invoiceCustomerPhone(
  invoice: Pick<Invoice, "customer_id">,
  customers: readonly Pick<Customer, "id" | "contact_phone">[] | null | undefined,
): string | null {
  if (!invoice.customer_id || !customers) return null;
  return customers.find((c) => c.id === invoice.customer_id)?.contact_phone ?? null;
}

/** Opens the reminder chat, or explains why it cannot. Returns true when WhatsApp opened. */
export function openInvoiceWhatsApp(
  invoice: Partial<Invoice>,
  phone: string | null | undefined,
  sender: WhatsAppSender | null | undefined,
  goTo: (href: string) => void,
): boolean {
  const target = invoiceWhatsAppTarget(invoice, phone, sender);
  if (!target.ok) {
    const customerId = invoice.customer_id;
    toast.error("No phone number for this customer", {
      description: "Add a phone number on the customer, then send the reminder on WhatsApp.",
      action: customerId
        ? { label: "Add phone", onClick: () => goTo(`/customers/${customerId}/edit`) }
        : undefined,
    });
    return false;
  }
  window.open(target.url, "_blank");
  return true;
}
