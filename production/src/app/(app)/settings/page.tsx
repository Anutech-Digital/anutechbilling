/**
 * Settings — reseller business configuration.
 *
 * Team management lives on its own page at /team now. This page is
 * just configuration: company identity, integrations, branding,
 * notifications, security.
 *
 * Layout:
 *   - Page header (System · Settings)
 *   - 5 tabs: Company / Integrations / Branding / Notifications / Security
 *   - Company tab: Company information form (full-width — no Team panel)
 *   - Integrations tab: 6 integration cards
 *   - Other tabs: "Coming soon" placeholder
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { GST_STATE_OPTIONS, initialStateCode, normalizeStateCode } from "../setup/company-state";
import { InvoiceCodeField, useInvoiceCode, useSaveInvoiceCode } from "../setup/invoice-code-field";
import { invoiceCodeProblem, normalizeInvoiceCode } from "../setup/invoice-code";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { TabBar, type TabBarItem } from "@/components/ui/tabs";
import { NotificationsCard } from "@/components/features/settings/notifications-card";
import { ComplianceProfileCard } from "@/components/features/compliance/compliance-profile-card";
import { TurnoverCard } from "@/components/features/compliance/turnover-card";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { useUpdateTenant, useSetTenantLogo } from "@/lib/queries/tenant";
import { isValidGstin, gstStateFromGstin, validateGstin, formatDate, GST_STATE_BY_CODE } from "@/lib/utils";
import { contactsCardState } from "@/lib/google/contacts-card-state";
import GstinVerifyCard from "@/components/features/gstin/gstin-verify-card";
import SandboxConfigureDialog  from "@/components/features/integrations/sandbox-configure-dialog";
import WhatsAppConfigureDialog from "@/components/features/integrations/whatsapp-configure-dialog";
import RazorpayConfigureDialog from "@/components/features/integrations/razorpay-configure-dialog";
import EmailSendingCard from "@/components/features/integrations/email-sending-card";
import ChangePasswordCard from "@/components/features/settings/change-password-card";
import { TwoFactorCard } from "@/components/features/settings/two-factor-card";
import GeminiConfigureDialog from "@/components/features/integrations/gemini-configure-dialog";
import ApiKeysCard from "@/components/features/integrations/api-keys-card";
import { useConfirm } from "@/components/providers/confirm-provider";
import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import type { TenantWithParent } from "@/lib/supabase/database.types";
import { isValidVpa } from "@/lib/payments/upi";
import type { RazorpayReadiness } from "@/lib/payments/razorpay-readiness";
import { resellerTierView } from "./reseller-tier-view";
import { resolveSettingsTab, settingsTabHref } from "./settings-tab";
import { useScrollToHash } from "@/lib/onboarding/use-scroll-to-hash";

// ─── Demo data ────────────────────────────────────────────────────────────────
// Team roster moved to its own /team page. Settings only owns the
// non-people configuration surfaces (company identity, integrations,
// branding, notifications, security).

const TABS: TabBarItem[] = [
  { id: "company",       label: "Company"       },
  { id: "integrations",  label: "Integrations"  },
  { id: "branding",      label: "Branding"      },
  /* Notifications earns its tab as of 21 Aug 2026: it turns web push on for this device
     and chooses what may interrupt you. */
  { id: "notifications", label: "Notifications" },
  /* Security was held back on the rule that a "Coming soon" dead-end reads as half-built
     to a non-technical owner — it was to stay out until it did something. As of 22 Aug 2026
     it does: changing your own password, which had no home anywhere in the app. */
  { id: "security",      label: "Security"      },
];

// ─── Field wrapper ────────────────────────────────────────────────────────────

function Field({
  label,
  htmlFor,
  children,
  className,
}: {
  label: string;
  /** R-303: the id of the control this label names (screen readers announce it). */
  htmlFor?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <label htmlFor={htmlFor} className="mb-1 block text-xs font-medium text-ink-3">{label}</label>
      {children}
    </div>
  );
}

// ─── Company tab ──────────────────────────────────────────────────────────────

const companySchema = z.object({
  name:         z.string().min(1, "Required").max(120),
  contact_name: z.string().trim().max(120).optional(),
  gstin:        z.string().trim().optional().superRefine((v, ctx) => {
    if (!v) return;
    const r = validateGstin(v);
    if (!r.ok) ctx.addIssue({ code: z.ZodIssueCode.custom, message: r.message });
  }),
  // R-250: state comes only from the GST state select — always a known 2-digit code.
  state_code: z.string().trim()
    .refine((v) => normalizeStateCode(v) !== null, "Choose your state"),
  email:      z.string().email("Invalid email").or(z.literal("")).optional(),
  phone:      z.string().trim().max(20).optional(),
  address:    z.string().trim().max(300).optional(),
  pin_code:   z.string().trim().regex(/^\d{0,6}$/, "6-digit PIN (or blank)").optional(),
  lut_number:     z.string().trim().max(40).optional(),
  lut_valid_upto: z.string().trim().optional(),
  // Validated with the SAME helper that builds the QR, so Settings can never
  // accept a VPA the invoice would then silently refuse to print.
  upi_vpa: z.string().trim().max(80).optional()
    .refine((v) => !v || isValidVpa(v), "Enter a valid UPI ID, e.g. yourname@okhdfcbank"),
  upi_payee_name: z.string().trim().max(50).optional(),
  /* R-038 — bank details for the invoice PDF's NEFT/RTGS block.
     Deliberately permissive: an account number is 9–18 digits at most Indian banks but
     not all, and a validator that refuses a real account is worse than none here —
     nothing downstream parses these, they are printed. IFSC has a genuine fixed shape
     (4 letters, 0, 6 alphanumeric) so a typo IS catchable, and a bounced transfer costs
     the customer a week. */
  remit_bank_name:      z.string().trim().max(80).optional(),
  remit_account_name:   z.string().trim().max(80).optional(),
  remit_account_number: z.string().trim().max(30).optional(),
  remit_ifsc: z.string().trim().max(11).optional()
    .refine((v) => !v || /^[A-Za-z]{4}0[A-Za-z0-9]{6}$/.test(v),
            "11 characters, e.g. HDFC0001234 (4 letters, a zero, then 6)"),
  remit_branch:         z.string().trim().max(80).optional(),
  grace_period_days: z.coerce
    .number({ invalid_type_error: "Must be a number" })
    .int("Whole days only")
    .min(0, "Cannot be negative")
    .max(30, "Max 30 days"),
});
type CompanyForm = z.infer<typeof companySchema>;

