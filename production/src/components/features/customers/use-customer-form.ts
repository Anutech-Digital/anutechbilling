/**
 * useCustomerForm — the shared brain behind BOTH customer-form presentations:
 *   • the full-page form (`/customers/new`, `/customers/[id]/edit`)   — Zoho-style
 *   • the side-sheet   (`AddCustomerForm`, used inline from the quote builder)
 *
 * All the money-sensitive logic lives here ONCE — schema + validation, prefill /
 * edit back-fill, GSTIN → state derivation, export-vs-India shaping, and the
 * normalise-on-submit — so the two layouts can never drift apart. The two views
 * are pure presentation over this hook's return.
 *
 * Why this matters: a wrong customer GSTIN / state means an invalid invoice
 * (customer can't claim ITC → chargeback lands back on the reseller). Keeping
 * the validation + submit in one place is how we keep that correct everywhere.
 */
"use client";

import * as React from "react";
import { useForm, useFieldArray } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { NEEDS_INPUT_CLASS } from "@/lib/ai/test-trail";

import { useCreateCustomer, useUpdateCustomer } from "@/lib/queries/customers";
import { validateGstin, gstStateFromGstin } from "@/lib/utils";
import { isExportSupply } from "@/lib/gst/place-of-supply";
import { getStatesForCountry } from "@/lib/gst/states-by-country";
import { stateRequiredMessage } from "@/lib/gst/gstin-state";
import {
  CUSTOMER_GST_TREATMENTS, suggestGstTreatment, nextGstTreatment, gstTreatmentProblem,
  gstTreatmentOption, panFromGstin, isValidPan, type CustomerGstTreatment,
} from "@/lib/gst/customer-gst-treatment";
import type { GstinVerification, Customer } from "@/lib/supabase/database.types";
import { newCustomerReachProblem, defaultContactName, contactIsTheCompany } from "./new-customer-contact";

// Schema — GSTIN optional but checksum-validated when present. State code stays
// in the schema (needed for GST math) but has no visible input; we auto-derive
// it from the GSTIN, same pattern as Settings.
export const customerSchema = z.object({
  // Business vs individual. For an individual the person IS the customer, so
  // there's no company name — `name` is derived from the contact / display name.
  customer_type: z.enum(["business", "individual"]).default("business"),
  // Company name (business). Optional at the field level — the conditional rule
  // below requires it only for a business customer.
  name:          z.string().optional(),
  // Optional friendly label shown in the UI; falls back to `name` when blank.
  display_name:  z.string().optional(),
  // Optional parent account / group (customer_groups). Links this company to a
  // common reseller/coordinator. "" = no group. Never affects invoicing.
  group_id:      z.string().optional(),
  domain:        z.string().optional(),
  gstin:         z.string().trim().optional().superRefine((v, ctx) => {
    if (!v) return;
    const r = validateGstin(v);
    if (!r.ok) ctx.addIssue({ code: z.ZodIssueCode.custom, message: r.message });
  }),
  state:         z.string().optional(),
  state_code:    z.string().regex(/^\d{0,2}$/).optional(),
  /* R-1736: Zoho-style GST treatment — auto-picked from country / GSTIN / type, changeable.
     An SEZ customer is always IGST (lib/gst/place-of-supply.ts). */
  gst_treatment: z.enum(CUSTOMER_GST_TREATMENTS).optional(),
  /* R-1736: PAN. Filled from the GSTIN (characters 3–12) when there is one; typed otherwise. */
  pan:           z.string().trim().optional().superRefine((v, ctx) => {
    if (v && !isValidPan(v)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "A PAN is 5 letters, 4 digits, 1 letter (e.g. AAACR5055K)" });
  }),
  country:       z.string().optional(),
  address:       z.string().optional(),
  city:          z.string().optional(),
  // Base rule is loose (foreign postal codes are alphanumeric, e.g. UK "SW1A 1AA",
  // US ZIP+4). The India-only 6-digit PIN check is enforced below, conditionally.
  pin_code:      z.string().max(12).optional(),
  contact_name:  z.string().optional(),
  contact_title: z.string().optional(),
  contact_email: z.string().email("Invalid email").optional().or(z.literal("")),
  contact_phone: z.string().optional(),
  // Zoho-style split primary contact (migration 0164).
  contact_salutation: z.string().optional(),
  contact_first_name: z.string().optional(),
  contact_last_name:  z.string().optional(),
  contact_mobile:     z.string().optional(),
  // Default invoice due terms (net days). "" = unset → falls back to net-30.
  payment_terms_days: z.string().optional(),
  // Additional people at the customer.
  contact_persons: z.array(z.object({
    salutation:  z.string().optional(),
    first_name:  z.string().optional(),
    last_name:   z.string().optional(),
    email:       z.string().email("Invalid email").optional().or(z.literal("")),
    phone:       z.string().optional(),
    mobile:      z.string().optional(),
    designation: z.string().optional(),
  })).optional(),
  // Separate shipping address.
  shipping: z.object({
    attention: z.string().optional(),
    address:   z.string().optional(),
    city:      z.string().optional(),
    state:     z.string().optional(),
    zip:       z.string().optional(),
    country:   z.string().optional(),
  }).optional(),
}).superRefine((data, ctx) => {
  // Indian customers keep the strict 6-digit PIN guard; export customers don't
  // (their postal codes aren't 6 digits). Country drives the difference.
  const foreign = isExportSupply(data.country);
  const pin = (data.pin_code ?? "").trim();
  if (pin && !foreign && !/^\d{6}$/.test(pin)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["pin_code"], message: "6-digit PIN (or blank)" });
  }
  /* R-173 (6 Oct 2026): an Indian customer with no place of supply cannot be invoiced at all
     (live had 17). GSTIN or not, the state is required; a valid GSTIN supplies it by itself. */
  const stateMsg = stateRequiredMessage(data);
  if (stateMsg) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["state"], message: stateMsg });
  /* R-1736: a treatment the facts contradict (Overseas in India, Regular with no GSTIN). */
  if (data.gst_treatment) {
    const problem = gstTreatmentProblem({ treatment: data.gst_treatment, country: data.country, gstin: foreign ? "" : data.gstin });
    if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["gst_treatment"], message: problem });
  }
  // A business needs a company name; an individual needs at least a person /
  // display name (no company). Enforced here so the shared `name` field can be
  // optional for individuals.
  if (data.customer_type === "individual") {
    const hasName = !!(data.contact_first_name?.trim() || data.contact_last_name?.trim() || data.display_name?.trim());
    if (!hasName) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["contact_first_name"], message: "Name is required" });
    }
  } else if (!data.name || data.name.trim().length < 2) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["name"], message: "Company name is required" });
  }
});

