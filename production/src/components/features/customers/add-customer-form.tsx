/**
 * AddCustomerForm — the side-SHEET customer form.
 *
 * Used where a full page navigation would lose context — most importantly the
 * quote builder's inline "＋ New customer" (you're mid-invoice, we can't throw
 * away the draft). The primary add/edit entry points (customers list + detail)
 * use the full-page form instead (`/customers/new`, `/customers/[id]/edit`).
 *
 * All logic lives in {@link useCustomerForm}; this file is just the sheet chrome
 * + the stacked field layout that suits a narrow 520px panel.
 */
"use client";

import * as React from "react";

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
import { Icon } from "@/components/ui/icon";
import { Button } from "@/components/ui/button";
import { isValidGstin, validateGstin, GST_STATE_BY_CODE } from "@/lib/utils";
import GstinVerifyCard from "@/components/features/gstin/gstin-verify-card";
import { COUNTRIES } from "@/lib/gst/countries";
import { useCustomerForm } from "./use-customer-form";
import type { Customer } from "@/lib/supabase/database.types";

interface AddCustomerFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** When provided, the form opens in EDIT mode (prefilled + updates this customer). */
  customer?: Customer | null;
  /** Called with the new customer's id after a successful CREATE (lets a caller auto-select it). */
  onCreated?: (id: string) => void;
}

