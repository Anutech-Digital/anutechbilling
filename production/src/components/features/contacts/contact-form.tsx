/**
 * ContactForm — add / edit a standalone contact with FULL profile detail.
 *
 * Built for the owner's own people: prospects to advertise to (email + social)
 * and folks they might meet in person (address). Not a lead or a customer — a
 * person record they enrich over time. Right-side Sheet, RHF + Zod, sectioned
 * so the long field list stays scannable.
 */
"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useForm, useFieldArray } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";

import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { FormField } from "@/components/ui/label";
import { Icon } from "@/components/ui/icon";
import { useCreateContact, useUpdateContact, type Contact, type ContactFormValues } from "@/lib/queries/contacts";
import { useCustomers } from "@/lib/queries/customers";
import { CustomerCombobox } from "@/components/features/customers/customer-combobox";

const EMAIL_LABELS = ["work", "home", "other"] as const;
const PHONE_LABELS = ["mobile", "work", "home", "other"] as const;
// Relationship classification for standalone contacts. Lead/Customer are NOT
// options here — those records are created in their own flows; this form only
// makes standalone contacts.
const RELATIONSHIP_OPTIONS = [
  { value: "",         label: "— Not set —" },
  { value: "partner",  label: "Partner" },
  { value: "vendor",   label: "Vendor / Supplier" },
  { value: "personal", label: "Personal / Relation" },
  { value: "other",    label: "Other" },
] as const;

const schema = z.object({
  full_name: z.string().min(1, "Name is required"),
  company:   z.string().optional(),
  customer_id: z.string().optional(),
  relationship: z.string().optional(),
  birthday:    z.string().optional(),
  anniversary: z.string().optional(),
  nickname:    z.string().optional(),
  family:      z.string().optional(),
  title:     z.string().optional(),
  emails:    z.array(z.object({
    value: z.string().email("Enter a valid email").or(z.literal("")),
    label: z.string(),
  })),
  phones:    z.array(z.object({
    value: z.string(),
    label: z.string(),
  })),
  whatsapp:  z.string().optional(),
  linkedin:  z.string().optional(),
  instagram: z.string().optional(),
  facebook:  z.string().optional(),
  twitter:   z.string().optional(),
  website:   z.string().optional(),
  address:   z.string().optional(),
  city:      z.string().optional(),
  tags:      z.string().optional(), // comma-separated in the UI
  notes:     z.string().optional(),
});
type FormData = z.infer<typeof schema>;

/** "" → null so we don't store empty strings; trims everything. */
function clean(v?: string): string | null {
  const t = (v ?? "").trim();
  return t === "" ? null : t;
}

