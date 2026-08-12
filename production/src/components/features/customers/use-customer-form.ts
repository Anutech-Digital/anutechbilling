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

import { useCreateCustomer, useUpdateCustomer } from "@/lib/queries/customers";
import { validateGstin, gstStateFromGstin } from "@/lib/utils";
import { isExportSupply } from "@/lib/gst/place-of-supply";
import { getStatesForCountry } from "@/lib/gst/states-by-country";
import type { GstinVerification, Customer } from "@/lib/supabase/database.types";

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
  // Create-only opt-in: also provision a Customer Panel login for this
  // customer once created. Not a customer field — an action flag for this
  // submission, so it lives here rather than in customerSchema.
  const [provisionCustomerPanel, setProvisionCustomerPanel] = React.useState(false);

  const form = useForm<CustomerFormData>({
    resolver: zodResolver(customerSchema),
    defaultValues: { country: "India", customer_type: "business" },
  });
  const { register, handleSubmit, reset, watch, setValue, control, formState } = form;
  const { fields: contactPersonFields, append: appendContactPerson, remove: removeContactPerson } =
    useFieldArray({ control, name: "contact_persons" });

  // Prefill from the customer (edit) or start blank (create). The sheet also
  // wipes on close so reopening is clean.
  React.useEffect(() => {
    if (!open) {
      reset({ country: "India", customer_type: "business" });
      setVerification(null);
      setProvisionCustomerPanel(false);
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
      if (!firstName && !lastName && customer.contact_name?.trim()) {
        const parts = customer.contact_name.trim().split(/\s+/);
        firstName = parts[0] ?? "";
        lastName  = parts.slice(1).join(" ");
      }
      reset({
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
      reset({ country: "India", customer_type: "business" });
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

  const onSubmit = async (data: CustomerFormData) => {
    // Export (non-India) customers have no GSTIN / Indian state code — never
    // persist a stale one if the user typed then switched country.
    const foreign = isExportSupply(data.country);
    // Combined display name from the split fields (falls back to the legacy
    // single "contact_name" input for anyone still using it).
    const combinedName = [data.contact_first_name?.trim(), data.contact_last_name?.trim()]
      .filter(Boolean).join(" ") || (data.contact_name?.trim() || null);
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
      country:       data.country?.trim()       || "India",
      address:       data.address?.trim()       || null,
      city:          data.city?.trim()          || null,
      pin_code:      data.pin_code?.trim()      || null,
      contact_name:  combinedName,
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
      if (created?.id) {
        onSaved?.(created.id);
        if (provisionCustomerPanel) {
          try {
            const res = await fetch(`/api/customers/${created.id}/provision-customer-panel`, { method: "POST" });
            const body = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(body.error || "Could not create Customer Panel account");
            // emailSent reflects whether the setup email actually sent, not just
            // whether the account was created — those used to be conflated, so a
            // silent email failure looked identical to a successful setup.
            if (!body.created) {
              toast.success(
                body.emailSent
                  ? "Linked to an existing Customer Panel account — they've been notified by email"
                  : "Linked to an existing Customer Panel account"
              );
            } else if (body.emailSent) {
              toast.success("Customer Panel account created — setup email sent");
            } else {
              toast.warning(
                "Customer Panel account created, but the setup email failed to send. Ask the customer to use \"Forgot password\" on the Customer Panel login page instead."
              );
            }
          } catch (e) {
            toast.error((e as Error).message || "Could not create Customer Panel account");
          }
        }
      }
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
    provisionCustomerPanel,
    setProvisionCustomerPanel,
    watchedGstin,
    isForeign,
    foreignStates,
    countryReg,
    onCountryChange,
    onSubmit,
    submit: handleSubmit(onSubmit),
  };
}