export function AddCustomerForm({ open, onOpenChange, customer, onCreated }: AddCustomerFormProps) {
  const {
    register, setValue, watch, errors, isSubmitting, isPending, isEdit,
    contactPersonFields, appendContactPerson, removeContactPerson,
    verification, setVerification, watchedGstin,
    provisionCustomerPanel, setProvisionCustomerPanel,
    isForeign, foreignStates, countryReg, onCountryChange, submit,
  } = useCustomerForm({
    customer,
    open,
    onSaved: (id) => {
      if (!isEdit) onCreated?.(id);
      onOpenChange(false);
    },
  });

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-[520px] md:max-w-[600px] p-0 flex flex-col overflow-x-hidden"
      >
        <SheetHeader>
          <SheetTitle>{isEdit ? "Edit customer" : "Add a customer"}</SheetTitle>
          <SheetDescription>
            {isEdit
              ? "Update this customer's details. Company name = the customer; contact = the person."
              : isForeign
                ? "International customer — GST/GSTIN doesn't apply. Add their business details below."
                : "Pick the country. For India, type the GSTIN first — we'll verify with GSTN and auto-fill the rest."}
          </SheetDescription>
        </SheetHeader>

        <form onSubmit={submit} className="flex flex-col flex-1 min-h-0 min-w-0 w-full">
          <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-4">
          {/* Country FIRST — it decides the whole form: India = GST flow (GSTIN,
              state code, 6-digit PIN); anything else = export flow (no GST). */}
          <FormField label="Country" htmlFor="country">
            <select
              id="country"
              className="w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-amber/40"
              {...countryReg}
              onChange={onCountryChange}
            >
              {COUNTRIES.map((ctry) => <option key={ctry} value={ctry}>{ctry}</option>)}
            </select>
            {isForeign && (
              <p className="mt-1 flex items-start gap-1 text-[11px] leading-snug text-indigo-ink">
                <span>🌍</span>
                <span>
                  <b>Export customer.</b> Supplies to this customer are <b>zero-rated</b> (no CGST/SGST/IGST)
                  under LUT. The GST invoice will carry the export declaration instead of a tax split.
                </span>
              </p>
            )}
          </FormField>

          {/* GSTIN — India only. An export customer has no GSTIN. */}
          {!isForeign && (
          <FormField label="GSTIN (recommended)" htmlFor="gstin">
            <Input
              id="gstin"
              placeholder="e.g. 07ABDCA0298H1ZP"
              className="font-mono uppercase"
              error={errors.gstin?.message}
              {...register("gstin")}
            />
            {(() => {
              const v = (watchedGstin ?? "").trim();
              if (v.length < 15) return (
                <p className="mt-1 text-[10px] text-ink-3">
                  State + code auto-fill from the first 2 digits. Then click Verify with GSTN to confirm + auto-fill.
                </p>
              );
              if (isValidGstin(v)) return (
                <p className="mt-1 text-[10px] text-emerald inline-flex items-center gap-1">
                  <Icon name="check_circle" size={11} /> Format + checksum match. Click Verify to confirm.
                </p>
              );
              const r = validateGstin(v);
              return (
                <p className="mt-1 text-[10px] text-rose inline-flex items-center gap-1">
                  <Icon name="alert" size={11} /> {r.ok ? "" : r.message}
                </p>
              );
            })()}
            <GstinVerifyCard
              gstin={watchedGstin ?? ""}
              cached={verification}
              cachedAt={null}
              noPersist  /* don't save yet — customer doesn't exist; ride payload along on submit */
              onVerified={(v) => setVerification(v)}
              onFillForm={(v) => {
                if (v.legal_name)                  setValue("name",       v.legal_name,                  { shouldDirty: true, shouldValidate: true });
                if (v.address)                     setValue("address",    v.address,                     { shouldDirty: true, shouldValidate: true });
                if (v.principal_address?.pin_code) setValue("pin_code",   v.principal_address.pin_code,  { shouldDirty: true, shouldValidate: true });
                if (v.state_code) {
                  setValue("state_code", v.state_code,                                            { shouldDirty: true, shouldValidate: true });
                  const name = GST_STATE_BY_CODE[v.state_code];
                  if (name) setValue("state",      name,                                          { shouldDirty: true, shouldValidate: true });
                }
              }}
            />
          </FormField>
          )}

          {/* Hidden — derived from GSTIN (India only). Kept in form data so GST
              math and invoice PDFs have the canonical 2-digit code on save. */}
          <input type="hidden" {...register("state_code")} />

          {/* Company name — auto-filled by Fill from GST, manually editable too. */}
          <FormField label="Company name" required htmlFor="name">
            <Input id="name" placeholder="e.g. Acme Corp Pvt Ltd" error={errors.name?.message} {...register("name")} />
          </FormField>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <FormField label={isForeign ? "State / Province" : "Registered state"} htmlFor="state">
              {foreignStates ? (
                <select
                  id="state"
                  className="w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-amber/40"
                  {...register("state")}
                >
                  <option value="">Select state / province…</option>
                  {/* Preserve a legacy / differently-cased existing value so editing
                      an older customer never silently drops their saved state. */}
                  {watch("state") && !foreignStates.some((st) => st.toLowerCase() === watch("state")!.toLowerCase()) && (
                    <option value={watch("state")!}>{watch("state")}</option>
                  )}
                  {foreignStates.map((st) => <option key={st} value={st}>{st}</option>)}
                </select>
              ) : (
                <Input id="state" placeholder={isForeign ? "e.g. California" : "Auto-filled from GSTIN"} {...register("state")} />
              )}
            </FormField>
            <FormField label={isForeign ? "Postal / ZIP code" : "PIN code"} htmlFor="pin_code">
              <Input
                id="pin_code"
                className="font-mono"
                placeholder={isForeign ? "e.g. 10001" : "400051"}
                maxLength={isForeign ? 12 : 6}
                error={errors.pin_code?.message}
                {...register("pin_code")}
              />
            </FormField>
          </div>

          <FormField label="Billing address" htmlFor="address">
            <textarea
              id="address"
              rows={2}
              placeholder={isForeign ? "Street / building — appears on the invoice" : "Auto-filled from GSTIN — appears on every GST invoice"}
              className="w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-amber resize-none"
              {...register("address")}
            />
          </FormField>

          <FormField label="City" htmlFor="city">
            <Input id="city" placeholder="e.g. Mumbai" {...register("city")} />
          </FormField>

          <FormField label="Company website (optional)" htmlFor="domain">
            <Input id="domain" placeholder="e.g. acmecorp.com" {...register("domain")} />
          </FormField>

          <div className="h-px bg-hairline" />

          {/* ── Primary contact person (salutation + first + last, Zoho-style) ── */}
          <p className="text-xs font-semibold uppercase tracking-wider text-ink-3">Primary contact</p>
          <div className="grid grid-cols-[80px_1fr_1fr] gap-3">
            <FormField label="Title" htmlFor="contact_salutation">
              <select
                id="contact_salutation"
                className="w-full rounded-md border border-hairline bg-paper px-2 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-amber/40"
                {...register("contact_salutation")}
              >
                <option value="">—</option>
                <option value="Mr.">Mr.</option>
                <option value="Ms.">Ms.</option>
                <option value="Mrs.">Mrs.</option>
                <option value="Dr.">Dr.</option>
              </select>
            </FormField>
            <FormField label="First name" htmlFor="contact_first_name">
              <Input id="contact_first_name" placeholder="e.g. Rajesh" {...register("contact_first_name")} />
            </FormField>
            <FormField label="Last name" htmlFor="contact_last_name">
              <Input id="contact_last_name" placeholder="e.g. Kumar" {...register("contact_last_name")} />
            </FormField>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <FormField label="Designation" htmlFor="contact_title">
              <Input id="contact_title" placeholder="e.g. CTO" {...register("contact_title")} />
            </FormField>
            <FormField label="Email" htmlFor="contact_email">
              <Input id="contact_email" type="email" placeholder="e.g. rajesh@acme.com" error={errors.contact_email?.message} {...register("contact_email")} />
            </FormField>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <FormField label="Work phone" htmlFor="contact_phone">
              <Input id="contact_phone" placeholder="e.g. +91 98765 43210" {...register("contact_phone")} />
            </FormField>
            <FormField label="Mobile" htmlFor="contact_mobile">
              <Input id="contact_mobile" placeholder="e.g. +91 98765 43210" {...register("contact_mobile")} />
            </FormField>
          </div>

          {/* ── Additional contact persons ── */}
          <div className="h-px bg-hairline" />
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold uppercase tracking-wider text-ink-3">Other contacts</p>
            <Button
              type="button" variant="ghost" size="sm" icon="plus"
              onClick={() => appendContactPerson({ salutation: "", first_name: "", last_name: "", email: "", phone: "", mobile: "", designation: "" })}
            >
              Add person
            </Button>
          </div>
          {contactPersonFields.length === 0 ? (
            <p className="text-[11px] text-ink-3">Add accounts / procurement / other people at this customer.</p>
          ) : (
            <div className="space-y-3">
              {contactPersonFields.map((f, i) => (
                <div key={f.id} className="rounded-lg border border-hairline p-3 space-y-2 relative">
                  <button
                    type="button"
                    onClick={() => removeContactPerson(i)}
                    className="absolute top-2 right-2 text-ink-3 hover:text-rose"
                    aria-label="Remove contact"
                  >
                    <Icon name="x" size={14} />
                  </button>
                  <div className="grid grid-cols-2 gap-2">
                    <Input placeholder="First name" {...register(`contact_persons.${i}.first_name`)} />
                    <Input placeholder="Last name" {...register(`contact_persons.${i}.last_name`)} />
                  </div>
                  <Input placeholder="Email" type="email" {...register(`contact_persons.${i}.email`)} />
                  <div className="grid grid-cols-2 gap-2">
                    <Input placeholder="Work phone" {...register(`contact_persons.${i}.phone`)} />
                    <Input placeholder="Mobile" {...register(`contact_persons.${i}.mobile`)} />
                  </div>
                  <Input placeholder="Designation (e.g. Accounts)" {...register(`contact_persons.${i}.designation`)} />
                </div>
              ))}
            </div>
          )}

          {/* ── Preferences: default invoice payment terms ── */}
          <div className="h-px bg-hairline" />
          <FormField label="Default payment terms" htmlFor="payment_terms_days">
            <select
              id="payment_terms_days"
              className="w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-amber/40"
              {...register("payment_terms_days")}
            >
              <option value="">Default (Net 30)</option>
              <option value="0">Due on receipt</option>
              <option value="15">Net 15</option>
              <option value="30">Net 30</option>
              <option value="45">Net 45</option>
            </select>
            <p className="text-[11px] text-ink-3 mt-1">Pre-fills the due date when you invoice this customer.</p>
          </FormField>

          {/* ── Shipping address (separate from billing) ── */}
          <div className="h-px bg-hairline" />
          <p className="text-xs font-semibold uppercase tracking-wider text-ink-3">Shipping address (optional)</p>
          <FormField label="Attention" htmlFor="ship_attention">
            <Input id="ship_attention" placeholder="Person / department" {...register("shipping.attention")} />
          </FormField>
          <FormField label="Address" htmlFor="ship_address">
            <textarea
              id="ship_address"
              rows={2}
              placeholder="Shipping address (if different from billing)"
              className="w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-amber resize-none"
              {...register("shipping.address")}
            />
          </FormField>
          <div className="grid grid-cols-2 gap-3">
            <FormField label="City" htmlFor="ship_city">
              <Input id="ship_city" placeholder="City" {...register("shipping.city")} />
            </FormField>
            <FormField label="State / Province" htmlFor="ship_state">
              <Input id="ship_state" placeholder="State" {...register("shipping.state")} />
            </FormField>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Postal / ZIP" htmlFor="ship_zip">
              <Input id="ship_zip" placeholder="ZIP" {...register("shipping.zip")} />
            </FormField>
            <FormField label="Country" htmlFor="ship_country">
              <Input id="ship_country" placeholder="Country" {...register("shipping.country")} />
            </FormField>
          </div>

          {!isEdit && (
            <label className="flex items-center gap-2 text-sm text-ink-2">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-hairline"
                checked={provisionCustomerPanel}
                onChange={(e) => setProvisionCustomerPanel(e.target.checked)}
              />
              Also create Customer Panel account for this customer
            </label>
          )}

          </div>  {/* close scrollable form body */}

          <SheetFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={isSubmitting || isPending}>
              {isEdit ? "Save changes" : "Add customer"}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}
