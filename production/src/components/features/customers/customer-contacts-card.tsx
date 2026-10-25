/**
 * A customer's people — the single home for "who do I ring".
 *
 * ─── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * The same fact used to live in three places, two of them dead: the flat
 * `customers.contact_*` columns the app actually read, a `contact_persons` jsonb
 * nobody filled, and a `contacts` table with a `customer_id` and zero rows. Three
 * copies of one phone number is how the next person rings the wrong one.
 *
 * Abhishek's decision, 10 Sep 2026: one identity, several people per customer with
 * roles, at least one mandatory. Prospects who are not customers belong in `leads`.
 *
 * The PRIMARY contact is the one who receives invoices and payment reminders, which is
 * why it is a single visible choice and not a column somebody has to interpret. The
 * database enforces one-per-customer; this screen just has to make it obvious.
 */
"use client";

import * as React from "react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/label";
import { Icon } from "@/components/ui/icon";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import {
  useCustomerContacts, useCreateContact, useUpdateContact,
  useSetPrimaryContact, useDeleteCustomerContact,
  CONTACT_ROLES, roleLabel, useContactSearchIndex, type Contact, type ContactRole,
} from "@/lib/queries/contacts";
import type { PrimaryContact } from "@/components/features/customers/customer-links";
import { formatPhone } from "@/lib/utils";
import { isMaskedContact } from "@/lib/auth/roles";

interface Props {
  customerId: string;
  customerName: string;
  /** R-1522: open the add-contact dialog now (the header's "Add contact" asked for it). */
  autoOpenAdd?: boolean;
  /** Called once the dialog was opened for `autoOpenAdd`, so it does not reopen. */
  onAutoOpenHandled?: () => void;
  /**
   * R-1670 (5): the person on the customer record itself (customers.contact_*), from
   * primaryContactOf — what the header shows when no contact person is saved. Reminders and
   * renewals do go there, so the card must not say "no contact" over it.
   */
  recordContact?: PrimaryContact | null;
  /**
   * R-1893: the number typed in the customer form (customers.contact_mobile, else
   * contact_phone — recordPhoneOf). Shown on the PRIMARY row when that contact has no phone
   * of its own, so a mobile the owner typed is never invisible here.
   */
  recordPhone?: string | null;
}

type Draft = {
  id?: string;
  full_name: string;
  email: string;
  phone: string;
  title: string;
  role: ContactRole;
};

const emptyDraft: Draft = { full_name: "", email: "", phone: "", title: "", role: "poc" };