function CompanyTab({ onDirtyChange }: { onDirtyChange?: (dirty: boolean) => void }) {
  const { data: me, isLoading } = useCurrentUser();
  const updateTenant = useUpdateTenant();
  const isOwner = me?.role === "owner";

  const defaults: CompanyForm = React.useMemo(
    () => ({
      name:         me?.tenantName        ?? "",
      contact_name: me?.tenantContactName ?? "",
      gstin:        me?.tenantGstin       ?? "",
      state_code:   initialStateCode(me?.tenantState, me?.tenantStateCode),
      email:        me?.tenantEmail       ?? "",
      phone:        me?.tenantPhone       ?? "",
      address:      me?.tenantAddress     ?? "",
      pin_code:     me?.tenantPinCode     ?? "",
      lut_number:     me?.tenantLutNumber    ?? "",
      lut_valid_upto: me?.tenantLutValidUpto ?? "",
      upi_vpa:        me?.tenantUpiVpa       ?? "",
      upi_payee_name: me?.tenantUpiPayeeName ?? "",
      remit_bank_name:      me?.tenantRemitBankName      ?? "",
      remit_account_name:   me?.tenantRemitAccountName   ?? "",
      remit_account_number: me?.tenantRemitAccountNumber ?? "",
      remit_ifsc:           me?.tenantRemitIfsc          ?? "",
      remit_branch:         me?.tenantRemitBranch        ?? "",
      grace_period_days: me?.tenantGracePeriodDays ?? 0,
    }),
    [me],
  );

  const {
    register,
    handleSubmit,
    reset,
    watch,
    setValue,
    formState: { errors, isDirty, isSubmitting },
  } = useForm<CompanyForm>({
    resolver: zodResolver(companySchema),
    defaultValues: defaults,
  });
  /* R-252: tell the page, so a tab switch can ask before unmounting a half-filled form. */
  React.useEffect(() => { onDirtyChange?.(isDirty); }, [isDirty, onDirtyChange]);

  // Refresh defaults once useCurrentUser settles
  React.useEffect(() => { reset(defaults); }, [defaults, reset]);

  // Auto-derive state + state_code from GSTIN.
  // First 2 digits of a GSTIN encode the state per GSTN master list.
  // Mark fields dirty so the form's "Save changes" button activates.
  const watchedGstin = watch("gstin");
  React.useEffect(() => {
    const { code, name } = gstStateFromGstin(watchedGstin ?? "");
    if (code && name) setValue("state_code", code, { shouldDirty: true, shouldValidate: true });
  }, [watchedGstin, setValue]);

  const onSubmit = (values: CompanyForm) => {
    // Normalize empty strings to null so DB nulls stay null and constraints are honored
    const patch = {
      name:         values.name.trim(),
      contact_name: values.contact_name?.trim() || null,
      gstin:        values.gstin?.trim()        || null,
      // R-250: name follows the chosen code, so state and state_code can never disagree.
      ...(() => {
        const code = normalizeStateCode(values.state_code);
        return code
          ? { state: GST_STATE_BY_CODE[code], state_code: code }
          : { state: null, state_code: null };
      })(),
      email:        values.email?.trim()        || me?.tenantEmail || "",  // keep existing if blanked — email is NOT NULL on tenants
      phone:        values.phone?.trim()        || null,
      address:      values.address?.trim()      || null,
      pin_code:     values.pin_code?.trim()     || null,
      lut_number:     values.lut_number?.trim()     || null,
      lut_valid_upto: values.lut_valid_upto?.trim() || null,
      upi_vpa:        values.upi_vpa?.trim()        || null,
      upi_payee_name: values.upi_payee_name?.trim() || null,
      remit_bank_name:      values.remit_bank_name?.trim()      || null,
      remit_account_name:   values.remit_account_name?.trim()   || null,
      remit_account_number: values.remit_account_number?.trim() || null,
      // Upper-cased on the way in: IFSC is officially upper case and a lower-case one
      // printed on an invoice invites a "is this right?" call it does not need.
      remit_ifsc:           values.remit_ifsc?.trim().toUpperCase() || null,
      remit_branch:         values.remit_branch?.trim()         || null,
      grace_period_days: values.grace_period_days,
    };
    updateTenant.mutate(patch, { onSuccess: () => reset(values) });
  };

  return (
    <div className="grid grid-cols-1 gap-5">
      {/* Reseller hierarchy (migration 0040). Read-only display for now —
          link/unlink controls land in a later slice. */}
      <ResellerTierCard />

      {/* Company information — full-width now that Team is its own page */}
      <Card className="p-5 max-w-3xl">
        <form onSubmit={handleSubmit(onSubmit)} noValidate>
          <div className="mb-4 flex items-center justify-between">
            <p className="text-sm font-semibold text-ink">Company information</p>
            {!isOwner && <Badge kind="muted">Owner-only · view</Badge>}
            {isOwner && isDirty && <Badge kind="warning" dot>Unsaved changes</Badge>}
          </div>

          {isLoading ? (
            <p className="text-xs text-ink-3">Loading…</p>
          ) : (
            <fieldset disabled={!isOwner || isSubmitting} className="space-y-3 disabled:opacity-60">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Field htmlFor="settings-legal-name" label="Legal name *">
                  <Input id="settings-legal-name"
                    placeholder="E.g., Sharma Cloud Solutions Pvt Ltd"
                    error={errors.name?.message}
                    {...register("name")}
                  />
                </Field>
                <Field htmlFor="settings-owner-contact-name" label="Owner / contact name">
                  <Input id="settings-owner-contact-name"
                    placeholder="E.g., Pardeep A"
                    error={errors.contact_name?.message}
                    {...register("contact_name")}
                  />
                </Field>
              </div>
              {/* GSTIN — full row. The "state code" is the first 2 digits
                  of this field, so we don't show a separate input for it;
                  RHF still tracks it via a hidden register (set by the
                  auto-fill useEffect higher up). */}
              <Field htmlFor="settings-gstin" label="GSTIN">
                <Input id="settings-gstin"
                  className="font-mono uppercase"
                  placeholder="e.g. 27AABCE1234D1Z9"
                  error={errors.gstin?.message}
                  {...register("gstin")}
                />
                {(() => {
                  const v = (watchedGstin ?? "").trim();
                  if (v.length < 15)        return (
                    <p className="mt-1 text-3xs text-ink-3">
                      State + state code auto-fill from the first 2 digits.
                    </p>
                  );
                  if (isValidGstin(v))      return (
                    <p className="mt-1 text-3xs text-emerald inline-flex items-center gap-1">
                      <Icon name="check_circle" size={11} /> Format + checksum match. Click Verify to confirm with GSTN.
                    </p>
                  );
                  return (
                    <p className="mt-1 text-3xs text-rose inline-flex items-center gap-1">
                      <Icon name="alert" size={11} /> {validateGstin(v).ok ? "" : (validateGstin(v) as { message: string }).message}
                    </p>
                  );
                })()}
                <GstinVerifyCard
                  gstin={watchedGstin ?? ""}
                  cached={me?.tenantGstinVerification ?? null}
                  cachedAt={me?.tenantGstinVerifiedAt}
                  onFillForm={(v) => {
                    if (v.legal_name)                  setValue("name",       v.legal_name,                  { shouldDirty: true, shouldValidate: true });
                    if (v.address)                     setValue("address",    v.address,                     { shouldDirty: true, shouldValidate: true });
                    if (v.principal_address?.pin_code) setValue("pin_code",   v.principal_address.pin_code,  { shouldDirty: true, shouldValidate: true });
                    const code = normalizeStateCode(v.state_code);
                    if (code)                          setValue("state_code", code,                          { shouldDirty: true, shouldValidate: true });
                  }}
                />
              </Field>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {/* R-250: same select as the setup wizard — the value is always a 2-digit
                    GST state code, so a typo can no longer save state_code = null. */}
                <Field htmlFor="settings-registered-state" label="Registered state">
                  <select id="settings-registered-state"
                    className="w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-amber"
                    aria-invalid={!!errors.state_code}
                    aria-describedby={errors.state_code ? "settings-registered-state-error" : undefined}
                    {...register("state_code")}
                  >
                    <option value="" disabled>Choose your state</option>
                    {GST_STATE_OPTIONS.map(({ code, name }) => (
                      <option key={code} value={code}>
                        {name} ({code})
                      </option>
                    ))}
                  </select>
                  {errors.state_code?.message && (
                    <p id="settings-registered-state-error" className="mt-1 text-3xs text-rose">
                      {errors.state_code.message}
                    </p>
                  )}
                </Field>
                <Field htmlFor="settings-pin-code" label="PIN code">
                  <Input id="settings-pin-code"
                    className="font-mono"
                    placeholder="400051"
                    maxLength={6}
                    error={errors.pin_code?.message}
                    {...register("pin_code")}
                  />
                </Field>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Field htmlFor="settings-billing-email" label="Billing email">
                  <Input id="settings-billing-email"
                    type="email"
                    className="font-mono"
                    placeholder="e.g. billing@example.in"
                    error={errors.email?.message}
                    {...register("email")}
                  />
                </Field>
                <Field htmlFor="settings-phone" label="Phone">
                  <Input id="settings-phone"
                    className="font-mono"
                    placeholder="e.g. +91 98765 43210"
                    error={errors.phone?.message}
                    {...register("phone")}
                  />
                </Field>
              </div>
              <Field htmlFor="settings-currency" label="Currency">
                <Input id="settings-currency" defaultValue="INR (₹)" readOnly title="Multi-currency support coming later" />
              </Field>
              <Field htmlFor="settings-renewal-grace-period-days" label="Renewal grace period (days)">
                <Input id="settings-renewal-grace-period-days"
                  type="number"
                  min={0}
                  max={30}
                  step={1}
                  className="font-mono"
                  placeholder="0"
                  error={errors.grace_period_days?.message}
                  {...register("grace_period_days", { valueAsNumber: true })}
                />
                <p className="mt-1 text-xs text-ink-3">
                  Buffer between renewal date and auto-suspend. 0 means service suspends the day after renewal if unpaid; up to 30 days extra.
                </p>
              </Field>
              <Field htmlFor="settings-address" label="Address">
                <textarea id="settings-address"
                  placeholder="Building, street, city, state, PIN"
                  rows={3}
                  className="w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-amber resize-none"
                  {...register("address")}
                />
                {errors.address && (
                  <p className="mt-1 text-xs text-rose">{errors.address.message}</p>
                )}
              </Field>

              {/* LUT — for exporters shipping without IGST (CGST Rule 96A). */}
              <div className="grid grid-cols-1 sm:grid-cols-[1fr_180px] gap-4">
                <Field htmlFor="settings-lut-number-exports-optional" label="LUT number (exports — optional)">
                  <Input id="settings-lut-number-exports-optional"
                    placeholder="e.g. AD290425000000X — for zero-rated exports"
                    className="font-mono"
                    error={errors.lut_number?.message}
                    {...register("lut_number")}
                  />
                  <p className="mt-1 text-xs text-ink-3">
                    Have an LUT for exports? Store its ARN here — it lets you bill international clients at 0% GST (no IGST) legally and label those sales correctly for GSTR-1.
                  </p>
                </Field>
                <Field htmlFor="settings-valid-up-to" label="Valid up to">
                  <Input id="settings-valid-up-to" type="date" error={errors.lut_valid_upto?.message} {...register("lut_valid_upto")} />
                </Field>
              </div>

              {/* UPI — prints a scan-to-pay QR on every invoice PDF. Works with
                  any UPI app and needs no Razorpay, so it can be switched on
                  today. Blank simply means no QR is printed.
                  id: the Dashboard setup checklist links here (S31, lib/onboarding/setup-links). */}
              <div id="payment-details" className="grid grid-cols-1 sm:grid-cols-2 gap-4 scroll-mt-20">
                <Field htmlFor="settings-your-upi-id-optional" label="Your UPI ID (optional)">
                  <Input id="settings-your-upi-id-optional"
                    placeholder="e.g. yourname@okhdfcbank"
                    className="font-mono"
                    error={errors.upi_vpa?.message}
                    {...register("upi_vpa")}
                  />
                  <p className="mt-1 text-xs text-ink-3">
                    Adds a <strong>scan-to-pay QR</strong> to every invoice PDF with the amount and
                    invoice number pre-filled — customers pay from GPay / PhonePe / Paytm without
                    typing anything. Money reaches your bank directly, so you still record the
                    payment here. Leave blank for no QR.
                  </p>
                </Field>
                <Field htmlFor="settings-name-shown-in-the-payer-s-upi-app" label="Name shown in the payer's UPI app">
                  <Input id="settings-name-shown-in-the-payer-s-upi-app"
                    placeholder="Defaults to your company name"
                    error={errors.upi_payee_name?.message}
                    {...register("upi_payee_name")}
                  />
                  <p className="mt-1 text-xs text-ink-3">
                    Set this only if your bank account name differs from your company name —
                    an unexpected name at the moment of paying is when customers stop.
                  </p>
                </Field>
              </div>

              {/* Bank transfer (R-038). Until this existed the invoice PDF said
                  "NEFT accepted" and gave the customer nowhere to send it — one phone
                  call per invoice, and a week of delay on each. Blank means the PDF
                  says nothing about NEFT, which is the honest output. */}
              <div className="pt-2">
                <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-3">
                  Bank transfer details (optional)
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <Field htmlFor="settings-bank-name" label="Bank name">
                    <Input id="settings-bank-name"
                      placeholder="e.g. HDFC Bank"
                      error={errors.remit_bank_name?.message}
                      {...register("remit_bank_name")}
                    />
                  </Field>
                  <Field htmlFor="settings-branch-optional" label="Branch (optional)">
                    <Input id="settings-branch-optional"
                      placeholder="e.g. Nehru Place, New Delhi"
                      error={errors.remit_branch?.message}
                      {...register("remit_branch")}
                    />
                  </Field>
                  <Field htmlFor="settings-account-name-beneficiary" label="Account name (beneficiary)">
                    <Input id="settings-account-name-beneficiary"
                      placeholder="Defaults to your company name"
                      error={errors.remit_account_name?.message}
                      {...register("remit_account_name")}
                    />
                    <p className="mt-1 text-xs text-ink-3">
                      Exactly as your bank holds it. A transfer to a name that does not match
                      is what gets bounced.
                    </p>
                  </Field>
                  <Field htmlFor="settings-account-number" label="Account number">
                    <Input id="settings-account-number"
                      placeholder="e.g. 50200012345678"
                      className="font-mono"
                      error={errors.remit_account_number?.message}
                      {...register("remit_account_number")}
                    />
                  </Field>
                  <Field htmlFor="settings-ifsc" label="IFSC">
                    <Input id="settings-ifsc"
                      placeholder="e.g. HDFC0001234"
                      className="font-mono uppercase"
                      error={errors.remit_ifsc?.message}
                      {...register("remit_ifsc")}
                    />
                    <p className="mt-1 text-xs text-ink-3">
                      Account number and IFSC together switch on the bank block on every
                      invoice PDF, with the invoice number as the payment reference. Either
                      one alone is not something a customer can transfer to, so neither is
                      printed until both are filled.
                    </p>
                  </Field>
                </div>
              </div>

              <div className="flex items-center justify-end gap-2 pt-2">
                {isDirty && (
                  <Button type="button" variant="ghost" size="sm" onClick={() => reset(defaults)}>
                    Discard
                  </Button>
                )}
                <Button
                  type="submit"
                  size="sm"
                  variant="primary"
                  icon="check"
                  loading={updateTenant.isPending}
                  disabled={!isDirty || !isOwner}
                >
                  Save changes
                </Button>
              </div>
            </fieldset>
          )}
        </form>
      </Card>

      <InvoiceNumberingCard isOwner={isOwner} />

      {/* R-262: business type + GST filing → which filings the Compliance Calendar shows. */}
      <ComplianceProfileCard isOwner={isOwner} />

      {/* R-337: aggregate turnover → e-invoice (IRN) warnings on invoices. */}
      <TurnoverCard isOwner={isOwner} />
    </div>
  );
}

