/**
 * CustomerFormPage — the full-width, Zoho-style customer form used by the
 * dedicated routes `/customers/new` and `/customers/[id]/edit`.
 *
 * Better-than-Zoho moves baked in here:
 *   • Country-first — the region picker sits above everything and re-shapes the
 *     whole form (India = GST flow, elsewhere = zero-rated export flow), with a
 *     live status banner so the reseller SEES the tax treatment before saving.
 *   • One-click GSTIN → legal name / address / state / PIN auto-fill.
 *   • Tabs (Details · Address · Contacts) with label-left / field-right rows, so
 *     a long form reads like a settings page instead of an endless scroll.
 *   • "Shipping same as billing" — one checkbox instead of retyping the address.
 *
 * All logic is shared with the side-sheet via {@link useCustomerForm}; this file
 * is presentation only.
 */
"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button, IconButton } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Checkbox } from "@/components/ui/checkbox";
import { TabBar } from "@/components/ui/tabs";
import { GST_STATE_BY_CODE, cn } from "@/lib/utils";
import { FieldPill } from "@/components/ui/field-pill";
import { SmartPaste } from "@/components/shared/smart-paste";
import {
  liveGstin, checkGstin, livePhone, commitPhone, checkPhone,
  liveEmail, checkEmail, liveDomain, checkDomain, gstinState,
} from "@/lib/forms/poka-yoke";
import GstinVerifyCard from "@/components/features/gstin/gstin-verify-card";
import { COUNTRIES } from "@/lib/gst/countries";
import { GST_STATE_OPTIONS } from "@/lib/gst/gstin-state";
import { useCustomerForm } from "./use-customer-form";
import { ScanCardPanel } from "./scan-card-panel";
import { ContactPersonsTable } from "./contact-persons-table";
import { GroupFormDialog } from "./group-form-dialog";
import { useCustomerGroups } from "@/lib/queries/customer-groups";
import type { Customer } from "@/lib/supabase/database.types";

const selectClass =
  "w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-amber/40";

/** Label-left / field-right row (Zoho parity). Stacks on mobile. */
function Row({
  label, htmlFor, required, hint, children,
}: {
  label: string; htmlFor?: string; required?: boolean; hint?: string; children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-[190px_minmax(0,1fr)] gap-1.5 md:gap-5 md:items-start py-3.5 border-b border-hairline/50 last:border-b-0">
      <div className="md:pt-2">
        <Label htmlFor={htmlFor} required={required}>{label}</Label>
        {hint && <p className="text-2xs leading-snug text-ink-3 mt-1">{hint}</p>}
      </div>
      <div className="max-w-xl">{children}</div>
    </div>
  );
}

/**
 * One line on the Review tab.
 *
 * An unset field SAYS "not set" rather than leaving a gap — a blank row reads as a
 * rendering fault and an operator cannot tell it apart from a value that failed to load.
 */
function ReviewLine({ label, value, mono, note }: {
  label: string; value?: string | null; mono?: boolean; note?: string;
}) {
  const v = (value ?? "").trim();
  return (
    <div className="min-w-0">
      <dt className="text-3xs uppercase tracking-wider text-ink-3">{label}</dt>
      {v ? (
        <dd className={cn("break-words text-[13px] font-medium text-ink", mono && "font-mono")}>
          {v}{note && <span className="ml-1 font-sans text-2xs font-normal text-ink-3">· {note}</span>}
        </dd>
      ) : (
        <dd className="text-[12px] italic text-ink-3">not set</dd>
      )}
    </div>
  );
}

interface CustomerFormPageProps {
  /** Provided → edit mode. Omitted → create mode. */
  customer?: Customer | null;
}

type TabId = "other" | "address" | "contacts" | "review";