export function CustomerContactsCard({ customerId, customerName, autoOpenAdd, onAutoOpenHandled, recordContact = null, recordPhone = null }: Props) {
  const { data: contacts, isLoading } = useCustomerContacts(customerId);
  /* How many customers each of these people serves — drives the "Serves N customers"
     chip. Already cached by the Customers and Subscriptions pages. */
  const { data: contactIndex } = useContactSearchIndex();
  const create = useCreateContact();
  const update = useUpdateContact();
  const setPrimary = useSetPrimaryContact();
  const remove = useDeleteCustomerContact();

  const [open, setOpen] = React.useState(false);
  const [draft, setDraft] = React.useState<Draft>(emptyDraft);

  const startAdd = () => { setDraft(emptyDraft); setOpen(true); };
  React.useEffect(() => {
    if (!autoOpenAdd) return;
    setDraft(emptyDraft);
    setOpen(true);
    onAutoOpenHandled?.();
  }, [autoOpenAdd, onAutoOpenHandled]);
  /* R-1670 (5): turn the record's contact into a real contact person, prefilled. */
  const saveRecordContact = (r: PrimaryContact) => {
    setDraft({ full_name: r.name, email: r.email ?? "", phone: r.phone ?? "", title: r.title ?? "", role: "poc" });
    setOpen(true);
  };
  const startEdit = (c: Contact) => {
    setDraft({
      id: c.id,
      full_name: c.full_name ?? "",
      email: c.email ?? "",
      phone: c.phone ?? "",
      title: c.title ?? "",
      role: (c.role as ContactRole) ?? "poc",
    });
    setOpen(true);
  };

  const save = async () => {
    const name = draft.full_name.trim();
    if (!name) {
      /* §24: what is wrong and what to do, not just a refusal. */
      toast.error("A contact needs a name", {
        description: "Enter the person's name — that is what appears on reminders and invoices.",
      });
      return;
    }
    const isFirst = (contacts ?? []).length === 0;
    const payload = {
      full_name: name,
      email: draft.email.trim() || null,
      phone: draft.phone.trim() || null,
      title: draft.title.trim() || null,
      role: draft.role,
      customer_id: customerId,
      company: customerName,
    };
    try {
      if (draft.id) {
        await update.mutateAsync({ id: draft.id, values: payload });
      } else {
        /* The first contact a customer has becomes the primary automatically. Leaving
           it unset would mean an invoice with nobody to send it to, and asking the
           operator to tick a box on the only option is a question with one answer. */
        await create.mutateAsync({ ...payload, is_primary: isFirst });
      }
      setOpen(false);
    } catch {
      /* The hooks already toast the real message. */
    }
  };

  const rows = contacts ?? [];

  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <h3 className="font-semibold text-ink text-sm">Contacts</h3>
          <p className="text-2xs text-ink-3 mt-0.5">
            {rows.length === 0
              ? (recordContact ? "On the customer record only" : "Nobody to contact yet")
              : `${rows.length} ${rows.length === 1 ? "person" : "people"} · the primary gets invoices and reminders`}
          </p>
        </div>
        <Button size="sm" variant="outline" icon="plus" onClick={startAdd}>
          Add contact
        </Button>
      </div>

      {isLoading && <p className="text-xs text-ink-3">Loading…</p>}

      {/* Every customer should have one. If this shows, something upstream let a
          customer through without a contact — say so plainly rather than showing an
          empty box the operator has to interpret. */}
      {!isLoading && rows.length === 0 && recordContact && (
        <div className="rounded-lg border border-hairline bg-paper-2/40 p-3" data-testid="record-contact">
          <p className="text-sm font-medium text-ink break-words">
            {recordContact.name}
            {recordContact.title && <span className="text-ink-3 font-normal"> · {recordContact.title}</span>}
          </p>
          <p className="mt-0.5 text-2xs text-ink-3 break-words">
            {[recordContact.email, recordContact.phone].filter(Boolean).join(" · ") || "No email or phone yet"}
          </p>
          <p className="mt-1.5 text-2xs text-ink-2">
            Saved on the customer record, not as a contact person. Save it as a contact to give it a role and make it the primary.
          </p>
          <Button size="sm" variant="outline" className="mt-2" onClick={() => saveRecordContact(recordContact)}>
            Save as contact
          </Button>
        </div>
      )}

      {!isLoading && rows.length === 0 && !recordContact && (
        <div className="rounded-lg border border-amber/40 bg-amber-soft/40 p-3">
          <p className="text-xs font-semibold text-amber-ink flex items-center gap-1.5">
            <Icon name="alert" size={14} />
            This customer has no contact
          </p>
          <p className="mt-1 text-2xs text-ink-2">
            Invoices and payment reminders have nowhere to go. Add one now.
          </p>
        </div>
      )}

      <ul className="divide-y divide-hairline">
        {rows.map((c) => (
          <li key={c.id} className="py-2.5 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-medium text-sm text-ink">{c.full_name}</span>
                {c.is_primary && (
                  <Badge kind="success" size="sm" title="Receives invoices and payment reminders">
                    Primary
                  </Badge>
                )}
                <Badge kind="muted" size="sm">{roleLabel(c.role)}</Badge>
                {/* ── "Serves 3 customers" ────────────────────────────────────
                    Since 18 Sep 2026 the same human can look after several companies,
                    and until you can see that, the capability is invisible: this card
                    looks identical whether Anjali is on one customer or five. The chip
                    opens Customers filtered to her, which is the question anybody who
                    notices the number immediately asks. Shown only above one, because
                    "Serves 1 customer" on every row is noise. */}
                {(contactIndex?.customerCountByContact.get(c.id) ?? 0) > 1 && (
                  <Link
                    href={`/customers?contact=${encodeURIComponent(c.email || c.full_name)}` as never}
                    className="text-2xs text-ink-3 underline underline-offset-2 hover:text-ink"
                    title={`Show every customer ${c.full_name} looks after`}
                  >
                    Serves {contactIndex?.customerCountByContact.get(c.id)} customers
                  </Link>
                )}
              </div>
              {(() => {
                /* R-1893: the primary takes the customer form's number when it has none. */
                const phone = c.phone?.trim() || (c.is_primary ? recordPhone?.trim() || null : null);
                const text = [c.title, c.email].filter(Boolean).join(" · ");
                return (
                  <div className="mt-0.5 text-2xs text-ink-3 break-words">
                    {text}
                    {text && phone && " · "}
                    {phone && <ContactPhone phone={phone} />}
                    {!text && !phone && "No email or phone yet"}
                  </div>
                );
              })()}
            </div>
            <div className="flex items-center gap-1 shrink-0">
              {!c.is_primary && (
                <Button
                  size="sm" variant="ghost"
                  title="Make this the contact who receives invoices and reminders"
                  onClick={() => setPrimary.mutate({ contactId: c.id, customerId })}
                >
                  Make primary
                </Button>
              )}
              <Button size="sm" variant="ghost" icon="edit" aria-label={`Edit ${c.full_name}`}
                      onClick={() => startEdit(c)} />
              <Button
                size="sm" variant="ghost" icon="trash"
                aria-label={`Remove ${c.full_name}`}
                onClick={() => remove.mutate({ contactId: c.id, customerId })}
              />
            </div>
          </li>
        ))}
      </ul>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{draft.id ? "Edit contact" : "Add contact"}</DialogTitle>
            <DialogDescription className="text-xs text-ink-3">
              {customerName}
              {!draft.id && (contacts ?? []).length === 0
                ? " · this first contact becomes the primary"
                : ""}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <FormField label="Name *" required htmlFor="ct_name">
              <Input id="ct_name" value={draft.full_name} autoFocus
                     onChange={(e) => setDraft({ ...draft, full_name: e.target.value })} />
            </FormField>

            <div className="grid grid-cols-2 gap-3">
              <FormField label="Role" htmlFor="ct_role">
                <Select value={draft.role}
                        onValueChange={(v) => setDraft({ ...draft, role: v as ContactRole })}>
                  <SelectTrigger id="ct_role"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {CONTACT_ROLES.map((r) => (
                      <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>
              <FormField label="Job title" htmlFor="ct_title">
                <Input id="ct_title" value={draft.title} placeholder="CTO, Accounts Head…"
                       onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
              </FormField>
            </div>

            <FormField label="Email" htmlFor="ct_email">
              <Input id="ct_email" type="email" value={draft.email}
                     onChange={(e) => setDraft({ ...draft, email: e.target.value })} />
            </FormField>
            <FormField label="Phone" htmlFor="ct_phone">
              <Input id="ct_phone" value={draft.phone} placeholder="+91 98765 43210"
                     onChange={(e) => setDraft({ ...draft, phone: e.target.value })} />
            </FormField>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button variant="primary" onClick={save}
                    loading={create.isPending || update.isPending}>
              {/* NOT "Add contact" — that is also the card's trigger label, and two
                  controls with the same name are ambiguous to a screen reader and to
                  anybody describing the screen out loud. */}
              {draft.id ? "Save changes" : "Save contact"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

/**
 * R-1893: a contact's phone, tap to call — the same rule as the header (primary-contact-line):
 * a masked value (R-1009, a role without can_view_contact_details) stays plain text, never a
 * tel: link that could only dial the mask.
 */
function ContactPhone({ phone }: { phone: string }) {
  const tel = phone.replace(/\s+/g, "");
  if (isMaskedContact(tel)) {
    return <span className="tabular-nums" title="Hidden for your role. The owner or a manager can see it.">{tel}</span>;
  }
  return (
    <a
      href={`tel:${tel}`}
      className="tabular-nums text-ink-2 hover:text-amber-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber rounded-sm"
    >
      {formatPhone(tel)}
    </a>
  );
}
