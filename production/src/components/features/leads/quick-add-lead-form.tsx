/**
 * QuickAddLeadForm — minimal 4-field lead capture.
 *
 * Optimised for "in-the-moment" mobile capture: sales rep meets someone,
 * jots their card down at a counter, in a cab, mid-conversation. They
 * don't want to fill plan/seats/value/priority/source/owner/notes — they
 * just want the name + how to reach them, save, move on. Qualify later
 * via the lead detail drawer.
 *
 * Fields: Company, Contact name, Email, Phone — that's it.
 *
 * Lead lands in /leads (Inbox) with defaults:
 *   stage = "new", source = "manual", priority = "medium", plan = null.
 *
 * Sibling to the full <AddLeadForm>. They share the same Supabase write
 * path (useCreateLead) so list refresh + toast behaviour is consistent.
 *
 * Surfaced via the "+ Quick" button next to Filter on the Leads page.
 * The full FAB + header "Add lead" buttons continue to open the full
 * form for users who want to qualify upfront.
 *
 * Auto-imports Contacts Picker (Android Chrome / Edge mobile only) so
 * the rep can tap into their phonebook instead of typing the card.
 *
 * @example
 *   <QuickAddLeadForm open={open} onOpenChange={setOpen} />
 */
"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import type { Route } from "next";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";

import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { useCreateLead } from "@/lib/queries/leads";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";

const schema = z.object({
  company:       z.string().min(2, "Company name is required"),
  contact_name:  z.string().optional(),
  contact_email: z.string().email("Invalid email").optional().or(z.literal("")),
  contact_phone: z.string().optional(),
});

type FormData = z.infer<typeof schema>;

interface QuickAddLeadFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function QuickAddLeadForm({ open, onOpenChange }: QuickAddLeadFormProps) {
  const router     = useRouter();
  const createLead = useCreateLead();
  const { data: me } = useCurrentUser();

  // Contacts Picker API support — Android Chrome / Edge mobile only.
  // Spec: https://w3c.github.io/contact-picker/
  const [contactsApiAvailable, setContactsApiAvailable] = React.useState(false);
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    setContactsApiAvailable(
      // @ts-expect-error — Contacts Picker not in lib.dom.d.ts yet
      Boolean(navigator.contacts && typeof navigator.contacts.select === "function" && window.ContactsManager),
    );
  }, []);

  const {
    register,
    handleSubmit,
    reset,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: { company: "", contact_name: "", contact_email: "", contact_phone: "" },
  });

  // Wipe state on close so the next open is fresh.
  React.useEffect(() => {
    if (!open) reset();
  }, [open, reset]);

  /** Native Contacts Picker — autofill name + phone + email. */
  const pickContact = React.useCallback(async () => {
    try {
      const props = ["name", "tel", "email"] as const;
      // @ts-expect-error — Contacts Picker not in lib.dom.d.ts yet
      const contacts = await navigator.contacts.select(props, { multiple: false }) as Array<{
        name?:  string[];
        tel?:   string[];
        email?: string[];
      }>;
      if (!contacts || contacts.length === 0) return;

      const c     = contacts[0];
      const name  = c.name?.[0]  ?? "";
      const phone = c.tel?.[0]   ?? "";
      const email = c.email?.[0] ?? "";

      if (name)  setValue("contact_name",  name,  { shouldDirty: true });
      if (phone) setValue("contact_phone", phone, { shouldDirty: true });
      if (email) setValue("contact_email", email, { shouldDirty: true });
    } catch (err) {
      // User denied permission or browser bailed — silent fall-back to manual entry.
      console.warn("[contacts-picker] failed:", err);
    }
  }, [setValue]);

  const onSubmit = async (data: FormData) => {
    try {
      const id = "L-" + Date.now().toString(36).toUpperCase();
      // Minimal payload. Plan/seats/value omitted — lands in Lead Inbox
      // as a raw lead awaiting qualification.
      await createLead.mutateAsync({
        id,
        company:        data.company,
        contact_name:   data.contact_name  || null,
        contact_email:  data.contact_email || null,
        contact_phone:  data.contact_phone || null,
        stage:          "new",
        source:         "manual",
        priority:       "medium",
        owner_id:       me?.userId || null,
      });

      toast.dismiss();
      toast.success(`${data.company} added to your inbox`, {
        description: "Qualify it later with plan + seats from the lead drawer",
        duration: 5000,
        action: {
          label: "View leads",
          onClick: () => router.push("/leads" as Route),
        },
      });

      onOpenChange(false);
    } catch {
      // Error toast handled inside useCreateLead.onError
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      {/* Slide-in drawer from the right — same pattern as full Add Lead form,
          but narrower (440px) since this is only 4 fields. */}
      <SheetContent
        side="right"
        className="w-full sm:max-w-[440px] md:max-w-[480px] p-0 flex flex-col overflow-x-hidden"
      >
        <SheetHeader className="min-w-0">
          <SheetTitle className="break-words inline-flex items-center gap-2">
            <Icon name="zap" size={18} className="text-amber" />
            Quick add lead
          </SheetTitle>
          <SheetDescription className="break-words">
            4 fields. Just the basics — qualify later from the lead drawer.
          </SheetDescription>
        </SheetHeader>

        <form
          onSubmit={handleSubmit(onSubmit)}
          className="flex flex-col flex-1 min-h-0 min-w-0 w-full"
        >
          <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-4">
          {/* Company */}
          <FormField label="Company name" required htmlFor="q-company">
            <Input
              id="q-company"
              autoFocus
              placeholder="e.g. Acme Corp Pvt Ltd"
              error={errors.company?.message}
              {...register("company")}
            />
          </FormField>

          {/* Contacts Picker — Android PWA only */}
          {contactsApiAvailable && (
            <div className="rounded-md bg-indigo-50 border border-indigo/20 px-3 py-2.5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 sm:gap-3 min-w-0">
              <p className="text-xs text-indigo-ink inline-flex items-start gap-2 min-w-0 leading-snug">
                <Icon name="mobile" size={13} className="flex-shrink-0 mt-0.5" />
                <span>Phonebook se direct add karo.</span>
              </p>
              <Button
                type="button"
                variant="default"
                size="sm"
                icon="user"
                onClick={pickContact}
                className="sm:shrink-0 w-full sm:w-auto justify-center"
              >
                Pick from contacts
              </Button>
            </div>
          )}

          {/* Contact name */}
          <FormField label="Contact name" htmlFor="q-contact-name">
            <Input
              id="q-contact-name"
              placeholder="e.g. Rajesh K"
              {...register("contact_name")}
            />
          </FormField>

          {/* Email + Phone */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <FormField label="Email" htmlFor="q-contact-email">
              <Input
                id="q-contact-email"
                type="email"
                placeholder="e.g. rajesh@acme.com"
                error={errors.contact_email?.message}
                {...register("contact_email")}
              />
            </FormField>
            <FormField label="Phone" htmlFor="q-contact-phone">
              <Input
                id="q-contact-phone"
                type="tel"
                inputMode="tel"
                placeholder="e.g. +91 98765 43210"
                {...register("contact_phone")}
              />
            </FormField>
          </div>

          <p className="text-[11px] text-ink-3 -mt-1">
            Lead lands in your Inbox as <span className="font-semibold text-ink-2">New</span>,
            priority <span className="font-semibold text-ink-2">Medium</span>. Pick plan + seats
            later to promote it to a deal.
          </p>
          </div>  {/* close scrollable form body */}

          <SheetFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              loading={isSubmitting || createLead.isPending}
            >
              Save lead
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}
