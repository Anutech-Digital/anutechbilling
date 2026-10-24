/**
 * R-1522 (17 Oct 2026, Pardeep) — the customer header's contact line.
 *
 * Right under the company name: the PRIMARY contact person — name · designation ·
 * phone · email — with tap-to-call and tap-to-mail. When the customer has no contact
 * person it says so ("Koi contact person nahi") and offers "Add contact" (§24: say what
 * is missing and the next step), instead of repeating the company name as if it were
 * a person (the GREENTIN SOLUTIONS screenshot).
 */
"use client";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { formatPhone } from "@/lib/utils";
import { isMaskedContact } from "@/lib/auth/roles";
import type { PrimaryContact } from "@/components/features/customers/customer-links";

export function PrimaryContactLine({ contact, onAddContact }: {
  contact: PrimaryContact | null;
  /** Absent for read-only roles — they see the "no contact" note without the button. */
  onAddContact?: () => void;
}) {
  if (!contact) {
    return (
      <div className="mt-1 flex items-center gap-2 flex-wrap text-sm text-ink-3" data-testid="header-no-contact">
        <span className="inline-flex items-center gap-1.5">
          <Icon name="user" size={13} className="flex-shrink-0" />
          No contact person yet
        </span>
        {onAddContact && (
          <Button size="sm" variant="outline" icon="plus" onClick={onAddContact}>
            Add contact
          </Button>
        )}
      </div>
    );
  }
  const tel = contact.phone?.replace(/\s+/g, "");
  /* R-1009: a role without can_view_contact_details gets "••••••3210" from the data gateway —
     shown as text, never as a tel: / mailto: link that could only dial a mask. */
  const hidden = "Hidden for your role. The owner or a manager can see it.";
  return (
    <div
      className="mt-1 flex items-center gap-x-3 gap-y-1 flex-wrap text-sm text-ink-2 min-w-0"
      data-testid="header-contact"
    >
      <span className="inline-flex items-center gap-1.5 min-w-0">
        <Icon name="user" size={13} className="text-ink-3 flex-shrink-0" />
        <span className="font-medium text-ink break-words">{contact.name}</span>
        {contact.title && <span className="text-ink-3">· {contact.title}</span>}
      </span>
      {tel && isMaskedContact(tel) && (
        <span className="inline-flex items-center gap-1 text-ink-3 tabular-nums" title={hidden}>
          <Icon name="phone" size={12} className="flex-shrink-0" />
          {tel}
        </span>
      )}
      {contact.email && isMaskedContact(contact.email) && (
        <span className="inline-flex items-center gap-1 text-ink-3 min-w-0 break-all" title={hidden}>
          <Icon name="mail" size={12} className="flex-shrink-0" />
          {contact.email}
        </span>
      )}
      {tel && !isMaskedContact(tel) && (
        <a
          href={`tel:${tel}`}
          className="inline-flex items-center gap-1 text-ink-2 hover:text-amber-ink tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber rounded-sm"
        >
          <Icon name="phone" size={12} className="text-ink-3 flex-shrink-0" />
          {formatPhone(tel)}
        </a>
      )}
      {contact.email && !isMaskedContact(contact.email) && (
        <a
          href={`mailto:${contact.email}`}
          className="inline-flex items-center gap-1 text-ink-2 hover:text-amber-ink min-w-0 break-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber rounded-sm"
        >
          <Icon name="mail" size={12} className="text-ink-3 flex-shrink-0" />
          {contact.email}
        </a>
      )}
    </div>
  );
}
