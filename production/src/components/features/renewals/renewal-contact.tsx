/**
 * R-2824 — "who do I call about this renewal": the contact's name · phone (call + WhatsApp) ·
 * email, or "No contact — Add contact" (the customer's page, where its Contacts card adds one).
 * Used in the Renewals drawer header and in the renewal follow-up dialog. Words + links:
 * ./renewal-contact-rules.ts.
 */
import Link from "next/link";
import { Icon } from "@/components/ui/icon";
import { renewalContactView, type RenewalContactInput } from "./renewal-contact-rules";

const LINK = "inline-flex min-w-0 items-center gap-1 rounded-sm hover:text-ink hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber";

export function RenewalContact({ contact, customerId, loading = false }: {
  contact: RenewalContactInput | null | undefined;
  customerId: string | null;
  /** The contacts are still being read — say nothing rather than a wrong "No contact". */
  loading?: boolean;
}) {
  if (loading && !contact) return null;
  const v = renewalContactView(contact);
  if (!v) {
    return (
      <p className="flex flex-wrap items-center gap-x-2 text-xs text-ink-3" data-testid="renewal-contact" data-state="none">
        <Icon name="user" size={12} className="shrink-0" />
        <span>No contact —</span>
        {customerId && (
          <Link href={`/customers/${customerId}` as never} className="font-medium text-ink-2 underline underline-offset-2 hover:text-ink">Add contact</Link>
        )}
      </p>
    );
  }
  const hidden = "Hidden for your role. The owner or a manager can see it.";
  return (
    <p className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-2" data-testid="renewal-contact" data-state="has">
      {v.name && (
        <span className="inline-flex min-w-0 items-center gap-1 font-medium text-ink">
          <Icon name="user" size={12} className="shrink-0 text-ink-3" />{v.name}
        </span>
      )}
      {v.phoneText && (v.telHref
        ? <a href={v.telHref} className={`${LINK} tabular-nums`} title={v.name ? `Call ${v.name}` : "Call"}><Icon name="phone" size={12} className="shrink-0" />{v.phoneText}</a>
        : <span className="inline-flex items-center gap-1 tabular-nums text-ink-3" title={v.masked ? hidden : undefined}><Icon name="phone" size={12} className="shrink-0" />{v.phoneText}</span>)}
      {v.whatsappHref && (
        <a href={v.whatsappHref} target="_blank" rel="noopener noreferrer" className={LINK} title="Open WhatsApp chat"><Icon name="whatsapp" size={12} className="shrink-0" />WhatsApp</a>
      )}
      {v.email && (v.mailHref
        ? <a href={v.mailHref} className={`${LINK} break-all`}><Icon name="mail" size={12} className="shrink-0" />{v.email}</a>
        : <span className="inline-flex min-w-0 items-center gap-1 break-all text-ink-3" title={v.masked ? hidden : undefined}><Icon name="mail" size={12} className="shrink-0" />{v.email}</span>)}
    </p>
  );
}
