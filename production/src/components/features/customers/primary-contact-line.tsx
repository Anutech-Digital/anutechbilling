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
      {tel && (
        <a
          href={`tel:${tel}`}
          className="inline-flex items-center gap-1 text-ink-2 hover:text-amber-ink tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber rounded-sm"
        >
          <Icon name="phone" size={12} className="text-ink-3 flex-shrink-0" />
          {formatPhone(tel)}
        </a>
      )}
      {contact.email && (
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