// ─── Invoice numbering (R-259) ───────────────────────────────────────────────

/**
 * The owner's invoice code (tenants.doc_code) with a live preview of the next number.
 * Its own Save, separate from the company form: it goes through
 * /api/tenant/invoice-code, which checks no other business uses the code and refuses
 * once the first GST number has been issued.
 */
function InvoiceNumberingCard({ isOwner }: { isOwner: boolean }) {
  const { data: state, isError } = useInvoiceCode();
  const save = useSaveInvoiceCode();
  const [value, setValue] = React.useState("");
  const [serverError, setServerError] = React.useState<string | null>(null);
  const loaded = React.useRef(false);
  React.useEffect(() => {
    if (!state || loaded.current) return;
    loaded.current = true;
    setValue(state.saved ?? "");
  }, [state]);

  const code = normalizeInvoiceCode(value);
  const dirty = !!state && !state.locked && code !== (state.saved ?? "");
  const canSave = isOwner && dirty && !!code && !invoiceCodeProblem(code) && !save.isPending;

  const onSave = () => {
    setServerError(null);
    save.mutate(code, {
      onSuccess: (s) => { setValue(s.saved ?? ""); toast.success(`Invoice code set — next invoice ${s.preview}`); },
      onError: (e) => setServerError((e as Error).message),
    });
  };

  return (
    /* id: the setup checklist and the "Could not allocate a number" toast link here (S31). */
    <Card id="invoice-numbering" className="p-5 max-w-3xl scroll-mt-20">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-sm font-semibold text-ink">Invoice numbering</p>
        {state?.locked && <Badge kind="muted">Locked</Badge>}
        {!isOwner && !state?.locked && <Badge kind="muted">Owner-only · view</Badge>}
      </div>
      {isError ? (
        <p className="text-xs text-rose">Could not load invoice numbering. Refresh to try again.</p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-start">
          <Field htmlFor="settings-invoice-code" label="Invoice code (2–4 letters)">
            <InvoiceCodeField
              id="settings-invoice-code"
              value={value}
              onChange={(v) => { setServerError(null); setValue(v); }}
              state={state}
              disabled={!isOwner || save.isPending}
              serverError={serverError}
            />
          </Field>
          {state && !state.locked && isOwner && (
            <div className="flex items-center gap-2 sm:pt-5">
              <Button type="button" size="sm" variant="primary" icon="check" loading={save.isPending} disabled={!canSave} onClick={onSave}>
                Save code
              </Button>
              {dirty && (
                <Button type="button" variant="ghost" size="sm" onClick={() => { setServerError(null); setValue(state.saved ?? ""); }}>
                  Discard
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

// ─── Reseller hierarchy card (migration 0040)────────────────────────────────

/**
 * ResellerTierCard — surfaces this tenant's place in the parent-child
 * distributor / reseller hierarchy.
 *
 * Reads from the `v_tenant_with_parent` view (added in 0040_reseller_hierarchy).
 * The view's RLS is layered: the tenant always sees its own row, and if its
 * `parent_tenant_id` is set the additive policy lets it read the parent's
 * display fields (name / tier / gstin) — nothing else.
 *
 * Slice 0: read-only. Settings to declare-self-distributor or pick a parent
 * land in Slice 1 (Partner Catalog) when there's a concrete reason to wire
 * the link from the UI.
 */
function ResellerTierCard() {
  const { data: me } = useCurrentUser();
  const isOwner = me?.role === "owner";

  // The view's LEFT JOIN gets blocked by RLS for the parent's row, so we go
  // through a SECURITY DEFINER RPC that returns only the calling user's own
  // tenant + its parent's display fields. See migration 0040.
  const { data, isLoading } = useQuery({
    enabled: Boolean(me?.tenantId),
    queryKey: ["tenant", "hierarchy", me?.tenantId],
    queryFn: async (): Promise<TenantWithParent | null> => {
      const supabase = createClient();
      const { data, error } = await supabase.rpc("get_my_tenant_with_parent");
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      return (row as TenantWithParent | undefined) ?? null;
    },
  });

  if (!isOwner) return null;  // hide entirely for non-owners — admin-only surface
  if (isLoading) return null; // soft-fail: no shimmer needed for a 1-row read

  /* R-251: from the tenant's own row only. An independent signup (no parent, not a
     distributor) has nothing to show here, so the card is hidden. */
  const view = resellerTierView(data);
  if (!view) return null;

  return (
    <Card className="p-5 max-w-3xl">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-sm font-semibold text-ink inline-flex items-center gap-2">
          <Icon name="layout" size={14} className="text-ink-3" />
          Reseller tier
        </p>
        <Badge kind={view.isDistributor ? "success" : "muted"} dot>
          {view.badge}
        </Badge>
      </div>
      <dl className="mt-3 pt-3 border-t border-hairline space-y-1.5 text-xs">
        {view.rows.map((r) => (
          <div key={r.label} className="flex flex-wrap justify-between gap-x-3">
            <dt className="text-ink-3">{r.label}</dt>
            <dd className="text-ink font-medium break-words">{r.value}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

// ─── Integrations tab ────────────────────────────────────────────────────────

/** Functional integration card — has its own Configure dialog. */
function SandboxIntegrationCard() {
  const [open, setOpen] = React.useState(false);
  const { data: status } = useQuery({
    queryKey: ["integrations", "sandbox"],
    queryFn: async () => {
      const res = await fetch("/api/integrations/sandbox");
      return res.ok ? res.json() : null;
    },
  });
  const configured = Boolean(status?.configured);
  return (
    <>
      <div className="flex items-center justify-between rounded-lg border border-hairline p-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-paper-2 text-ink-3">
            <Icon name="check_circle" size={16} />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-medium text-ink">Sandbox.co.in</p>
            <p className="text-xs text-ink-3 truncate">
              GSTIN verification · {configured ? "Live mode" : "Mock fallback"}
            </p>
          </div>
        </div>
        <Button variant={configured ? "ghost" : "primary"} size="sm" onClick={() => setOpen(true)}>
          {configured ? "Manage" : "Setup"}
        </Button>
      </div>
      {open && <SandboxConfigureDialog open={open} onOpenChange={setOpen} />}
    </>
  );
}

/** WhatsApp Business (Meta Cloud API) — functional integration card. */
function WhatsAppIntegrationCard() {
  const [open, setOpen] = React.useState(false);
  const { data: status } = useQuery({
    queryKey: ["integrations", "whatsapp"],
    queryFn: async () => {
      const res = await fetch("/api/integrations/whatsapp");
      return res.ok ? res.json() : null;
    },
  });
  const configured = Boolean(status?.configured);
  return (
    <>
      <div className="flex items-center justify-between rounded-lg border border-hairline p-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-paper-2 text-ink-3">
            <Icon name="whatsapp" size={16} />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-medium text-ink">WhatsApp Business</p>
            <p className="text-xs text-ink-3 truncate">
              Meta Cloud API · {configured ? "Connected" : "Not configured"}
            </p>
          </div>
        </div>
        <Button variant={configured ? "ghost" : "primary"} size="sm" onClick={() => setOpen(true)}>
          {configured ? "Manage" : "Setup"}
        </Button>
      </div>
      {open && <WhatsAppConfigureDialog open={open} onOpenChange={setOpen} />}
    </>
  );
}

/** Razorpay payments — functional integration card. Mode is inferred
 *  from saved key_id prefix (rzp_test_* / rzp_live_*). */
function RazorpayIntegrationCard() {
  const [open, setOpen] = React.useState(false);
  const { data: status } = useQuery({
    queryKey: ["integrations", "razorpay"],
    queryFn: async () => {
      const res = await fetch("/api/integrations/razorpay");
      return res.ok ? res.json() : null;
    },
  });
  // Readiness comes from the server, which distinguishes "can take money" from
  // "can hear about it". A half-configured gateway used to read "Accepting
  // payments" — reassuring, and precisely wrong: payments would be collected and
  // never recorded. That state now interrupts rather than reassures.
  const readiness  = status?.readiness as RazorpayReadiness | undefined;
  const configured = Boolean(status?.configured);
  const mode       = (status?.mode as "test" | "live" | undefined) ?? "test";
  const broken     = readiness?.severity === "critical";
  return (
    <>
      <div
        className={`flex items-center justify-between rounded-lg border p-3 ${
          broken ? "border-danger/40 bg-danger/5" : "border-hairline"
        }`}
      >
        <div className="flex items-center gap-3 min-w-0">
          <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
            broken ? "bg-danger/10 text-danger" : "bg-paper-2 text-ink-3"
          }`}>
            <Icon name={broken ? "alert" : "rupee"} size={16} />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-medium text-ink inline-flex items-center gap-1.5">
              Razorpay
              {configured && (
                <Badge size="sm" kind={mode === "live" ? "success" : "warning"}>
                  {mode === "live" ? "LIVE" : "TEST"}
                </Badge>
              )}
              {broken && <Badge size="sm" kind="danger">ACTION NEEDED</Badge>}
            </p>
            {/* Not truncated when broken: the whole point is that it gets read. */}
            <p className={`text-xs ${broken ? "text-danger" : "text-ink-3 truncate"}`}>
              {readiness?.headline ?? (configured ? "Accepting payments" : "Buy page in simulation mode")}
            </p>
            {broken && readiness?.detail && (
              <p className="mt-1 text-xs text-ink-3">{readiness.detail}</p>
            )}
          </div>
        </div>
        <Button
          variant={broken || !configured ? "primary" : "ghost"}
          size="sm"
          className="shrink-0"
          onClick={() => setOpen(true)}
        >
          {broken ? "Fix" : configured ? "Manage" : "Setup"}
        </Button>
      </div>
      {open && <RazorpayConfigureDialog open={open} onOpenChange={setOpen} />}
    </>
  );
}

function GeminiIntegrationCard() {
  const [open, setOpen] = React.useState(false);
  const { data: status } = useQuery({
    queryKey: ["integrations", "gemini"],
    queryFn: async () => {
      const res = await fetch("/api/integrations/gemini");
      return res.ok ? res.json() : null;
    },
  });
  const configured = Boolean(status?.configured);
  const envFallback = Boolean(status?.env_fallback);
  return (
    <>
      <div className="flex items-center justify-between rounded-lg border border-hairline p-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-paper-2 text-amber">
            <Icon name="sparkles" size={16} />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-medium text-ink inline-flex items-center gap-1.5">
              AI assistant
              {configured
                ? <Badge size="sm" kind="success">Live</Badge>
                : envFallback
                  ? <Badge size="sm" kind="info">Shared</Badge>
                  : <Badge size="sm" kind="muted">Stub</Badge>}
            </p>
            <p className="text-xs text-ink-3 truncate">
              {configured ? "Real AI drafts + extraction" : envFallback ? "Using shared server key" : "Templates only — add a Gemini key"}
            </p>
          </div>
        </div>
        <Button variant={configured ? "ghost" : "primary"} size="sm" onClick={() => setOpen(true)}>
          {configured ? "Manage" : "Setup"}
        </Button>
      </div>
      {open && <GeminiConfigureDialog open={open} onOpenChange={setOpen} />}
    </>
  );
}

/**
 * Google Reseller API — REAL status. Probes the Reseller API (1 row) and shows
 * the honest state: connected, API-not-enabled, or needs-relogin. No fake
 * "Connected" badge — the truth, so Pardeep knows exactly what to fix.
 */
function GoogleResellerIntegrationCard() {
  const { data: status, isLoading } = useQuery({
    queryKey: ["integrations", "google-reseller"],
    queryFn: async () => {
      const res = await fetch("/api/integrations/google-reseller/subscriptions?probe=1");
      const body = await res.json().catch(() => ({}));
      return { ok: res.ok, code: body?.code as string | undefined, connected: Boolean(body?.connected) };
    },
    staleTime: 60_000,
  });

  const connected = Boolean(status?.connected);
  const sub = isLoading ? "Checking…"
    : connected ? "Connected · live sync ready"
    : status?.code === "api_disabled" ? "Enable the Reseller API in Google Cloud"
    : status?.code === "needs_reauth" ? "Re-login with reseller-admin Google account"
    : "Not connected — set up to sync subscriptions";

  return (
    <div className="flex items-center justify-between rounded-lg border border-hairline p-3">
      <div className="flex items-center gap-3 min-w-0">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-paper-2 text-ink-3">
          <Icon name="package" size={16} />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-medium text-ink inline-flex items-center gap-1.5">
            Google Reseller API
            {!isLoading && (connected
              ? <Badge size="sm" kind="success">Connected</Badge>
              : <Badge size="sm" kind="warning">Setup</Badge>)}
          </p>
          <p className="text-xs text-ink-3 truncate">{sub}</p>
        </div>
      </div>
      <Button asChild variant={connected ? "ghost" : "primary"} size="sm">
        <a href="/subscriptions">{connected ? "Sync" : "Set up"}</a>
      </Button>
    </div>
  );
}

/**
 * Google Contacts — per-user two-way sync. Connect kicks off the dedicated OAuth
 * flow (full-page redirect); once connected we show the account + last-sync and
 * offer "Sync now" / "Disconnect".
 */
function GoogleContactsIntegrationCard() {
  const [busy, setBusy] = React.useState(false);
  const { data: status, refetch } = useQuery({
    queryKey: ["integrations", "google-contacts"],
    queryFn: async () => {
      const res = await fetch("/api/integrations/google-contacts");
      return res.ok ? res.json() : null;
    },
  });
  /* Faisla yahan INLINE nahi hai — lib/google/contacts-card-state.ts me hai, aur wahan
     uske test asli payload par baithe hain. Wo file ek fail hui mutation se bani: jab ye
     branch yahan inline thi, use `false` kar dene par bhi saare test green rehte the. */
  const state = contactsCardState(status);
  const configured = state.kind !== "unconfigured";
  const needsReconsent = state.kind === "needs_reconsent";
  const connected = needsReconsent || state.kind === "ready";
  const lastSynced: string | null = state.kind === "ready" ? state.lastSyncedAt : null;

  async function syncNow() {
    setBusy(true);
    try {
      const res = await fetch("/api/integrations/google-contacts/sync", { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(body?.error ?? "Sync failed.", { description: "Nothing was changed. Try again — if it keeps failing, disconnect and connect Google Contacts again." }); return; }
      toast.success(`Synced — ${body.pulled} in, ${body.pushed + body.created} out${body.deleted ? `, ${body.deleted} deleted` : ""}`);
      refetch();
    } finally { setBusy(false); }
  }

  async function disconnect() {
    setBusy(true);
    try {
      const res = await fetch("/api/integrations/google-contacts", { method: "DELETE" });
      if (!res.ok) { toast.error("Could not disconnect.", { description: "Google Contacts is still connected. Refresh the page and try again." }); return; }
      toast.success("Google Contacts disconnected");
      refetch();
    } finally { setBusy(false); }
  }

  /* Jab permission hi nahi hai to "sales@anutech.in · synced 15 Aug" likhna sach hai aur
     bekaar hai — CLAUDE.md §24 kehta hai: kya hua, kyun, ab kya karein. Wo teeno baatein
     `last_error` me pehle se hain, isliye wahi dikhate hain. */
  const sub = state.kind === "unconfigured"
    ? "Add Google OAuth keys in env to enable"
    : state.kind === "needs_reconsent"
      ? state.reason
      : state.kind === "ready"
        ? (state.email ?? "Connected") + (lastSynced ? ` · synced ${formatDate(lastSynced)}` : " · not synced yet")
        : "Two-way sync with your Google Contacts";

  return (
    <div className="flex items-center justify-between rounded-lg border border-hairline p-3">
      <div className="flex items-center gap-3 min-w-0">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-paper-2 text-ink-3">
          <Icon name="users" size={16} />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-medium text-ink inline-flex items-center gap-1.5">
            Google Contacts
            {needsReconsent
              ? <Badge size="sm" kind="warning">Permission needed</Badge>
              : connected
                ? <Badge size="sm" kind="success">Connected</Badge>
                : configured
                  ? <Badge size="sm" kind="warning">Connect</Badge>
                  : <Badge size="sm" kind="muted">Setup</Badge>}
          </p>
          {/* Wajah wali line ko truncate NAHI karte — wahi ek line hai jo batati hai ki
              ab kya karna hai. Baaki haalat me line chhoti hai, to title= kaafi hai. */}
          <p className={needsReconsent ? "text-xs text-ink-2" : "text-xs text-ink-3 truncate"} title={sub}>{sub}</p>
        </div>
      </div>
      {needsReconsent ? (
        /* "Sync now" yahan mat do — wo Google se 403 laane wala ek button hai. §24:
           blocked haalat me wahi jagah pe le jao jahan cheez theek hoti hai. */
        <div className="flex items-center gap-1.5 shrink-0">
          <Button asChild variant="primary" size="sm">
            <a href="/api/integrations/google-contacts/connect">Reconnect</a>
          </Button>
          <Button variant="ghost" size="sm" onClick={disconnect} disabled={busy}>Disconnect</Button>
        </div>
      ) : connected ? (
        <div className="flex items-center gap-1.5 shrink-0">
          <Button variant="primary" size="sm" onClick={syncNow} loading={busy}>{busy ? "Syncing…" : "Sync now"}</Button>
          <Button variant="ghost" size="sm" onClick={disconnect} disabled={busy}>Disconnect</Button>
        </div>
      ) : configured ? (
        <Button asChild variant="primary" size="sm">
          <a href="/api/integrations/google-contacts/connect">Connect</a>
        </Button>
      ) : (
        <Button variant="ghost" size="sm" disabled>Setup</Button>
      )}
    </div>
  );
}

function IntegrationsTab() {
  return (
    <>
    {/* id: the Dashboard setup checklist links here (S31). */}
    <div id="email-sending" className="mb-4 scroll-mt-20">
      <EmailSendingCard />
    </div>
    <Card className="p-5">
      <p className="mb-4 text-sm font-semibold text-ink">Connected services</p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <GeminiIntegrationCard />
        <RazorpayIntegrationCard />
        <SandboxIntegrationCard />
        <WhatsAppIntegrationCard />
        <GoogleResellerIntegrationCard />
        <GoogleContactsIntegrationCard />
      </div>
    </Card>
    <ApiKeysCard />
    </>
  );
}

// ─── Placeholder tab ─────────────────────────────────────────────────────────

// ─── Branding tab — company logo ────────────────────────────────────────────
function BrandingTab() {
  const { data: me } = useCurrentUser();
  const setLogo = useSetTenantLogo();
  const confirm = useConfirm();
  const fileRef = React.useRef<HTMLInputElement>(null);
  const logoUrl = me?.tenantLogoUrl ?? null;

  const onPick = (f: File | null) => {
    if (!f) return;
    if (f.size > 5 * 1024 * 1024) { toast.error("Logo must be under 5 MB.", { description: "Pick a smaller file, or compress it (a PNG or JPG around 500 KB is plenty)." }); return; }
    setLogo.mutate(f);
  };

  return (
    <Card className="p-5 md:p-6 max-w-2xl">
      <h2 className="font-serif text-xl text-ink">Company logo</h2>
      <p className="text-sm text-ink-3 mt-1 mb-5">
        Shown in the sidebar and on customer-facing pages (enquiry form, quotations). PNG / JPG / WEBP / SVG, up to 5 MB. A square or wide logo on a transparent background works best.
      </p>

      <div className="flex items-center gap-5 flex-wrap">
        {/* Preview */}
        <div className="h-24 w-24 rounded-xl border border-hairline bg-paper-2/40 grid place-items-center overflow-hidden shrink-0">
          {logoUrl ? (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img src={logoUrl} alt="Company logo" className="max-h-full max-w-full object-contain" />
          ) : (
            <span className="font-serif text-3xl text-ink-3">{(me?.tenantName ?? "?").charAt(0).toUpperCase()}</span>
          )}
        </div>

        <div className="flex flex-col gap-2">
          <input
            ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml"
            className="hidden" onChange={(e) => onPick(e.target.files?.[0] ?? null)}
          />
          <div className="flex gap-2 flex-wrap">
            <Button variant="primary" icon="upload" loading={setLogo.isPending} onClick={() => fileRef.current?.click()}>
              {logoUrl ? "Change logo" : "Upload logo"}
            </Button>
            {logoUrl && (
              <Button variant="ghost" icon="trash" disabled={setLogo.isPending}
                onClick={async () => { if (await confirm({ title: "Remove the company logo?", danger: true, confirmLabel: "Remove" })) setLogo.mutate(null); }}>
                Remove
              </Button>
            )}
          </div>
          <p className="text-2xs text-ink-3 max-w-xs">
            Tip: a transparent PNG around 512×512 (or a wide 4:1 banner) looks crispest.
          </p>
        </div>
      </div>
    </Card>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

/* useSearchParams() needs a Suspense boundary or Next refuses to prerender the page. */
export default function SettingsPage() {
  return (
    <React.Suspense fallback={null}>
      <SettingsPageInner />
    </React.Suspense>
  );
}

function SettingsPageInner() {
  /* R-252: the tab is the URL's ?tab=, so deep links (Google callbacks, AI Help, inbox
     chips) land on the tab they name and Back/Forward move between tabs. */
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const tab = resolveSettingsTab(params.get("tab"), TABS.map((t) => t.id));
  /* S31: #invoice-numbering / #payment-details / #email-sending from the setup checklist. */
  useScrollToHash(tab);
  const confirm = useConfirm();
  const companyDirty = React.useRef(false);
  const onCompanyDirty = React.useCallback((d: boolean) => { companyDirty.current = d; }, []);

  const changeTab = async (next: string) => {
    if (next === tab) return;
    if (tab === "company" && companyDirty.current && !(await confirm({
      title: "Discard unsaved changes?",
      body: "Your company details have changes that are not saved. Switching tabs will lose them.",
      confirmLabel: "Discard",
      danger: true,
    }))) return;
    companyDirty.current = false;
    router.replace(settingsTabHref(pathname, params.toString(), next) as never, { scroll: false });
  };

  return (
    <div className="mx-auto max-w-[1240px] p-4 md:p-6 lg:p-8 pb-20">
      {/* ── Page header ── */}
      <div className="mb-6">
        <p className="mb-0.5 text-xs font-medium uppercase tracking-widest text-ink-3">
          System
        </p>
        <h1 className="font-serif text-3xl text-ink">Settings</h1>
        <p className="mt-1 text-sm text-ink-3">
          Configure your reseller business · Team management lives on the <Link href="/team" className="font-medium text-ink-2 underline underline-offset-2 hover:text-amber-ink">Team page</Link>
        </p>
      </div>

      {/* ── Tabs ── */}
      <div className="mb-6">
        <TabBar items={TABS} value={tab} onChange={(v) => { void changeTab(v); }} />
      </div>

      {/* ── Tab content ── */}
      {tab === "company"       && <CompanyTab onDirtyChange={onCompanyDirty} />}
      {tab === "integrations"  && <IntegrationsTab />}
      {tab === "branding"      && <BrandingTab />}
      {tab === "notifications" && <NotificationsCard />}
      {tab === "security"      && <div className="max-w-md"><ChangePasswordCard /><TwoFactorCard /></div>}
    </div>
  );
}
