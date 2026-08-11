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
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { useUpdateTenant, useSetTenantLogo } from "@/lib/queries/tenant";
import { isValidGstin, gstStateFromGstin, validateGstin, formatDate } from "@/lib/utils";
import GstinVerifyCard from "@/components/features/gstin/gstin-verify-card";
import SandboxConfigureDialog  from "@/components/features/integrations/sandbox-configure-dialog";
import WhatsAppConfigureDialog from "@/components/features/integrations/whatsapp-configure-dialog";
import RazorpayConfigureDialog from "@/components/features/integrations/razorpay-configure-dialog";
import GeminiConfigureDialog from "@/components/features/integrations/gemini-configure-dialog";
import ApiKeysCard from "@/components/features/integrations/api-keys-card";
import { useConfirm } from "@/components/providers/confirm-provider";
import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import type { TenantWithParent } from "@/lib/supabase/database.types";

// ─── Demo data ────────────────────────────────────────────────────────────────
// Team roster moved to its own /team page. Settings only owns the
// non-people configuration surfaces (company identity, integrations,
// branding, notifications, security).

// Placeholder integrations — these aren't wired yet, but show the
// roadmap to Pardeep. Functional cards (Sandbox, WhatsApp) live as
// their own components above the placeholder list.
const INTEGRATIONS = [
  { name: "Microsoft Partner",   sub: "Not configured",          status: "warn", icon: "shield"   },
] as const;

const TABS: TabBarItem[] = [
  { id: "company",       label: "Company"       },
  { id: "integrations",  label: "Integrations"  },
  { id: "branding",      label: "Branding"      },
  // Notifications + Security tabs intentionally omitted until they do something real —
  // a "Coming soon" dead-end reads as half-built to a non-technical owner.
];

// ─── Field wrapper ────────────────────────────────────────────────────────────

function Field({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <label className="mb-1 block text-xs font-medium text-ink-3">{label}</label>
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
  state:      z.string().trim().max(40).optional(),
  state_code: z.string().trim().regex(/^\d{0,2}$/, "1–2 digit code (e.g. 27)").optional(),
  email:      z.string().email("Invalid email").or(z.literal("")).optional(),
  phone:      z.string().trim().max(20).optional(),
  address:    z.string().trim().max(300).optional(),
  pin_code:   z.string().trim().regex(/^\d{0,6}$/, "6-digit PIN (or blank)").optional(),
  lut_number:     z.string().trim().max(40).optional(),
  lut_valid_upto: z.string().trim().optional(),
  grace_period_days: z.coerce
    .number({ invalid_type_error: "Must be a number" })
    .int("Whole days only")
    .min(0, "Cannot be negative")
    .max(30, "Max 30 days"),
});
type CompanyForm = z.infer<typeof companySchema>;