export function CustomerFormPage({ customer }: CustomerFormPageProps) {
  const router = useRouter();
  const [tab, setTab] = React.useState<TabId>("other");
  const {
    register, setValue, watch, errors, isSubmitting, isPending, isEdit,
    contactPersonFields, appendContactPerson, removeContactPerson,
    verification, setVerification, watchedGstin,
    isForeign, foreignStates, countryReg, onCountryChange, submit,
  } = useCustomerForm({
    customer,
    onSaved: (id) => router.push(`/customers/${id}` as never),
  });

  // Parent account / group picker — links this company to a common reseller.
  const { data: customerGroups } = useCustomerGroups();
  const [groupDialogOpen, setGroupDialogOpen] = React.useState(false);

  // "Shipping same as billing" — default ON, but OFF when editing a customer
  // who already has a distinct shipping address (so we don't hide their data).
  const [sameAsBilling, setSameAsBilling] = React.useState(true);
  React.useEffect(() => {
    setSameAsBilling(!customer?.shipping_address);
  }, [customer]);
  const toggleSameAsBilling = (checked: boolean) => {
    setSameAsBilling(checked);
    if (checked) {
      // Clear shipping so the invoice cleanly falls back to the billing address.
      (["attention", "address", "city", "state", "zip", "country"] as const)
        .forEach((k) => setValue(`shipping.${k}`, "", { shouldDirty: true }));
    }
  };

  // Promote an "other contact" to the primary slot. We SWAP — the old primary
  // becomes an other-contact row so nothing is lost (unless it was empty, in
  // which case we just drop the now-blank row). Note the primary uses
  // `contact_title` for the designation; the row uses `designation`.
  const makePrimary = (i: number) => {
    const p = watch(`contact_persons.${i}`) ?? {};
    const prev = {
      salutation:  watch("contact_salutation") ?? "",
      first_name:  watch("contact_first_name") ?? "",
      last_name:   watch("contact_last_name")  ?? "",
      email:       watch("contact_email")      ?? "",
      phone:       watch("contact_phone")      ?? "",
      mobile:      watch("contact_mobile")     ?? "",
      designation: watch("contact_title")      ?? "",
    };
    const opts = { shouldDirty: true } as const;
    setValue("contact_salutation", p.salutation  ?? "", opts);
    setValue("contact_first_name", p.first_name  ?? "", opts);
    setValue("contact_last_name",  p.last_name   ?? "", opts);
    setValue("contact_email",      p.email       ?? "", opts);
    setValue("contact_phone",      p.phone       ?? "", opts);
    setValue("contact_mobile",     p.mobile      ?? "", opts);
    setValue("contact_title",      p.designation ?? "", opts);

    const prevEmpty = !Object.values(prev).some((v) => v && v.trim());
    if (prevEmpty) {
      removeContactPerson(i);
    } else {
      setValue(`contact_persons.${i}`, prev, opts);
    }
    toast.success(`${p.first_name || "Contact"} is now the primary contact`);
  };

  const companyName = watch("name");
  const customerType = watch("customer_type") ?? "business";
  const isIndividual = customerType === "individual";

  // Display-name suggestions (Zoho-style) built live from the contact + company.
  const dnFirst = watch("contact_first_name")?.trim();
  const dnLast = watch("contact_last_name")?.trim();
  const displayNameSuggestions = Array.from(new Set([
    [dnFirst, dnLast].filter(Boolean).join(" "),
    dnFirst && dnLast ? `${dnLast}, ${dnFirst}` : "",
    !isIndividual ? companyName?.trim() : "",
  ].filter((s): s is string => !!s)));

  // Switching type flips who the customer IS, so refresh the display name to the
  // sensible default for the new type (person for individual, company for
  // business) — otherwise a stale company name lingers on an individual.
  const changeCustomerType = (val: "business" | "individual") => {
    setValue("customer_type", val, { shouldDirty: true, shouldValidate: true });
    const person = [watch("contact_first_name")?.trim(), watch("contact_last_name")?.trim()].filter(Boolean).join(" ");
    const company = watch("name")?.trim() ?? "";
    setValue("display_name", val === "individual" ? person : company, { shouldDirty: true });
  };

  const cancel = () => router.push((isEdit && customer ? `/customers/${customer.id}` : "/customers") as never);

  // Company / GSTIN / email errors live in the always-visible essentials block,
  // so they need no tab dot. Only the tabbed secondary fields do.
  const addressHasError = !!errors.pin_code || !!errors.state;
  /* R-173: a missing state blocks Save — open the tab it lives on so the reason is in view. */
  React.useEffect(() => { if (errors.state) setTab("address"); }, [errors.state]);
  const contactsHasError = !!errors.contact_persons;

  const saveButton = (
    <Button type="submit" variant="primary" icon="check" loading={isSubmitting || isPending}>
      {isEdit ? "Save changes" : "Save customer"}
    </Button>
  );

  return (
    <div className="max-w-[1080px] mx-auto p-4 md:p-6 lg:p-8 pb-24">
      <form onSubmit={submit}>
        {/* ── Header ── */}
        <div className="flex items-start justify-between gap-4 mb-6">
          <div className="flex items-start gap-3 min-w-0">
            <IconButton icon="arrow_left" aria-label="Back" onClick={cancel} />
            <div className="min-w-0">
              <h1 className="font-serif text-2xl text-ink leading-tight truncate">
                {isEdit
                  ? (watch("display_name")?.trim() || companyName?.trim() || [dnFirst, dnLast].filter(Boolean).join(" ") || "Edit customer")
                  : "New customer"}
              </h1>
              <p className="text-sm text-ink-3 mt-0.5">
                {isEdit
                  ? "Update this customer's billing, address and contact details."
                  : "Company = the customer you invoice. Pick the region first — it sets the tax treatment."}
              </p>
            </div>
          </div>
          <div className="hidden sm:flex items-center gap-2 flex-shrink-0">
            <Button type="button" variant="ghost" onClick={cancel}>Cancel</Button>
            {saveButton}
          </div>
        </div>

        {/* Scan a card / paste a signature. Create mode only — on an edit the
            record is already correct and a fresh scan would overwrite a
            corrected field with a guess. Fills nothing that decides tax: state,
            state_code and country come from the verified GSTIN below. */}
        {/* ── Paste the message instead of retyping it ─────────────────────────
            The twin of Scan-a-card, for the far commoner case: the details arrived
            as WhatsApp text, not as a photograph of a visiting card.

            Create mode only, for the same reason as the scanner — on an edit it
            would overwrite the field the operator opened this page to correct.

            It fills only what the extractor actually FOUND, and shows the whole list
            before filling anything. Nothing here decides tax: state, state_code and
            country come from the verified GSTIN below, never from pasted prose. */}
        {!isEdit && (
          <div className="mb-3">
            <SmartPaste
              catalogue={[]}
              onFill={(v) => {
                const opts = { shouldDirty: true } as const;
                if (v.name)   setValue("contact_name",  v.name, opts);
                if (v.email)  setValue("contact_email", liveEmail(v.email), opts);
                if (v.phone)  setValue("contact_phone", commitPhone(v.phone), opts);
                /* The honest half of "company": the DOMAIN. The name is not derivable
                   from an address and the one that lands on a tax invoice is a legal
                   fact — the GSTIN lookup fills that properly. */
                if (v.domain) setValue("domain",        v.domain, opts);
                toast.success("Filled from the pasted text.", {
                  description: "Check each field before saving — anything it could not read is still blank.",
                });
              }}
            />
          </div>
        )}

        {!isEdit && (
          <div className="mb-5">
            <ScanCardPanel
              onFields={(f) => {
                const opts = { shouldDirty: true } as const;
                // Only write what was actually read — a null must never wipe a
                // field the operator has already typed.
                if (f.name)           setValue("name",           f.name, opts);
                if (f.contact_name)   setValue("contact_name",   f.contact_name, opts);
                if (f.contact_title)  setValue("contact_title",  f.contact_title, opts);
                if (f.contact_email)  setValue("contact_email",  f.contact_email, opts);
                if (f.contact_phone)  setValue("contact_phone",  f.contact_phone, opts);
                if (f.contact_mobile) setValue("contact_mobile", f.contact_mobile, opts);
                if (f.address)        setValue("address",        f.address, opts);
                if (f.city)           setValue("city",           f.city, opts);
                if (f.pin_code)       setValue("pin_code",       f.pin_code, opts);
                if (f.domain)         setValue("domain",         f.domain, opts);
                // Checksum-validated already; the form still verifies with GSTN.
                if (f.gstin)          setValue("gstin",          f.gstin, opts);
              }}
            />
          </div>
        )}

        {/* ── Country-first + live tax-treatment banner (better-than-Zoho) ── */}
        <div className="rounded-xl border border-hairline bg-paper-2/40 p-4 md:p-5 mb-5">
          <div className="grid grid-cols-1 md:grid-cols-[190px_minmax(0,1fr)] gap-1.5 md:gap-5 md:items-center">
            <Label htmlFor="country" required>Customer region</Label>
            <div className="max-w-xl">
              <select id="country" className={selectClass} {...countryReg} onChange={onCountryChange}>
                {COUNTRIES.map((ctry) => <option key={ctry} value={ctry}>{ctry}</option>)}
              </select>
            </div>
          </div>
          <div className="mt-3 md:pl-[210px]">
            {isForeign ? (
              <p className="flex items-start gap-2 text-[12px] leading-snug text-indigo-ink">
                <Icon name="globe" size={14} className="mt-0.5 flex-shrink-0" />
                <span>
                  <b>Export customer.</b> Supplies are <b>zero-rated</b> (no CGST/SGST/IGST) under LUT.
                  The invoice carries the export declaration instead of a tax split, and defaults to USD.
                </span>
              </p>
            ) : (
              <p className="flex items-start gap-2 text-[12px] leading-snug text-ink-3">
                <Icon name="info" size={14} className="mt-0.5 flex-shrink-0" />
                <span>
                  <b className="text-ink-2">Domestic (India) — GST applies.</b> Add the GSTIN below to verify
                  with GSTN and auto-fill the legal name, address and place of supply.
                </span>
              </p>
            )}
          </div>
        </div>

        {/* ── Essentials (ALWAYS visible) — everything you need to create a
            customer: who they are + how to reach them. Kept out of the tabs so
            the primary contact / email / phone are never a click away. ── */}
        <section className="mb-7">
          <input type="hidden" {...register("customer_type")} />
          <Row label="Customer type" hint="Individual = a person, no company.">
            <div className="inline-flex rounded-lg border border-hairline bg-paper-2/40 p-0.5">
              {([["business", "Business"], ["individual", "Individual"]] as const).map(([val, label]) => (
                <button
                  key={val}
                  type="button"
                  onClick={() => changeCustomerType(val)}
                  className={cn(
                    "px-4 py-1.5 text-sm rounded-md transition-colors",
                    customerType === val ? "bg-paper shadow-sm text-ink font-medium" : "text-ink-3 hover:text-ink",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </Row>

          {!isForeign && !isIndividual && (
            <Row label="GSTIN" htmlFor="gstin" hint="Verify to auto-fill legal name, address & place of supply.">
              <Input
                id="gstin"
                placeholder="e.g. 07ABDCA0298H1ZP"
                /* The uppercase CLASS only changed how it looked; the stored value stayed
                   lower-case, and a lower-case GSTIN fails the checksum that decides the
                   tax head. liveGstin fixes the value itself, on every keystroke. */
                className="font-mono"
                error={errors.gstin?.message}
                {...register("gstin")}
                onChange={(e) => setValue("gstin", liveGstin(e.target.value), { shouldDirty: true })}
              />
              {/* One shared, tested rule instead of two hand-written branches — and it
                  names the STATE, which is the fact about to decide IGST vs CGST+SGST.
                  Seeing "Delhi" where you expected Haryana catches a wrong paste before
                  it becomes a tax head. */}
              <FieldPill check={checkGstin(watchedGstin ?? "")} />
              <div className="mt-2">
                <GstinVerifyCard
                  gstin={watchedGstin ?? ""}
                  cached={verification}
                  cachedAt={null}
                  noPersist
                  onVerified={(v) => setVerification(v)}
                  onFillForm={(v) => {
                    if (v.legal_name)                  setValue("name",     v.legal_name,                 { shouldDirty: true, shouldValidate: true });
                    if (v.address)                     setValue("address",  v.address,                    { shouldDirty: true, shouldValidate: true });
                    if (v.principal_address?.pin_code) setValue("pin_code", v.principal_address.pin_code, { shouldDirty: true, shouldValidate: true });
                    if (v.state_code) {
                      setValue("state_code", v.state_code, { shouldDirty: true, shouldValidate: true });
                      const name = GST_STATE_BY_CODE[v.state_code];
                      if (name) setValue("state", name, { shouldDirty: true, shouldValidate: true });
                    }
                  }}
                />
              </div>
            </Row>
          )}

          <input type="hidden" {...register("state_code")} />

          {!isIndividual && (
            <Row label="Company name" htmlFor="name" required hint="The business you invoice.">
              <Input id="name" placeholder="e.g. Acme Corp Pvt Ltd" error={errors.name?.message} {...register("name")} />
            </Row>
          )}

          <Row
            label={isIndividual ? "Name" : "Primary contact"}
            htmlFor="contact_first_name"
            /* Required on CREATE for everyone, not just individuals. A business customer
               needs a named human too — they are who receives its invoices and payment
               reminders (Abhishek, 18 Sep 2026: "without contact customer not created").
               Editing an existing customer is NOT blocked: customers already on the books
               predate the rule, and locking the operator out of the page would lock them
               out of the very field that fixes it. */
            required={isIndividual || !isEdit}
            hint={isIndividual ? "This person is the customer." : "The person you deal with."}
          >
            <div className="grid grid-cols-[84px_1fr_1fr] gap-2">
              <select className={selectClass} aria-label="Salutation" {...register("contact_salutation")}>
                <option value="">—</option>
                <option value="Mr.">Mr.</option>
                <option value="Ms.">Ms.</option>
                <option value="Mrs.">Mrs.</option>
                <option value="Dr.">Dr.</option>
              </select>
              <Input id="contact_first_name" placeholder="First name" error={errors.contact_first_name?.message} {...register("contact_first_name")} />
              <Input aria-label="Last name" placeholder="Last name" {...register("contact_last_name")} />
            </div>
          </Row>

          <Row
            label="Display name"
            htmlFor="display_name"
            hint="How this customer appears in lists. Blank = uses the name above."
          >
            <Input
              id="display_name"
              placeholder={isIndividual ? [dnFirst, dnLast].filter(Boolean).join(" ") || "e.g. Pardeep Sharma" : companyName?.trim() || "e.g. Acme Corp"}
              {...register("display_name")}
            />
            {displayNameSuggestions.length > 0 && (
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <span className="text-2xs text-ink-3">Suggestions:</span>
                {displayNameSuggestions.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setValue("display_name", s, { shouldDirty: true })}
                    className="text-[12px] px-2.5 py-1 rounded-full border border-hairline bg-paper-2/50 text-ink-2 hover:bg-amber-soft hover:text-amber-ink hover:border-amber/40 transition-colors"
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}
          </Row>

          <Row label="Email" htmlFor="contact_email" required={!isEdit}>
            <Input
              id="contact_email" type="email" placeholder="e.g. rajesh@acme.com"
              error={errors.contact_email?.message}
              {...register("contact_email")}
              onChange={(e) => setValue("contact_email", liveEmail(e.target.value), { shouldDirty: true })}
            />
            <FieldPill check={checkEmail(watch("contact_email") ?? "")} />
          </Row>

          <Row label="Phone" htmlFor="contact_phone" required={!isEdit}>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <Input
                id="contact_phone" inputMode="numeric" placeholder="Work phone"
                error={errors.contact_phone?.message}
                {...register("contact_phone")}
                onChange={(e) => setValue("contact_phone", livePhone(e.target.value), { shouldDirty: true })}
                onBlur={(e) => setValue("contact_phone", commitPhone(e.target.value), { shouldDirty: true })}
              />
              {/* Catches the ten-digit landline, which looks perfect until somebody
                  tries to WhatsApp it. */}
              <FieldPill check={checkPhone(watch("contact_phone") ?? "")} />
              <Input aria-label="Mobile" placeholder="Mobile" {...register("contact_mobile")} />
            </div>
          </Row>
        </section>

        {/* ── Tabs (secondary details) ── */}
        <TabBar
          value={tab}
          onChange={(id) => setTab(id as TabId)}
          items={[
            { id: "other",    label: "Other details" },
            { id: "address",  label: "Address", dot: addressHasError ? "rose" : undefined },
            { id: "contacts", label: "Contact persons",  count: contactPersonFields.length || undefined, dot: contactsHasError ? "rose" : undefined },
            /* Last, because it is the one you read before pressing Save. */
            { id: "review",   label: "Review & save" },
          ]}
          className="mb-2"
        />

        {/* Keep every panel mounted (just hidden) so validation + values survive
            tab switches and a single native submit validates the whole form. */}

        {/* ── Other details ── */}
        <section className={cn(tab !== "other" && "hidden")}>
          <Row label="Designation" htmlFor="contact_title" hint="The primary contact's role.">
            <Input id="contact_title" placeholder="e.g. CTO / Accounts Head" {...register("contact_title")} />
          </Row>

          <Row label="Website" htmlFor="domain">
            <Input
              id="domain" placeholder="e.g. acmecorp.com"
              {...register("domain")}
              /* A pasted URL becomes a host. A stored value carrying a scheme or a path
                 never matches a customer_domains row, so the customer looks unlinked. */
              onChange={(e) => setValue("domain", liveDomain(e.target.value), { shouldDirty: true })}
            />
            <FieldPill check={checkDomain(watch("domain") ?? "")} />
          </Row>

          <Row label="Parent account / group" htmlFor="group_id" hint="Link companies routed by one common reseller/coordinator. Each company still keeps its own GSTIN + invoices.">
            <div className="flex gap-2">
              <select id="group_id" className={selectClass} {...register("group_id")}>
                <option value="">No group</option>
                {(customerGroups ?? []).map((g) => (
                  <option key={g.id} value={g.id}>{g.name}</option>
                ))}
              </select>
              <Button type="button" variant="default" icon="plus" onClick={() => setGroupDialogOpen(true)}>New</Button>
            </div>
          </Row>

          <Row label="Default payment terms" htmlFor="payment_terms_days" hint="Pre-fills the due date when you invoice this customer.">
            <select id="payment_terms_days" className={selectClass} {...register("payment_terms_days")}>
              <option value="">Default (Net 30)</option>
              <option value="0">Due on receipt</option>
              <option value="15">Net 15</option>
              <option value="30">Net 30</option>
              <option value="45">Net 45</option>
            </select>
          </Row>
        </section>

        {/* ── Address ── */}
        <section className={cn(tab !== "address" && "hidden")}>
          <Row label="Billing address" htmlFor="address" hint="Appears on every invoice.">
            <textarea
              id="address"
              rows={2}
              placeholder={isForeign ? "Street / building" : "Auto-filled from GSTIN — appears on every GST invoice"}
              className="w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-amber resize-none"
              {...register("address")}
            />
          </Row>

          <Row label="City" htmlFor="city">
            <Input id="city" placeholder="e.g. Mumbai" {...register("city")} />
          </Row>

          <Row
            label={isForeign ? "State / Province" : "Registered state"}
            htmlFor="state"
            hint={isForeign ? undefined : "Place of supply — needed for every GST invoice. Filled from the GSTIN when there is one."}
          >
            {foreignStates ? (
              <select id="state" className={selectClass} {...register("state")}>
                <option value="">Select state / province…</option>
                {watch("state") && !foreignStates.some((st) => st.toLowerCase() === watch("state")!.toLowerCase()) && (
                  <option value={watch("state")!}>{watch("state")}</option>
                )}
                {foreignStates.map((st) => <option key={st} value={st}>{st}</option>)}
              </select>
            ) : isForeign ? (
              <Input id="state" placeholder="State / province" {...register("state")} />
            ) : (
              /* R-173: India gets the GST state list, not free text — "New Delhi" or "Orissa"
                 typed by hand never mapped to a state code, and the invoice then refused. */
              <>
                <select id="state" className={selectClass} aria-invalid={!!errors.state} {...register("state")}>
                  <option value="">Select state…</option>
                  {watch("state") && !GST_STATE_OPTIONS.some((o) => o.name.toLowerCase() === watch("state")!.toLowerCase()) && (
                    <option value={watch("state")!}>{watch("state")} (not a GST state — pick one)</option>
                  )}
                  {GST_STATE_OPTIONS.map((o) => <option key={o.code} value={o.name}>{o.name}</option>)}
                </select>
                {errors.state?.message && <p className="mt-1 text-xs text-rose">{String(errors.state.message)}</p>}
              </>
            )}
          </Row>

          <Row label={isForeign ? "Postal / ZIP code" : "PIN code"} htmlFor="pin_code">
            <Input
              id="pin_code"
              className="font-mono"
              placeholder={isForeign ? "e.g. 10001" : "400051"}
              maxLength={isForeign ? 12 : 6}
              error={errors.pin_code?.message}
              {...register("pin_code")}
            />
          </Row>

          <div className="py-4 flex items-center gap-2">
            <Checkbox id="same_as_billing" checked={sameAsBilling} onCheckedChange={(v) => toggleSameAsBilling(v === true)} />
            <Label htmlFor="same_as_billing" className="cursor-pointer">Shipping address same as billing</Label>
          </div>

          {!sameAsBilling && (
            <div className="rounded-xl border border-hairline p-4 md:p-5">
              <p className="text-xs font-semibold uppercase tracking-wider text-ink-3 mb-1">Shipping address</p>
              <Row label="Attention" htmlFor="ship_attention">
                <Input id="ship_attention" placeholder="Person / department" {...register("shipping.attention")} />
              </Row>
              <Row label="Address" htmlFor="ship_address">
                <textarea
                  id="ship_address"
                  rows={3}
                  placeholder="Shipping address"
                  className="w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-amber resize-none"
                  {...register("shipping.address")}
                />
              </Row>
              <Row label="City" htmlFor="ship_city">
                <Input id="ship_city" placeholder="City" {...register("shipping.city")} />
              </Row>
              <Row label="State / Province" htmlFor="ship_state">
                <Input id="ship_state" placeholder="State" {...register("shipping.state")} />
              </Row>
              <Row label="Postal / ZIP" htmlFor="ship_zip">
                <Input id="ship_zip" placeholder="ZIP" {...register("shipping.zip")} />
              </Row>
              <Row label="Country" htmlFor="ship_country">
                <Input id="ship_country" placeholder="Country" {...register("shipping.country")} />
              </Row>
            </div>
          )}
        </section>

        {/* ── Contact persons (additional people beyond the primary) ── */}
        <section className={cn(tab !== "contacts" && "hidden")}>
          <div className="pt-2 pb-3">
            <p className="text-[13px] text-ink-2">Additional people at this customer — accounts, procurement, technical.</p>
            <p className="text-[12px] text-ink-3 mt-0.5">The primary contact is set above. Use a row&rsquo;s menu to make it the primary instead.</p>
          </div>

          <ContactPersonsTable
            fields={contactPersonFields}
            register={register}
            onMakePrimary={makePrimary}
            onRemove={removeContactPerson}
          />

          <Button
            type="button" variant="default" size="sm" icon="plus"
            onClick={() => appendContactPerson({ salutation: "", first_name: "", last_name: "", email: "", phone: "", mobile: "", designation: "" })}
          >
            Add Contact Person
          </Button>
        </section>

        {/* ── Review & save ─────────────────────────────────────────────────────
            The step this form was missing. Its three tabs already disclose
            progressively — that part was never the problem — but there was nowhere
            to see everything at once before saving, and a form whose fields are
            spread across three panels is exactly the one where a wrong value hides.

            Read-only on purpose. Anything wrong here is fixed by going back to the
            tab that owns it, which is one click away above.

            It states the GST-relevant facts first, because those are the ones that
            end up on a document a tax officer reads. */}
        <section className={cn(tab !== "review" && "hidden")}>
          <div className="rounded-xl border border-hairline bg-paper-2/40 p-4 md:p-5">
            <p className="mb-3 text-2xs font-semibold uppercase tracking-wider text-ink-3">
              About to be saved
            </p>
            <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <ReviewLine label="Customer name" value={watch("name")} />
              <ReviewLine label="Display name"  value={watch("display_name")} />
              <ReviewLine
                label="GSTIN" mono value={watchedGstin}
                note={gstinState(watchedGstin ?? "")?.name}
              />
              <ReviewLine
                label="Place of supply"
                value={watch("state")}
                /* Spelled out because it decides IGST vs CGST+SGST, and because a
                   customer with a GSTIN but no state is the commonest shape in these
                   books — 36 of 41 of them. */
                note={watch("state_code") ? `code ${watch("state_code")}` : "no state code — GST head cannot be fixed"}
              />
              <ReviewLine label="Contact"  value={[watch("contact_first_name"), watch("contact_last_name")].filter(Boolean).join(" ")} />
              <ReviewLine label="Email"    value={watch("contact_email")} />
              <ReviewLine label="Phone"    value={watch("contact_phone")} />
              <ReviewLine label="Website"  value={watch("domain")} />
              <ReviewLine label="City"     value={watch("city")} />
              <ReviewLine label="PIN"      value={watch("pin_code")} mono />
            </dl>
            <p className="mt-3 border-t border-hairline pt-2.5 text-2xs leading-snug text-ink-3">
              Anything marked “not set” saves empty. Go back to any tab above to fill it —
              nothing is lost.
            </p>
          </div>
        </section>

        {/* ── Footer actions (always reachable; header also has them on ≥sm) ── */}
        <div className="flex items-center justify-end gap-2 mt-8 pt-5 border-t border-hairline">
          <Button type="button" variant="ghost" onClick={cancel}>Cancel</Button>
          {saveButton}
        </div>
      </form>

      {/* Create a group inline from the picker; auto-select it on save. */}
      <GroupFormDialog
        open={groupDialogOpen}
        onOpenChange={setGroupDialogOpen}
        onSaved={(g) => setValue("group_id", g.id, { shouldDirty: true })}
      />
    </div>
  );
}
