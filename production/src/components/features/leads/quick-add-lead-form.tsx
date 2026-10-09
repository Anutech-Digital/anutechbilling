/**
 * QuickAddLeadForm — the fastest way to get a lead in.
 *
 * R-099 (1 Oct 2026, Pardeep: "lead ki entry simplest … world class"):
 *   - ONE thing is enough: a phone, an email or a name (lib/leads/quick-add.ts).
 *     A missed call or a WhatsApp gives you the number first; the name comes later.
 *   - Paste a WhatsApp message / visiting-card text and Smart Paste fills the fields
 *     (it shows what it found before filling — components/shared/smart-paste.tsx).
 *   - Phone first, with the number keypad on a phone.
 *   - "Already exists" warning while typing, with a link to the old lead.
 *   - Enter saves. "Save & add another" keeps the sheet open for a stack of cards.
 *
 * Lead lands in /leads (Inbox) with defaults:
 *   stage = "new", source = "manual", priority = "medium", plan = null.
 *
 * Sibling to the full <AddLeadForm>; same write path (useCreateLead).
 *
 * @example
 *   <QuickAddLeadForm open={open} onOpenChange={setOpen} />
 */
"use client";

import * as React from "react";
import { useRouter, usePathname } from "next/navigation";
import type { Route } from "next";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";

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
import { SmartPaste } from "@/components/shared/smart-paste";
import { useCreateLead, useLeadDuplicateCheck } from "@/lib/queries/leads";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { commitPhone, liveEmail } from "@/lib/forms/poka-yoke";
import { dupCheckKeys, duplicateWarning, pickDuplicate } from "@/lib/leads/duplicate-check";
import { stageShownOnPage } from "@/lib/leads/page-scope";
import { quickAddProblem, quickAddLabel, whatsappNumber, phoneDigits } from "@/lib/leads/quick-add";
import type { Lead } from "@/lib/supabase/database.types";
import { revealSavedLead } from "@/components/features/leads/reveal-saved-lead";

/* Any ONE of phone / email / name is enough — the rule and its reasons live in
   lib/leads/quick-add.ts, so the form and its tests can't drift apart. */
const schema = z
  .object({
    company:       z.string().optional(),
    contact_name:  z.string().optional(),
    contact_email: z.string().optional(),
    contact_phone: z.string().optional(),
  })
  .superRefine((v, ctx) => {
    const problem = quickAddProblem({ name: v.contact_name, phone: v.contact_phone, email: v.contact_email });
    if (!problem) return;
    /* Put the message under the box that has to change. */
    const path = problem.startsWith("That email") ? "contact_email" : "contact_phone";
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem, path: [path] });
  });

type FormData = z.infer<typeof schema>;