export function ContactForm({
  open, onOpenChange, contact,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Present = edit mode. */
  contact?: Contact | null;
}) {
  const router = useRouter();
  const isEditing = !!contact;
  const create = useCreateContact();
  const update = useUpdateContact();

  const { register, handleSubmit, reset, setValue, watch, control, formState: { errors, isSubmitting } } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: toDefaults(contact),
  });
  const { data: customers = [] } = useCustomers();
  const customerId = watch("customer_id") ?? "";
  const emailFields = useFieldArray({ control, name: "emails" });
  const phoneFields = useFieldArray({ control, name: "phones" });

  // Re-seed the form whenever we open it (new contact vs a different edit target).
  React.useEffect(() => {
    if (open) reset(toDefaults(contact));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, contact?.id]);

  async function onSubmit(data: FormData) {
    const values: ContactFormValues = {
      full_name: data.full_name.trim(),
      company:   clean(data.company),
      customer_id: clean(data.customer_id),
      relationship: clean(data.relationship),
      birthday:    clean(data.birthday),
      anniversary: clean(data.anniversary),
      nickname:    clean(data.nickname),
      family:      clean(data.family),
      title:     clean(data.title),
      // Arrays go through as-is; the mutation cleans blanks + mirrors index 0
      // into the primary email/phone columns.
      emails:    data.emails.map((e) => ({ value: e.value.trim(), label: e.label })),
      phones:    data.phones.map((p) => ({ value: p.value.trim(), label: p.label })),
      whatsapp:  clean(data.whatsapp),
      linkedin:  clean(data.linkedin),
      instagram: clean(data.instagram),
      facebook:  clean(data.facebook),
      twitter:   clean(data.twitter),
      website:   clean(data.website),
      address:   clean(data.address),
      city:      clean(data.city),
      notes:     clean(data.notes),
      tags: (data.tags ?? "")
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
    };

    try {
      if (isEditing && contact) {
        await update.mutateAsync({ id: contact.id, values });
        toast.success("Contact updated");
        onOpenChange(false);
      } else {
        const id = await create.mutateAsync(values);
        toast.success("Contact added");
        onOpenChange(false);
        router.push(`/contacts/${id}` as never);
      }
    } catch {
      /* hook surfaces the error toast */
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-[520px] md:max-w-[600px] p-0 flex flex-col overflow-x-hidden">
        <SheetHeader className="min-w-0">
          <SheetTitle className="break-words">{isEditing ? "Edit contact" : "Add a contact"}</SheetTitle>
          <SheetDescription className="break-words">
            {isEditing
              ? `Update ${contact?.full_name}'s details.`
              : "Save a person you want to reach — email, social, and where to meet them."}
          </SheetDescription>
        </SheetHeader>

        <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col flex-1 min-h-0 w-full">
          <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-5">

            {/* Identity */}
            <Section title="Who">
              <FormField label="Full name" required htmlFor="full_name">
                <Input id="full_name" autoFocus placeholder="e.g. Rajesh Kumar" error={errors.full_name?.message} {...register("full_name")} />
              </FormField>

              {/* Link to a customer company — surfaces that company's full records
                  (invoices, subscriptions, projects, dues) on the contact page.
                  Selecting one also fills the free-text Company below. */}
              <FormField label="Link to a company" htmlFor="customer_id">
                <CustomerCombobox
                  id="customer_id"
                  value={customerId}
                  placeholder="Not linked — search your customers…"
                  onChange={(id) => {
                    setValue("customer_id", id, { shouldDirty: true });
                    const c = customers.find((x) => x.id === id);
                    // Auto-fill the display company name when linking; clearing the
                    // link leaves the typed company text untouched.
                    if (c) setValue("company", c.name, { shouldDirty: true });
                  }}
                />
                <p className="text-[11px] text-ink-3">Connect this person to a customer to manage their company&apos;s records here.</p>
              </FormField>

              {/* Relationship type — lets a person who is neither a lead nor a
                  customer (partner, vendor, personal/relation) be kept + filtered
                  in the contact book. */}
              <FormField label="Relationship" htmlFor="relationship">
                <select
                  id="relationship"
                  {...register("relationship")}
                  className="h-9 w-full rounded-md border border-hairline bg-paper px-2.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-amber/40"
                >
                  {RELATIONSHIP_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
                <p className="text-[11px] text-ink-3">How you know this person — used to group them in Contacts.</p>
              </FormField>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <FormField label="Company">
                  <Input placeholder="e.g. Acme Corp" {...register("company")} />
                </FormField>
                <FormField label="Designation"><Input placeholder="e.g. Founder / IT Head" {...register("title")} /></FormField>
              </div>
            </Section>

            {/* Reach — emails + phones are repeatable (a contact can have office +
                personal). First entry is the primary used across the app. */}
            <Section title="How to reach">
              {/* Emails */}
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-ink-2">Email{emailFields.fields.length > 1 ? "s" : ""}</label>
                {emailFields.fields.map((f, i) => (
                  <div key={f.id} className="flex items-start gap-2">
                    <div className="flex-1 min-w-0">
                      <Input type="email" placeholder="e.g. rajesh@acme.com" error={errors.emails?.[i]?.value?.message} {...register(`emails.${i}.value`)} />
                    </div>
                    <select
                      {...register(`emails.${i}.label`)}
                      className="h-9 shrink-0 rounded-md border border-hairline bg-paper px-2 text-sm text-ink-2 focus:outline-none focus:ring-2 focus:ring-amber/40"
                    >
                      {EMAIL_LABELS.map((l) => <option key={l} value={l}>{l}</option>)}
                    </select>
                    {emailFields.fields.length > 1 && (
                      <button type="button" onClick={() => emailFields.remove(i)} aria-label="Remove email" className="h-9 w-9 shrink-0 grid place-items-center rounded-md text-ink-3 hover:text-rose hover:bg-paper-2">
                        <Icon name="x" size={15} />
                      </button>
                    )}
                  </div>
                ))}
                <button type="button" onClick={() => emailFields.append({ value: "", label: "work" })} className="inline-flex items-center gap-1 text-xs font-medium text-amber-ink hover:text-amber">
                  <Icon name="plus" size={13} /> Add email
                </button>
              </div>

              {/* Phones */}
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-ink-2">Phone{phoneFields.fields.length > 1 ? "s" : ""}</label>
                {phoneFields.fields.map((f, i) => (
                  <div key={f.id} className="flex items-start gap-2">
                    <div className="flex-1 min-w-0">
                      <Input placeholder="e.g. +91 98765 43210" {...register(`phones.${i}.value`)} />
                    </div>
                    <select
                      {...register(`phones.${i}.label`)}
                      className="h-9 shrink-0 rounded-md border border-hairline bg-paper px-2 text-sm text-ink-2 focus:outline-none focus:ring-2 focus:ring-amber/40"
                    >
                      {PHONE_LABELS.map((l) => <option key={l} value={l}>{l}</option>)}
                    </select>
                    {phoneFields.fields.length > 1 && (
                      <button type="button" onClick={() => phoneFields.remove(i)} aria-label="Remove phone" className="h-9 w-9 shrink-0 grid place-items-center rounded-md text-ink-3 hover:text-rose hover:bg-paper-2">
                        <Icon name="x" size={15} />
                      </button>
                    )}
                  </div>
                ))}
                <button type="button" onClick={() => phoneFields.append({ value: "", label: "mobile" })} className="inline-flex items-center gap-1 text-xs font-medium text-amber-ink hover:text-amber">
                  <Icon name="plus" size={13} /> Add phone
                </button>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <FormField label="WhatsApp"><Input placeholder="e.g. +91 98765 43210" {...register("whatsapp")} /></FormField>
                <FormField label="Website"><Input placeholder="e.g. acme.com" {...register("website")} /></FormField>
              </div>
            </Section>

            {/* Social — for advertising / outreach */}
            <Section title="Social media">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <FormField label="LinkedIn"><Input placeholder="linkedin.com/in/… or @handle" {...register("linkedin")} /></FormField>
                <FormField label="Instagram"><Input placeholder="@handle" {...register("instagram")} /></FormField>
                <FormField label="Facebook"><Input placeholder="fb.com/… or name" {...register("facebook")} /></FormField>
                <FormField label="X / Twitter"><Input placeholder="@handle" {...register("twitter")} /></FormField>
              </div>
            </Section>

            {/* Location — for meeting in person */}
            <Section title="Where to meet">
              <FormField label="Address"><Textarea rows={2} placeholder="Office / home address" {...register("address")} /></FormField>
              <FormField label="City"><Input placeholder="e.g. Pune" {...register("city")} /></FormField>
            </Section>

            {/* Personal — what you keep about a real relationship (birthday to
                wish them, family context, what you call them). */}
            <Section title="Personal">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <FormField label="Birthday"><Input type="date" {...register("birthday")} /></FormField>
                <FormField label="Anniversary"><Input type="date" {...register("anniversary")} /></FormField>
              </div>
              <FormField label="Nickname"><Input placeholder="e.g. what you call them" {...register("nickname")} /></FormField>
              <FormField label="Family"><Textarea rows={2} placeholder="Spouse, children, relations…" {...register("family")} /></FormField>
            </Section>

            {/* Notes + tags */}
            <Section title="Notes">
              <FormField label="Tags"><Input placeholder="investor, warm, event-2026 (comma separated)" {...register("tags")} /></FormField>
              <FormField label="Notes"><Textarea rows={3} placeholder="How you met, what they care about, next step…" {...register("notes")} /></FormField>
            </Section>
          </div>

          {/* Footer actions */}
          <div className="flex items-center justify-end gap-2 border-t border-hairline px-5 py-3">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={isSubmitting}>Cancel</Button>
            <Button type="submit" variant="primary" icon="check" disabled={isSubmitting}>
              {isSubmitting ? "Saving…" : isEditing ? "Save changes" : "Add contact"}
            </Button>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <Icon name="chevron_down" size={12} className="text-ink-3" />
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">{title}</h3>
      </div>
      {children}
    </section>
  );
}

function toDefaults(c?: Contact | null): FormData {
  // Seed the arrays from the stored arrays; fall back to the legacy single
  // email/phone for contacts created before multi-channel; else one blank row.
  const emails = c?.emails?.length
    ? c.emails
    : c?.email
    ? [{ value: c.email, label: "other" }]
    : [{ value: "", label: "work" }];
  const phones = c?.phones?.length
    ? c.phones
    : c?.phone
    ? [{ value: c.phone, label: "mobile" }]
    : [{ value: "", label: "mobile" }];
  return {
    full_name: c?.full_name ?? "",
    company:   c?.company ?? "",
    customer_id: c?.customer_id ?? "",
    relationship: c?.relationship ?? "",
    birthday:    c?.birthday ?? "",
    anniversary: c?.anniversary ?? "",
    nickname:    c?.nickname ?? "",
    family:      c?.family ?? "",
    title:     c?.title ?? "",
    emails,
    phones,
    whatsapp:  c?.whatsapp ?? "",
    linkedin:  c?.linkedin ?? "",
    instagram: c?.instagram ?? "",
    facebook:  c?.facebook ?? "",
    twitter:   c?.twitter ?? "",
    website:   c?.website ?? "",
    address:   c?.address ?? "",
    city:      c?.city ?? "",
    tags:      (c?.tags ?? []).join(", "),
    notes:     c?.notes ?? "",
  };
}