function CompanyTab() {
  const { data: me, isLoading } = useCurrentUser();
  const updateTenant = useUpdateTenant();
  const isOwner = me?.role === "owner";

  const defaults: CompanyForm = React.useMemo(
    () => ({
      name:         me?.tenantName        ?? "",
      contact_name: me?.tenantContactName ?? "",
      gstin:        me?.tenantGstin       ?? "",
      state:        me?.tenantState       ?? "",
      state_code:   me?.tenantStateCode   ?? "",
      email:        me?.tenantEmail       ?? "",
      phone:        me?.tenantPhone       ?? "",
      address:      me?.tenantAddress     ?? "",
      pin_code:     me?.tenantPinCode     ?? "",
      lut_number:     me?.tenantLutNumber    ?? "",
      lut_valid_upto: me?.tenantLutValidUpto ?? "",
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

  // Refresh defaults once useCurrentUser settles
  React.useEffect(() => { reset(defaults); }, [defaults, reset]);

  // Auto-derive state + state_code from GSTIN.
  // First 2 digits of a GSTIN encode the state per GSTN master list.
  // Mark fields dirty so the form's "Save changes" button activates.
  const watchedGstin = watch("gstin");
  React.useEffect(() => {
    const { code, name } = gstStateFromGstin(watchedGstin ?? "");
    if (code) setValue("state_code", code, { shouldDirty: true, shouldValidate: true });
    if (name) setValue("state",      name, { shouldDirty: true, shouldValidate: true });
  }, [watchedGstin, setValue]);

  const onSubmit = (values: CompanyForm) => {
    // Normalize empty strings to null so DB nulls stay null and constraints are honored
    const patch = {
      name:         values.name.trim(),
      contact_name: values.contact_name?.trim() || null,
      gstin:        values.gstin?.trim()        || null,
      state:        values.state?.trim()        || null,
      state_code:   values.state_code?.trim()   || null,
      email:        values.email?.trim()        || me?.tenantEmail || "",  // keep existing if blanked — email is NOT NULL on tenants
      phone:        values.phone?.trim()        || null,
      address:      values.address?.trim()      || null,
      pin_code:     values.pin_code?.trim()     || null,
      lut_number:     values.lut_number?.trim()     || null,
      lut_valid_upto: values.lut_valid_upto?.trim() || null,
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
              <div className="grid grid-cols-2 gap-3">
                <Field label="Legal name *">
                  <Input
                    placeholder="E.g., Excel Technologies Pvt Ltd"
                    error={errors.name?.message}
                    {...register("name")}
                  />
                </Field>
                <Field label="Owner / contact name">
                  <Input
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
              <Field label="GSTIN">
                <Input
                  className="font-mono uppercase"
                  placeholder="e.g. 27AABCE1234D1Z9"
                  error={errors.gstin?.message}
                  {...register("gstin")}
                />
                {(() => {
                  const v = (watchedGstin ?? "").trim();
                  if (v.length < 15)        return (
                    <p className="mt-1 text-[10px] text-ink-3">
                      State + state code auto-fill from the first 2 digits.
                    </p>
                  );
                  if (isValidGstin(v))      return (
                    <p className="mt-1 text-[10px] text-emerald inline-flex items-center gap-1">
                      <Icon name="check_circle" size={11} /> Format + checksum match. Click Verify to confirm with GSTN.
                    </p>
                  );
                  return (
                    <p className="mt-1 text-[10px] text-rose inline-flex items-center gap-1">
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
                    if (v.state_code)                  setValue("state_code", v.state_code,                  { shouldDirty: true, shouldValidate: true });
                  }}
                />
              </Field>

              {/* Hidden state_code — derived from GSTIN, but RHF still
                  manages it so the form submission carries the value. */}
              <input type="hidden" {...register("state_code")} />

              <div className="grid grid-cols-2 gap-3">
                <Field label="Registered state">
                  <Input
                    placeholder="Auto-filled from GSTIN — usually no need to edit"
                    error={errors.state?.message}
                    {...register("state")}
                  />
                </Field>
                <Field label="PIN code">
                  <Input
                    className="font-mono"
                    placeholder="400051"
                    maxLength={6}
                    error={errors.pin_code?.message}
                    {...register("pin_code")}
                  />
                </Field>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Billing email">
                  <Input
                    type="email"
                    className="font-mono"
                    placeholder="e.g. billing@example.in"
                    error={errors.email?.message}
                    {...register("email")}
                  />
                </Field>
                <Field label="Phone">
                  <Input
                    className="font-mono"
                    placeholder="e.g. +91 98765 43210"
                    error={errors.phone?.message}
                    {...register("phone")}
                  />
                </Field>
              </div>
              <Field label="Currency">
                <Input defaultValue="INR (₹)" readOnly title="Multi-currency support coming later" />
              </Field>
              <Field label="Renewal grace period (days)">
                <Input
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
              <Field label="Address">
                <textarea
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
                <Field label="LUT number (exports — optional)">
                  <Input
                    placeholder="e.g. AD290425000000X — for zero-rated exports"
                    className="font-mono"
                    error={errors.lut_number?.message}
                    {...register("lut_number")}
                  />
                  <p className="mt-1 text-xs text-ink-3">
                    Have an LUT for exports? Store its ARN here — it lets you bill international clients at 0% GST (no IGST) legally and label those sales correctly for GSTR-1.
                  </p>
                </Field>
                <Field label="Valid up to">
                  <Input type="date" error={errors.lut_valid_upto?.message} {...register("lut_valid_upto")} />
                </Field>
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
    </div>
  );
}

// ─── Reseller hierarchy card (migration 0040) ────────────────────────────────

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

  const tier         = data?.tier ?? "reseller";
  const isDistributor = tier === "distributor";
  const parentName   = data?.parent_name;

  return (
    <Card className="p-5 max-w-3xl">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-sm font-semibold text-ink inline-flex items-center gap-2">
          <Icon name="layout" size={14} className="text-ink-3" />
          Reseller tier
        </p>
        <Badge kind={isDistributor ? "success" : "muted"} dot>
          {isDistributor ? "Distributor" : "Reseller"}
        </Badge>
      </div>

      {/* Three cases:
          1. Distributor (has or will have children) — Excel Tech
          2. Reseller with parent — Anutech Digital
          3. Reseller without parent — independent peer tenant (most signups) */}
      {isDistributor ? (
        <div className="space-y-2 text-xs text-ink-3 leading-relaxed">
          <p>
            <span className="text-ink-2 font-medium">{data?.name}</span> is a <b>master reseller / distributor</b>.
            Sub-resellers (children) can buy from this tenant's catalog at wholesale rates.
          </p>
          <p className="text-[11px] text-ink-3">
            Managing children · publishing a Partner Catalog · cross-tenant invoice mirroring — all unlock in a later release.
          </p>
        </div>
      ) : parentName ? (
        <div className="space-y-2 text-xs text-ink-3 leading-relaxed">
          <p>
            Wholesale supplier: <span className="text-ink-2 font-medium">{parentName}</span>
            <span className="ml-2 inline-flex items-center gap-1 text-[10px] text-ink-3 font-mono">
              <Icon name="link" size={10} /> hierarchy linked
            </span>
          </p>
          <p className="text-[11px] text-ink-3">
            Syncing SKUs from the distributor's catalog · auto vendor-bill on parent invoices · renewal sync — all unlock in a later release.
          </p>
        </div>
      ) : (
        <div className="space-y-2 text-xs text-ink-3 leading-relaxed">
          <p>
            Independent reseller — not attached to any distributor. You serve your own customers directly and manage your own catalog.
          </p>
          <p className="text-[11px] text-ink-3">
            If you buy wholesale from a master reseller (distributor) and resell onward, you'll get an option to link them in a later release.
          </p>
        </div>
      )}
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
  const configured = Boolean(status?.configured);
  const mode       = (status?.mode as "test" | "live" | undefined) ?? "test";
  return (
    <>
      <div className="flex items-center justify-between rounded-lg border border-hairline p-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-paper-2 text-ink-3">
            <Icon name="rupee" size={16} />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-medium text-ink inline-flex items-center gap-1.5">
              Razorpay
              {configured && (
                <Badge size="sm" kind={mode === "live" ? "success" : "warning"}>
                  {mode === "live" ? "LIVE" : "TEST"}
                </Badge>
              )}
            </p>
            <p className="text-xs text-ink-3 truncate">
              {configured ? "Accepting payments" : "Buy page in simulation mode"}
            </p>
          </div>
        </div>
        <Button variant={configured ? "ghost" : "primary"} size="sm" onClick={() => setOpen(true)}>
          {configured ? "Manage" : "Setup"}
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
  const configured = Boolean(status?.configured);
  const connected = Boolean(status?.connected);
  const lastSynced: string | null = status?.last_synced_at ?? null;

  async function syncNow() {
    setBusy(true);
    try {
      const res = await fetch("/api/integrations/google-contacts/sync", { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(body?.error ?? "Sync failed"); return; }
      toast.success(`Synced — ${body.pulled} in, ${body.pushed + body.created} out${body.deleted ? `, ${body.deleted} deleted` : ""}`);
      refetch();
    } finally { setBusy(false); }
  }

  async function disconnect() {
    setBusy(true);
    try {
      const res = await fetch("/api/integrations/google-contacts", { method: "DELETE" });
      if (!res.ok) { toast.error("Could not disconnect"); return; }
      toast.success("Google Contacts disconnected");
      refetch();
    } finally { setBusy(false); }
  }

  const sub = !configured
    ? "Add Google OAuth keys in env to enable"
    : connected
      ? (status?.email ? `${status.email}` : "Connected") + (lastSynced ? ` · synced ${formatDate(lastSynced)}` : " · not synced yet")
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
            {connected
              ? <Badge size="sm" kind="success">Connected</Badge>
              : configured
                ? <Badge size="sm" kind="warning">Connect</Badge>
                : <Badge size="sm" kind="muted">Setup</Badge>}
          </p>
          <p className="text-xs text-ink-3 truncate">{sub}</p>
        </div>
      </div>
      {connected ? (
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
    <Card className="p-5">
      <p className="mb-4 text-sm font-semibold text-ink">Connected services</p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <GeminiIntegrationCard />
        <RazorpayIntegrationCard />
        <SandboxIntegrationCard />
        <WhatsAppIntegrationCard />
        <GoogleResellerIntegrationCard />
        <GoogleContactsIntegrationCard />
        {INTEGRATIONS.map((it) => (
          <div
            key={it.name}
            className="flex items-center justify-between rounded-lg border border-hairline p-3"
          >
            <div className="flex items-center gap-3">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-paper-2 text-ink-3">
                <Icon name={it.icon} size={16} />
              </div>
              <div>
                <p className="text-sm font-medium text-ink">{it.name}</p>
                <p className="text-xs text-ink-3">{it.sub}</p>
              </div>
            </div>
            <Button
              variant="default"
              size="sm"
              onClick={() => toast.info(`Setting up ${it.name}`)}
            >
              Setup
            </Button>
          </div>
        ))}
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
    if (f.size > 5 * 1024 * 1024) { toast.error("Logo must be under 5 MB"); return; }
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
          <p className="text-[11px] text-ink-3 max-w-xs">
            Tip: a transparent PNG around 512×512 (or a wide 4:1 banner) looks crispest.
          </p>
        </div>
      </div>
    </Card>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function SettingsPage() {
  const [tab, setTab] = React.useState("company");

  return (
    <div className="mx-auto max-w-[1240px] p-4 md:p-6 lg:p-8 pb-20">
      {/* ── Page header ── */}
      <div className="mb-6">
        <p className="mb-0.5 text-xs font-medium uppercase tracking-widest text-ink-3">
          System
        </p>
        <h1 className="font-serif text-3xl text-ink">Settings</h1>
        <p className="mt-1 text-sm text-ink-3">
          Configure your reseller business · Team management lives at <span className="font-medium text-ink-2">/team</span>
        </p>
      </div>

      {/* ── Tabs ── */}
      <div className="mb-6">
        <TabBar items={TABS} value={tab} onChange={setTab} />
      </div>

      {/* ── Tab content ── */}
      {tab === "company"       && <CompanyTab />}
      {tab === "integrations"  && <IntegrationsTab />}
      {tab === "branding"      && <BrandingTab />}
    </div>
  );
}