interface QuickAddLeadFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function QuickAddLeadForm({ open, onOpenChange }: QuickAddLeadFormProps) {
  const router     = useRouter();
  const pathname   = usePathname();
  const createLead = useCreateLead({ quiet: true });
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
    setFocus,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: { company: "", contact_name: "", contact_email: "", contact_phone: "" },
  });

  // Wipe state on close so the next open is fresh.
  React.useEffect(() => {
    if (!open) reset();
  }, [open, reset]);

  /* Duplicate heads-up while typing — same RPC and wording as the full form. */
  const [wCompany, wPhone, wEmail] = watch(["company", "contact_phone", "contact_email"]);
  const [dupKeys, setDupKeys] = React.useState(() => dupCheckKeys({}));
  React.useEffect(() => {
    const t = setTimeout(() => setDupKeys(dupCheckKeys({ company: wCompany, phone: wPhone, email: wEmail })), 300);
    return () => clearTimeout(t);
  }, [wCompany, wPhone, wEmail]);
  const { data: dupCandidates } = useLeadDuplicateCheck(dupKeys, undefined, open);
  const dupMatch = React.useMemo(() => pickDuplicate(dupCandidates, false), [dupCandidates]);

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
      if (phone) setValue("contact_phone", commitPhone(phone), { shouldDirty: true });
      if (email) setValue("contact_email", email, { shouldDirty: true });
    } catch (err) {
      // User denied permission or browser bailed — silent fall-back to manual entry.
      console.warn("[contacts-picker] failed:", err);
    }
  }, [setValue]);

  /* Which button submitted: "Save" closes, "Save & add another" keeps going. */
  const againRef = React.useRef(false);
  /* In "add another" mode the confirmation lives INSIDE the sheet: a toast sits on top of
     the sheet, and a click on it counts as a click outside — which closes the sheet. */
  const [lastSaved, setLastSaved] = React.useState<{ id: string; label: string; wa: string | null } | null>(null);
  React.useEffect(() => {
    if (!open) setLastSaved(null);
  }, [open]);

  const onSubmit = async (data: FormData) => {
    const again = againRef.current;
    againRef.current = false;
    const name  = data.contact_name?.trim()  || null;
    const email = data.contact_email?.trim() || null;
    const phone = data.contact_phone?.trim() ? commitPhone(data.contact_phone.trim()) : null;
    try {
      const id = "L-" + Date.now().toString(36).toUpperCase();
      await createLead.mutateAsync({
        id,
        /* `leads.company` DB me NOT NULL hai, aur form use optional maanta hai.
           Isliye yahan khaali string — wahi shakl jo inbound raasta pehle se likhta hai
           (inbound-email/route.ts:130), taaki dono taraf se aayi lead ek jaisi dikhe. */
        company:        data.company?.trim() ?? "",
        contact_name:   name,
        contact_email:  email,
        contact_phone:  phone,
        stage:          "new",
        source:         "manual",
        priority:       "medium",
        /* R-442: undefined (not null) when the user is not loaded yet, so useCreateLead
           fills in whoever is signed in — null would mean "Unassigned on purpose". */
        owner_id:       me?.userId || undefined,
        /* WHO ADDED IT, which owner_id stops answering the moment somebody reassigns. */
        created_by:     me?.userId || null,
      });

      const label = quickAddLabel({ name, company: data.company, phone, email });
      const wa = whatsappNumber(phone);
      if (again) {
        setLastSaved({ id, label, wa });
        reset();
        setDupKeys(dupCheckKeys({}));
        setTimeout(() => setFocus("contact_phone"), 0);
        return;
      }
      onOpenChange(false);
      /* R-208: confirm the save AND put the new lead in front of the user — on /leads its
         drawer opens; the list's default "needs action" order would bury it under overdue rows. */
      revealSavedLead({
        id,
        title: `${label} added to your leads`,
        description: name ? "Add plan and seats later from the lead." : "Add the name later from the lead.",
        isDeal: false,
        pathname,
        router,
        cancel: wa ? { label: "WhatsApp", onClick: () => window.open(`https://wa.me/${wa}`, "_blank", "noopener") } : undefined,
      });
    } catch {
      // Error toast handled inside useCreateLead.onError
    }
  };

  const busy = isSubmitting || createLead.isPending;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
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
            A phone number is enough. Add the rest later.
          </SheetDescription>
        </SheetHeader>

        <form
          onSubmit={handleSubmit(onSubmit)}
          className="flex flex-col flex-1 min-h-0 min-w-0 w-full"
        >
          <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-4">
          {lastSaved && (
            <div role="status" className="rounded-md bg-emerald-soft border border-emerald/30 px-3 py-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-emerald-ink min-w-0">
              <span className="inline-flex items-center gap-1.5 min-w-0 break-words">
                <Icon name="check" size={13} className="flex-shrink-0" />
                <b>{lastSaved.label}</b> saved. Next one:
              </span>
              <span className="ml-auto inline-flex gap-3">
                {lastSaved.wa && (
                  <a href={`https://wa.me/${lastSaved.wa}`} target="_blank" rel="noopener noreferrer" className="font-semibold underline underline-offset-2">
                    WhatsApp
                  </a>
                )}
                <button
                  type="button"
                  onClick={() => { onOpenChange(false); router.push(`/leads?lead=${lastSaved.id}` as Route); }}
                  className="font-semibold underline underline-offset-2"
                >
                  Open
                </button>
              </span>
            </div>
          )}

          {/* Paste a WhatsApp message / card text — fills only what it finds,
              after showing it (smart-paste.tsx). No catalogue: quick add has no plan. */}
          <SmartPaste
            catalogue={[]}
            contactOnly
            onFill={(v) => {
              if (v.name)  setValue("contact_name",  v.name,  { shouldDirty: true });
              if (v.email) setValue("contact_email", liveEmail(v.email), { shouldDirty: true });
              if (v.phone) setValue("contact_phone", commitPhone(v.phone), { shouldDirty: true });
            }}
          />

          {/* Contacts Picker — Android PWA only */}
          {contactsApiAvailable && (
            <div className="rounded-md bg-indigo-50 border border-indigo/20 px-3 py-2.5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 sm:gap-3 min-w-0">
              <p className="text-xs text-indigo-ink inline-flex items-start gap-2 min-w-0 leading-snug">
                <Icon name="mobile" size={13} className="flex-shrink-0 mt-0.5" />
                <span>Add from your phonebook.</span>
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

          {/* Phone first — it is what a rep usually has. Number keypad on phones. */}
          <FormField label="Phone" htmlFor="q-contact-phone">
            <Input
              id="q-contact-phone"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              autoFocus
              placeholder="e.g. 98765 43210"
              error={errors.contact_phone?.message}
              {...register("contact_phone", {
                onBlur: (e) => {
                  const v = String(e.target.value ?? "").trim();
                  if (phoneDigits(v).length >= 10) setValue("contact_phone", commitPhone(v));
                },
              })}
            />
          </FormField>

          <FormField label="Name" htmlFor="q-contact-name">
            <Input
              id="q-contact-name"
              autoComplete="name"
              placeholder="e.g. Rajesh K"
              error={errors.contact_name?.message}
              {...register("contact_name")}
            />
          </FormField>

          {/* Already in the system? Non-blocking — offer the old lead instead. */}
          {dupMatch && (
            <div className="rounded-md bg-amber-soft/60 border border-amber/30 px-3 py-2.5 flex items-start gap-2 min-w-0">
              <Icon name="copy" size={14} className="text-amber-ink flex-shrink-0 mt-0.5" />
              <div className="min-w-0 flex-1 text-xs text-amber-ink leading-snug">
                <b>{duplicateWarning(dupMatch).title}</b>
                {" · "}{duplicateWarning(dupMatch).matched}. You can still save.
                <button
                  type="button"
                  onClick={() => {
                    onOpenChange(false);
                    /* Won leads live on /deals only (page-scope.ts). */
                    const page = stageShownOnPage(dupMatch.stage as Lead["stage"], false) ? "/leads" : "/deals";
                    router.push(`${page}?lead=${dupMatch.id}` as Route);
                  }}
                  className="ml-1.5 font-semibold underline underline-offset-2 hover:text-amber"
                >
                  Open existing lead
                </button>
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <FormField label="Company" htmlFor="q-company">
              <Input
                id="q-company"
                autoComplete="organization"
                placeholder="Optional"
                {...register("company")}
              />
            </FormField>
            <FormField label="Email" htmlFor="q-contact-email">
              <Input
                id="q-contact-email"
                type="email"
                inputMode="email"
                autoComplete="email"
                placeholder="Optional"
                error={errors.contact_email?.message}
                {...register("contact_email")}
              />
            </FormField>
          </div>

          <p className="text-xs text-ink-3 -mt-1">
            Saved as <span className="font-semibold text-ink-2">New</span> in your leads.
            Press Enter to save.
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
            {/* type="button": Enter in a box submits with the FIRST submit button, and
                Enter should be plain "Save lead" — the hint under the form says so. */}
            <Button
              type="button"
              variant="default"
              disabled={busy}
              onClick={() => { againRef.current = true; void handleSubmit(onSubmit)(); }}
            >
              Save &amp; add another
            </Button>
            <Button
              type="submit"
              variant="primary"
              loading={busy}
              onClick={() => { againRef.current = false; }}
            >
              Save lead
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}