export type CustomerFormData = z.infer<typeof customerSchema>;

interface UseCustomerFormOptions {
  /** When provided, the form is in EDIT mode (prefilled + updates this customer). */
  customer?: Customer | null;
  /** Called with the customer id after a successful save (create OR update). */
  onSaved?: (id: string) => void;
  /**
   * Sheet-only lifecycle flag. When it flips to `false` the form resets + clears
   * verification so reopening starts clean. The full-page views leave it `true`.
   */
  open?: boolean;
}

/**
 * Everything the two presentations need. Register fields, read `errors`, render
 * `verification` via GstinVerifyCard, and submit via `submit`.
 */
export function useCustomerForm({ customer, onSaved, open = true }: UseCustomerFormOptions) {
  const isEdit = !!customer;
  const createCustomer = useCreateCustomer();
  const updateCustomer = useUpdateCustomer();
  // Hold the live verification result so we persist it with the save (no extra
  // round-trip).
  const [verification, setVerification] = React.useState<GstinVerification | null>(null);

  const form = useForm<CustomerFormData>({
    resolver: zodResolver(customerSchema),
    defaultValues: { country: "India", customer_type: "business", gst_treatment: "unregistered_business" },
  });
  /* R-1736: true once the user picks a GST treatment by hand (or the saved one differs from
     what the facts suggest) — from then on the auto-pick leaves it alone (nextGstTreatment). */
  const treatmentManual = React.useRef(false);
  const { register, handleSubmit, reset, watch, setValue, control, formState } = form;
  const { fields: contactPersonFields, append: appendContactPerson, remove: removeContactPerson } =
    useFieldArray({ control, name: "contact_persons" });

  // Prefill from the customer (edit) or start blank (create). The sheet also
  // wipes on close so reopening is clean.
  React.useEffect(() => {
    if (!open) {
      reset({ country: "India", customer_type: "business", gst_treatment: "unregistered_business" });
      treatmentManual.current = false;
      setVerification(null);
      return;
    }
    if (customer) {
      // Normalize an existing free-text/legacy state to the canonical dropdown
      // option (case-insensitive) so e.g. "california" shows as "California".
      const stateList = getStatesForCountry(customer.country);
      const normalizedState =
        stateList?.find((s) => s.toLowerCase() === (customer.state ?? "").toLowerCase())
        ?? customer.state ?? "";
      // Back-fill first/last from the legacy single contact_name so an older
      // customer's contact isn't shown blank in the new split fields.
      let firstName = customer.contact_first_name ?? "";
      let lastName  = customer.contact_last_name ?? "";
      /* R-1738: a contact that is just the company's own name stays out of First/Last. */
      if (!firstName && !lastName && customer.contact_name?.trim() && !contactIsTheCompany(customer)) {
        const parts = customer.contact_name.trim().split(/\s+/);
        firstName = parts[0] ?? "";
        lastName  = parts.slice(1).join(" ");
      }
      const suggested = suggestGstTreatment({ country: customer.country, gstin: customer.gstin, customerType: customer.customer_type });
      treatmentManual.current = !!customer.gst_treatment && customer.gst_treatment !== suggested;
      reset({
        gst_treatment: customer.gst_treatment ?? suggested,
        pan:           customer.pan ?? "",
        customer_type: customer.customer_type ?? "business",
        name:          customer.name ?? "",
        display_name:  customer.display_name ?? "",
        group_id:      customer.group_id ?? "",
        domain:        customer.domain ?? "",
        gstin:         customer.gstin ?? "",
        state:         normalizedState,
        state_code:    customer.state_code ?? "",
        country:       customer.country ?? "India",
        address:       customer.address ?? "",
        city:          customer.city ?? "",
        pin_code:      customer.pin_code ?? "",
        contact_name:  customer.contact_name ?? "",
        contact_title: customer.contact_title ?? "",
        contact_email: customer.contact_email ?? "",
        contact_phone: customer.contact_phone ?? "",
        contact_salutation: customer.contact_salutation ?? "",
        contact_first_name: firstName,
        contact_last_name:  lastName,
        contact_mobile:     customer.contact_mobile ?? "",
        payment_terms_days: customer.payment_terms_days != null ? String(customer.payment_terms_days) : "",
        contact_persons: (customer.contact_persons ?? []).map((p) => ({
          salutation: p.salutation ?? "", first_name: p.first_name ?? "", last_name: p.last_name ?? "",
          email: p.email ?? "", phone: p.phone ?? "", mobile: p.mobile ?? "", designation: p.designation ?? "",
        })),
        shipping: {
          attention: customer.shipping_address?.attention ?? "",
          address:   customer.shipping_address?.address ?? "",
          city:      customer.shipping_address?.city ?? "",
          state:     customer.shipping_address?.state ?? "",
          zip:       customer.shipping_address?.zip ?? "",
          country:   customer.shipping_address?.country ?? "",
        },
      });
      setVerification(customer.gstin_verification ?? null);
    } else {
      reset({ country: "India", customer_type: "business", gst_treatment: "unregistered_business" });
      treatmentManual.current = false;
      setVerification(null);
    }
  }, [open, customer, reset]);

  // Auto-derive state + state_code from GSTIN on every keystroke. Same logic as
  // Settings — first 2 digits of GSTIN = state code.
  const watchedGstin = watch("gstin");
  React.useEffect(() => {
    const { code, name } = gstStateFromGstin(watchedGstin ?? "");
    if (code) setValue("state_code", code, { shouldDirty: true });
    if (name) setValue("state",      name, { shouldDirty: true });
  }, [watchedGstin, setValue]);

  /* R-1736: GST treatment follows country / GSTIN / customer type until picked by hand —
     the same rule that backfilled existing customers (suggestGstTreatment). */
  const watchedCountry  = watch("country");
  const watchedType     = watch("customer_type");
  const watchedTreatment = watch("gst_treatment");
  const formForeign = isExportSupply(watchedCountry);
  const suggestedTreatment = suggestGstTreatment({
    country: watchedCountry, gstin: formForeign ? "" : watchedGstin, customerType: watchedType,
  });
  React.useEffect(() => {
    const next = nextGstTreatment({ current: watchedTreatment, manual: treatmentManual.current, suggestion: suggestedTreatment });
    if (next !== watchedTreatment) setValue("gst_treatment", next, { shouldDirty: true, shouldValidate: !!formState.isSubmitted });
    if (next === suggestedTreatment) treatmentManual.current = false;
  }, [suggestedTreatment, watchedTreatment, setValue, formState.isSubmitted]);
  const onTreatmentChange = (value: CustomerGstTreatment) => {
    treatmentManual.current = value !== suggestedTreatment;
    setValue("gst_treatment", value, { shouldDirty: true, shouldValidate: true });
  };

  /* R-1736: PAN = GSTIN characters 3–12. Read-only while a valid GSTIN supplies it; typed
     by hand for an unregistered customer. A PAN that only came from an old GSTIN is cleared
     when the GSTIN goes, so a stale one is never saved. */
  const panFromForm = formForeign ? null : panFromGstin(watchedGstin);
  const lastDerivedPan = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (panFromForm) {
      setValue("pan", panFromForm, { shouldDirty: true, shouldValidate: true });
    } else if (lastDerivedPan.current && form.getValues("pan") === lastDerivedPan.current) {
      setValue("pan", "", { shouldDirty: true });
    }
    lastDerivedPan.current = panFromForm;
  }, [panFromForm, setValue, form]);

  /* R-2095: the owner chose "Save without contact" once — the next submit of this form saves. */
  const noContactOk = React.useRef(false);
  /* R-2095 (2nd gap): the form says "no contact" itself and offers the choice in its own footer — in
     the bank reconcile drawer this form is a sheet over a modal sheet, and the toast below it cannot
     be clicked (the modal blocks every click outside it). */
  const [contactMissing, setContactMissing] = React.useState(false);
  const onSubmit = async (data: CustomerFormData) => {
    // Export (non-India) customers have no GSTIN / Indian state code — never
    // persist a stale one if the user typed then switched country.
    const foreign = isExportSupply(data.country);
    // Combined display name from the split fields (falls back to the legacy
    // single "contact_name" input for anyone still using it).
    const combinedName = [data.contact_first_name?.trim(), data.contact_last_name?.trim()]
      .filter(Boolean).join(" ") || (data.contact_name?.trim() || null);

    /* ── A NEW CUSTOMER NEEDS A WAY TO REACH IT (R-1738, 22 Oct 2026) ─────────
       Was: name + contact person + email + phone, all four required (Abhishek, 18 Sep:
       "without contact customer not created"). Zoho asks only the name. Now a new
       customer needs its name (the schema) and ONE way to send the invoice — an email
       or a phone. The contact is still never blank: when no person is typed, the
       company itself is the contact (defaultContactName below), so useCreateCustomer's
       contact rule, the customer_contacts link, the invoice / dunning recipient and the
       subscription file's "Contact Name" all still get one.

       CREATE ONLY, on purpose — editing an old customer is never blocked. Reported
       through setError so it lands on the field like every other message here. */
    /* R-2095 (staging, 30 Oct): a customer brought over from Zoho can have neither (Quantiva) — the
       owner may save it anyway; the customer then reads "No email or phone yet" until one is added. */
    if (!isEdit && !noContactOk.current) {
      const problem = newCustomerReachProblem(data);
      if (problem) {
        form.setError("contact_email", { type: "manual", message: problem });
        setContactMissing(true);
        toast.error("Add an email or a phone number", {
          description: "The invoice and the payment reminder need somewhere to go. One of the two is enough. No contact at all? Save without one and add it later.",
          duration: 15000,
          action: { label: "Save without contact", onClick: () => { noContactOk.current = true; setContactMissing(false); form.clearErrors("contact_email"); void onSubmit(data); } },
        });
        return;
      }
    }
    // Clean the additional contact-person rows — drop fully-empty ones.
    const cleanPersons = (data.contact_persons ?? [])
      .map((p) => ({
        salutation:  p.salutation?.trim()  || undefined,
        first_name:  p.first_name?.trim()  || undefined,
        last_name:   p.last_name?.trim()   || undefined,
        email:       p.email?.trim()       || undefined,
        phone:       p.phone?.trim()       || undefined,
        mobile:      p.mobile?.trim()      || undefined,
        designation: p.designation?.trim() || undefined,
      }))
      .filter((p) => p.first_name || p.last_name || p.email || p.phone || p.mobile);
    // Shipping address → jsonb (null when the whole block is empty).
    const s = data.shipping ?? {};
    const shippingFilled = [s.attention, s.address, s.city, s.state, s.zip, s.country].some((v) => v?.trim());
    const shipping = shippingFilled ? {
      attention: s.attention?.trim() || undefined, address: s.address?.trim() || undefined,
      city: s.city?.trim() || undefined, state: s.state?.trim() || undefined,
      zip: s.zip?.trim() || undefined, country: s.country?.trim() || undefined,
    } : null;
    const termsDays = data.payment_terms_days?.trim() ? parseInt(data.payment_terms_days) : null;
    // Canonical `name` — the legal / invoice name. Company for a business; the
    // person's name for an individual (who has no company). `display_name` is a
    // separate optional UI label (never used on the GST invoice).
    const type = data.customer_type ?? "business";
    const personName = [data.contact_first_name?.trim(), data.contact_last_name?.trim()].filter(Boolean).join(" ");
    const display = data.display_name?.trim() || "";
    const canonicalName = type === "individual"
      ? (personName || display)
      : (data.name?.trim() ?? "");
    const base = {
      customer_type: type,
      display_name:  display || null,
      name:          canonicalName,
      group_id:      data.group_id?.trim()      || null,
      domain:        data.domain?.trim()        || null,
      gstin:         foreign ? null : (data.gstin?.trim()      || null),
      state:         data.state?.trim()         || null,
      state_code:    foreign ? null : (data.state_code?.trim() || null),
      /* R-1736: always sent, so an edit never leaves an old treatment behind. */
      gst_treatment: data.gst_treatment
        ?? suggestGstTreatment({ country: data.country, gstin: foreign ? "" : data.gstin, customerType: type }),
      pan:           foreign ? null : (panFromGstin(data.gstin) ?? (data.pan?.trim().toUpperCase() || null)),
      country:       data.country?.trim()       || "India",
      address:       data.address?.trim()       || null,
      city:          data.city?.trim()          || null,
      pin_code:      data.pin_code?.trim()      || null,
      /* R-1738: no contact person typed → the company (or the individual) is the contact. */
      contact_name:  defaultContactName({ personName: combinedName, customerName: canonicalName }),
      contact_title: data.contact_title?.trim() || null,
      contact_email: data.contact_email?.trim() || null,
      contact_phone: data.contact_phone?.trim() || null,
      contact_salutation: data.contact_salutation?.trim() || null,
      contact_first_name: data.contact_first_name?.trim() || null,
      contact_last_name:  data.contact_last_name?.trim()  || null,
      contact_mobile:     data.contact_mobile?.trim()     || null,
      contact_persons:    cleanPersons,
      payment_terms_days: termsDays,
      shipping_address:   shipping,
    };
    // Only stamp verification when newly verified this session — so editing an
    // already-verified customer without re-verifying doesn't wipe its status.
    const payload = (verification && !foreign)
      ? { ...base, gstin_verification: verification, gstin_verified_at: new Date().toISOString() }
      : base;
    if (isEdit && customer) {
      await updateCustomer.mutateAsync({ id: customer.id, patch: payload });
      onSaved?.(customer.id);
    } else {
      const created = await createCustomer.mutateAsync(payload);
      if (created?.id) onSaved?.(created.id);
    }
  };

  // Country decides the whole shape of the form: an export (non-India) customer
  // has no GSTIN, no Indian state code, and an alphanumeric postal code.
  const isForeign = isExportSupply(watch("country"));
  // For an export country we know the states/emirates of, offer a dropdown
  // instead of free text (stops "california" being saved for a Kuwait customer).
  const foreignStates = isForeign ? getStatesForCountry(watch("country")) : null;
  // Compose register's onChange so switching country clears a now-wrong state.
  const countryReg = register("country");
  const onCountryChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    countryReg.onChange(e);
    // Clear the state — it belongs to the OLD country. (India re-derives it from
    // the GSTIN; a foreign country re-picks from the dropdown.)
    setValue("state", "", { shouldDirty: true });
  };

  return {
    form,
    register,
    setValue,
    watch,
    control,
    errors: formState.errors,
    isSubmitting: formState.isSubmitting,
    isPending: createCustomer.isPending || updateCustomer.isPending,
    isEdit,
    contactPersonFields,
    appendContactPerson,
    removeContactPerson,
    verification,
    setVerification,
    watchedGstin,
    isForeign,
    foreignStates,
    countryReg,
    onCountryChange,
    /* R-1736 */
    gstTreatment: watchedTreatment ?? suggestedTreatment,
    gstTreatmentAuto: (watchedTreatment ?? suggestedTreatment) === suggestedTreatment,
    gstTreatmentMeaning: gstTreatmentOption(watchedTreatment ?? suggestedTreatment)?.meaning ?? "",
    onTreatmentChange,
    panLocked: !!panFromForm,
    onSubmit,
    /* R-2095: true after a save refused for no email / phone — the form shows "Save without contact". */
    contactMissing,
    saveWithoutContact: () => {
      noContactOk.current = true;
      setContactMissing(false);
      form.clearErrors("contact_email");
      return handleSubmit(onSubmit)();
    },
    /* The state field sits on the Address tab, which may be closed — say what is missing
       instead of a Save button that silently does nothing (R-173). */
    submit: handleSubmit(onSubmit, (errs) => {
      if (errs.state?.message) toast.error("State is missing", { className: NEEDS_INPUT_CLASS, description: String(errs.state.message) });
      if (errs.gst_treatment?.message) toast.error("Check the GST treatment", { className: NEEDS_INPUT_CLASS, description: String(errs.gst_treatment.message) });
    }),
  };
}
