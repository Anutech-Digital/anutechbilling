/**
 * The payment reminder that Payments → Outstanding → "Remind" opens in the mail app (R-1638).
 *
 * Before: `mailto:?subject=…` — no "To", so the person had to find the customer's address
 * themselves, and every mail was signed "— Anutech Digital" whatever business sent it.
 * Now: To = the customer's billing contact (lib/contacts/primary — the one resolver; primary
 * contact, legacy contact_email as a floor), signed with the tenant's own name.
 * "Last reminder" is still written only after the person confirms it went out (R-1698).
 */
import { createClient } from "@/lib/supabase/client";
import { primaryContactEmail } from "@/lib/contacts/primary";
import { formatDate, rupee } from "@/lib/utils";

export interface DuesReminderRow {
  customer_name: string;
  plan: string;
  outstanding_amount: number;
  paid_amount: number;
  total_quote_amount: number;
  started_at: string;
}

/** The mailto: link — To filled when the customer has an email on file. */
export function duesReminderMailto(
  o: DuesReminderRow,
  opts: { to: string | null; sellerName: string | null | undefined },
): string {
  const subject = `Payment reminder · ${rupee(o.outstanding_amount)} pending`;
  const seller = (opts.sellerName ?? "").trim();
  const body =
    `Hi ${o.customer_name},\n\nThis is a friendly reminder that ${rupee(o.outstanding_amount)} is still pending against ` +
    `your subscription for ${o.plan} (started ${formatDate(o.started_at)}).\n\n` +
    `You've paid ${rupee(o.paid_amount)} of ${rupee(o.total_quote_amount)}.\n\n` +
    `Please complete the payment at your earliest convenience to keep your service uninterrupted.` +
    (seller ? `\n\n— ${seller}` : "");
  const to = (opts.to ?? "").trim();
  return `mailto:${to ? encodeURIComponent(to) : ""}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

/** The customer's billing email, or null when there is none (or it cannot be read). */
export async function duesReminderTo(customerId: string | null): Promise<string | null> {
  if (!customerId) return null;
  try {
    return (await primaryContactEmail(createClient(), customerId)).email;
  } catch {
    return null;
  }
}
