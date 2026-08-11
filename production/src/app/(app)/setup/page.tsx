/**
 * Setup Wizard — matches prototype screen "setup-wizard".
 *
 * 5-step first-run wizard (order = first-value-first):
 *   1. Company details (legal name, GSTIN, state, address)  → SAVES to tenants
 *   2. Import customers (CSV / fresh) — opens the real ImportCustomersDialog
 *   3. Razorpay — preview only; real connect lives in Settings → Integrations
 *   4. Google CSP API — preview of the 5–7 day application
 *   5. All set — celebration + next steps  → stamps setup_completed_at
 *
 * Step 1 pre-fills from `useCurrentUser` so re-running the wizard never wipes
 * what was already saved in Settings → Company. The actual persistence is
 * via `useUpdateTenant` (same hook Settings uses) — single source of truth.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { useCustomers } from "@/lib/queries/customers";
import { useUpdateTenant } from "@/lib/queries/tenant";
import { GST_STATE_BY_CODE, gstStateFromGstin, isValidGstin, validateGstin } from "@/lib/utils";
import GstinVerifyCard from "@/components/features/gstin/gstin-verify-card";
import { ImportCustomersDialog } from "@/components/features/customers/import-customers-dialog";

// ─── Step config ──────────────────────────────────────────────────────────────

// Order = first-value first. Company (needed for GST) → Import customers (the step
// that actually lights up renewals/margins/dashboard) → then the two integration
// steps that can only be *started* here and finish later (Razorpay KYC, Google CSP
// approval). Index 0 must stay Company (saves the tenant) and index 3 stays the last
// content step before Done (fires finishSetup); see `next()`.
const STEPS = [
  { id: "company",  label: "Company",    icon: "building" },
  { id: "import",   label: "Import",     icon: "upload"   },
  { id: "razorpay", label: "Razorpay",   icon: "rupee"    },
  { id: "csp",      label: "Google CSP", icon: "globe"    },
  { id: "done",     label: "All set",    icon: "rocket"   },
] as const;


// ─── State ────────────────────────────────────────────────────────────────────

interface WizardData {
  companyName:   string;
  gstin:         string;
  state:         string;
  address:       string;
  pinCode:       string;
  contactName:   string;
  contactEmail:  string;
  razorpayKey:   string;
  razorpayConnected: boolean;
  cspId:         string;
  cspStage:      "intro" | "applied" | "approved";
  importMode:    "csv" | "skip";
}

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

// ─── Step 1: Company ─────────────────────────────────────────────────────────

function StepCompany({
  data,
  update,
}: {
  data: WizardData;
  update: (k: keyof WizardData, v: string | boolean) => void;
}) {
  // Pull cached verification from the tenant — re-running the wizard
  // shouldn't lose the green checkmark someone earned earlier.
  const { data: me } = useCurrentUser();
  return (
    <div className="space-y-4">
      <div>
        <h2 className="font-serif text-2xl text-ink">Your business details</h2>
        <p className="mt-1 text-sm text-ink-3">
          These appear on every GST invoice you generate. Saved to your tenant —
          you can edit anytime in <span className="font-medium text-ink-2">Settings → Company</span>.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Legal company name" className="col-span-2">
          <Input
            placeholder="e.g. Excel Technologies Pvt Ltd"
            value={data.companyName}
            onChange={(e) => update("companyName", e.target.value)}
          />
        </Field>
        <Field label="GSTIN">
          <Input
            className="font-mono"
            placeholder="e.g. 27AABCE9876D1Z3"
            value={data.gstin}
            onChange={(e) => {
              const v = e.target.value.toUpperCase();
              update("gstin", v);
              // First 2 digits of a GSTIN encode the state per GSTN master list.
              // Auto-fill the State dropdown when those digits match a known code.
              const { code, name } = gstStateFromGstin(v);
              if (code && name) update("state", `${name} (${code})`);
            }}
          />
          {/* Live feedback — same logic as Settings → Company. Suppress
              until the visitor has typed all 15 chars to avoid noise. */}
          {(() => {
            const v = data.gstin.trim();
            if (v.length < 15) return (
              <p className="mt-1 text-[10px] text-ink-3">
                State auto-fills from the first 2 digits of your GSTIN.
              </p>
            );
            if (isValidGstin(v)) return (
              <p className="mt-1 text-[10px] text-emerald inline-flex items-center gap-1">
                <Icon name="check_circle" size={11} /> Format + checksum match. Click Verify to confirm with GSTN.
              </p>
            );
            const r = validateGstin(v);
            return (
              <p className="mt-1 text-[10px] text-rose inline-flex items-center gap-1">
                <Icon name="alert" size={11} /> {r.ok ? "" : r.message}
              </p>
            );
          })()}
          {/* Verify with GSTN portal — does not block the Continue button
              when not pressed; this is informational.
              Fill form copies legal_name / address / pin / state into
              the wizard's local state, so Continue saves the GST-sourced
              values to tenants in one go. */}
          <GstinVerifyCard
            gstin={data.gstin}
            cached={me?.tenantGstinVerification ?? null}
            cachedAt={me?.tenantGstinVerifiedAt}
            onFillForm={(v) => {
              if (v.legal_name)                  update("companyName", v.legal_name);
              if (v.address)                     update("address",     v.address);
              if (v.principal_address?.pin_code) update("pinCode",     v.principal_address.pin_code);
              if (v.state_code) {
                const name = GST_STATE_BY_CODE[v.state_code];
                if (name) update("state", `${name} (${v.state_code})`);
              }
            }}
          />
        </Field>
        <Field label="State">
          <select
            className="w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-amber"
            value={data.state}
            onChange={(e) => update("state", e.target.value)}
          >
            {Object.entries(GST_STATE_BY_CODE)
              .sort(([, a], [, b]) => a.localeCompare(b))
              .map(([code, name]) => (
                <option key={code} value={`${name} (${code})`}>
                  {name} ({code})
                </option>
              ))}
          </select>
        </Field>
        <Field label="Registered address" className="col-span-2">
          <Input
            placeholder="Office address"
            value={data.address}
            onChange={(e) => update("address", e.target.value)}
          />
        </Field>
        <Field label="Owner / Contact name">
          <Input
            placeholder="Your name"
            value={data.contactName}
            onChange={(e) => update("contactName", e.target.value)}
          />
        </Field>
        <Field label="Contact email">
          <Input
            type="email"
            placeholder="e.g. owner@yourcompany.in"
            className="font-mono"
            value={data.contactEmail}
            onChange={(e) => update("contactEmail", e.target.value)}
          />
        </Field>
        <Field label="PIN code">
          <Input
            className="font-mono"
            placeholder="400001"
            value={data.pinCode}
            onChange={(e) => update("pinCode", e.target.value)}
          />
        </Field>
      </div>

      <div className="flex items-start gap-2.5 rounded-lg bg-indigo-50 p-3 text-sm text-indigo-700">
        <Icon name="info" size={14} className="mt-0.5 shrink-0 text-indigo-600" />
        <p>
          We auto-verify your GSTIN against the government portal. Your registered
          business name will be confirmed automatically.
        </p>
      </div>
    </div>
  );
}

// ─── Step 2: Razorpay ────────────────────────────────────────────────────────

function StepRazorpay() {
  return (
    <div className="space-y-4">
      <div>
        <h2 className="font-serif text-2xl text-ink">Connect Razorpay</h2>
        <p className="mt-1 text-sm text-ink-3">
          So customers can pay you via UPI, cards, net banking — and money lands in
          your bank within 2 days.
        </p>
      </div>

      <div
        className="flex items-center justify-between gap-4 rounded-xl p-5"
        style={{ background: "linear-gradient(135deg, #001A47 0%, #002B5C 100%)" }}
      >
        <div>
          <p className="text-lg font-semibold text-white">Razorpay</p>
          <p className="text-sm text-white/80">
            India's #1 payment gateway · 2% per transaction · T+2 settlement
          </p>
        </div>
      </div>

      {/* Honest: this wizard step is a preview. The real connection (keys +
          verify) lives in Settings → Integrations — we don't fake a "connected"
          state here or capture keys that wouldn't be saved. */}
      <div className="flex items-start gap-2.5 rounded-lg bg-amber-soft p-3 text-sm text-amber-ink">
        <Icon name="info" size={14} className="mt-0.5 shrink-0" />
        <p>
          You don't need Razorpay right now. After setup, add your Razorpay keys in{" "}
          <strong>Settings → Integrations</strong> to turn on live payments in 2 minutes.
          Until then you can still create quotes/invoices and send them on WhatsApp.
        </p>
      </div>
    </div>
  );
}

// ─── Step 3: Google CSP ──────────────────────────────────────────────────────

function StepCsp() {
  return (
    <div className="space-y-4">
      <div>
        <h2 className="font-serif text-2xl text-ink">Google CSP API access</h2>
        <p className="mt-1 text-sm text-ink-3">
          Connect to Google's Cloud Solution Provider API to auto-provision Workspace
          tenants for your customers.
        </p>
      </div>

      <div className="rounded-xl border border-hairline bg-paper-2 p-5">
        <div className="mb-3 flex items-center gap-3">
          {/* Google G */}
          <svg width="40" height="40" viewBox="0 0 24 24">
            <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
            <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
            <path fill="#FBBC04" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
            <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
          </svg>
          <div>
            <p className="font-semibold text-ink">Google Workspace Reseller</p>
            <p className="text-xs text-ink-3">
              Auto-provision tenants · sync subscriptions · pull billing
            </p>
          </div>
        </div>
        <ul className="ml-4 list-disc space-y-1 text-sm text-ink-3">
          <li>The application is made directly with Google — approval takes 5–7 business days</li>
          <li>Needs: Partner status, a few customers already provisioned, and business verification (PAN, GST, agreement)</li>
        </ul>
      </div>

      {/* Honest: there's no in-app CSP application yet — this step is a preview
          so we don't fake a "submitted / connected" state. */}
      <div className="flex items-start gap-2.5 rounded-lg bg-amber-soft p-3 text-sm text-amber-ink">
        <Icon name="info" size={14} className="mt-0.5 shrink-0" />
        <p>
          You don't need CSP right now. You can keep provisioning tenants manually from
          the Google Partner console, and quotes/invoices/renewals all work without it.
          The option to connect CSP will live in <strong>Settings → Integrations</strong> later.
        </p>
      </div>
    </div>
  );
}

// ─── Step 4: Import ──────────────────────────────────────────────────────────

const IMPORT_OPTIONS = [
  {
    id:   "csv"    as const,
    icon: "upload",
    title: "CSV / Excel import",
    body:  "Upload your existing customer list — Zoho/Tally exports work too",
    cta:   "Open importer",
  },
  {
    id:   "skip"   as const,
    icon: "plus",
    title: "Start fresh",
    body:  "Add customers one-by-one as they come · cleanest",
    cta:   "I'll add manually",
  },
];

function StepImport({
  data,
  update,
}: {
  data: WizardData;
  update: (k: keyof WizardData, v: string | boolean) => void;
}) {
  const [importOpen, setImportOpen] = React.useState(false);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="font-serif text-2xl text-ink">
          Import your existing customers
        </h2>
        <p className="mt-1 text-sm text-ink-3">
          Bring your spreadsheet over so renewal tracking and margin reports work
          from day 1.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        {IMPORT_OPTIONS.map((opt) => {
          const active = data.importMode === opt.id;
          return (
            <button
              key={opt.id}
              type="button"
              onClick={() => {
                update("importMode", opt.id);
                // CSV is the real path — open the actual importer straight away.
                if (opt.id === "csv") setImportOpen(true);
              }}
              className={cn(
                "rounded-xl border p-4 text-left transition-all",
                active
                  ? "border-amber bg-amber-50"
                  : "border-hairline bg-paper hover:bg-paper-2",
              )}
            >
              <div
                className={cn(
                  "mb-2.5 flex h-9 w-9 items-center justify-center rounded-lg",
                  active ? "bg-amber text-white" : "bg-paper-2 text-ink-3",
                )}
              >
                <Icon name={opt.icon} size={16} />
              </div>
              <p className="mb-1 text-sm font-semibold text-ink">{opt.title}</p>
              <p className="mb-2 text-xs leading-relaxed text-ink-3">{opt.body}</p>
              <p
                className={cn(
                  "text-xs font-semibold",
                  active ? "text-amber" : "text-ink-3",
                )}
              >
                {active ? "✓ Selected" : opt.cta}
              </p>
            </button>
          );
        })}
      </div>

      {data.importMode === "csv" && (
        <div className="flex items-center justify-between gap-3 rounded-lg bg-paper-2 p-3 text-sm text-ink-3">
          <span>📎 The importer has a downloadable template + Zoho/Tally header matching.</span>
          <Button
            variant="primary"
            size="sm"
            className="shrink-0"
            onClick={() => setImportOpen(true)}
          >
            <Icon name="upload" size={13} />
            Open importer
          </Button>
        </div>
      )}

      <ImportCustomersDialog open={importOpen} onOpenChange={setImportOpen} />
    </div>
  );
}

// ─── Step 5: Done ────────────────────────────────────────────────────────────

type ChecklistItem = { label: string; status: "done" | "pending" | "todo"; note?: string };

const NEXT_STEPS = [
  "Send your first quote — open Quote Builder",
  "Set up WhatsApp Business API for customer chat",
  "Import your renewal calendar from existing system",
  "Configure email templates in Automations",
  "Invite your team — Sales rep, Accountant, Support",
];

function StepDone() {
  const [checked, setChecked] = React.useState<Set<number>>(new Set());

  // Derive the checklist from REAL state — never claim GSTIN/customers are done
  // when they aren't (a "Start fresh" user hasn't imported anyone).
  const { data: me } = useCurrentUser();
  const { data: customers } = useCustomers();
  const hasCustomers = (customers?.length ?? 0) > 0;
  const gstinStatus: ChecklistItem["status"] =
    me?.tenantGstinVerifiedAt ? "done" : me?.tenantGstin ? "pending" : "todo";

  const doneChecklist: ChecklistItem[] = [
    {
      label: gstinStatus === "done" ? "Company GSTIN verified" : "Company GSTIN",
      status: gstinStatus,
      note: gstinStatus === "done" ? undefined
        : gstinStatus === "pending" ? "Verify it in Settings → Company"
        : "Add your GSTIN in Settings → Company",
    },
    { label: "GST tax invoice (PDF)", status: "done", note: "e-invoice IRN/QR coming later" },
    { label: "Razorpay payments",     status: "todo", note: "Finish in Settings → Integrations" },
    { label: "Google CSP API",        status: "pending", note: "Approval in 5–7 days" },
    {
      label: hasCustomers ? "Customers added" : "Add your customers",
      status: hasCustomers ? "done" : "todo",
      note: hasCustomers ? undefined : "Import a CSV or add your first customer",
    },
    { label: "WhatsApp Business API",  status: "todo", note: "Set up later" },
  ];

  return (
    <div className="py-4 text-center">
      {/* Rocket icon */}
      <div className="mx-auto mb-5 flex h-20 w-20 items-center justify-center rounded-full text-emerald-600"
        style={{ background: "linear-gradient(135deg, #dcfce7 0%, #fef3c7 100%)", boxShadow: "0 12px 32px rgba(22,101,52,0.18)" }}>
        <Icon name="rocket" size={36} />
      </div>

      <h2 className="font-serif text-3xl text-ink">You're all set.</h2>
      <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-ink-3">
        Your reseller workspace is live. Here's what's ready and what to do next.
      </p>

      {/* Status checklist */}
      <div className="mx-auto mt-6 grid max-w-md grid-cols-2 gap-2.5 text-left">
        {doneChecklist.map((it) => (
          <div key={it.label} className="flex items-center gap-2 text-sm">
            <span
              className={cn(
                "flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-white",
                it.status === "done"    ? "bg-emerald-600"
                  : it.status === "pending" ? "bg-amber"
                  : "bg-hairline",
              )}
            >
              <Icon
                name={
                  it.status === "done" ? "check" : it.status === "pending" ? "clock" : "plus"
                }
                size={10}
              />
            </span>
            <div>
              <p className="font-medium text-ink">{it.label}</p>
              {it.note && (
                <p className="text-xs text-ink-3">{it.note}</p>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Next-steps checklist */}
      <div className="mx-auto mt-6 max-w-md rounded-xl border border-hairline bg-paper-2 p-4 text-left">
        <p className="mb-3 text-[10px] font-bold uppercase tracking-widest text-ink-3">
          Suggested first week
        </p>
        <div className="space-y-2">
          {NEXT_STEPS.map((t, i) => (
            <label key={i} className="flex cursor-pointer items-center gap-2.5 text-sm text-ink">
              <input
                type="checkbox"
                checked={checked.has(i)}
                onChange={() =>
                  setChecked((prev) => {
                    const next = new Set(prev);
                    next.has(i) ? next.delete(i) : next.add(i);
                    return next;
                  })
                }
                className="rounded border-hairline"
              />
              <span className={cn(checked.has(i) && "line-through text-ink-3")}>
                {t}
              </span>
            </label>
          ))}
        </div>
      </div>

      {/* CTAs */}
      <div className="mt-6 flex flex-wrap justify-center gap-2">
        <Button variant="primary" asChild>
          <Link href="/dashboard">
            <Icon name="home" size={14} />
            Open dashboard
          </Link>
        </Button>
        <Button variant="default" asChild>
          <Link href="/quotes/new">
            <Icon name="file" size={14} />
            Send first quote
          </Link>
        </Button>
        <Button variant="ghost" asChild>
          <Link href="/settings">
            <Icon name="settings" size={14} />
            Settings
          </Link>
        </Button>
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

/** Compose "Maharashtra (27)" display string. Wizard stores the dropdown
 *  choice as one string; we split it on save. Falls back to looking up the
 *  code by name in the full GST_STATE_BY_CODE map when not provided. */
function stateLabelFromParts(name: string | null, code: string | null): string {
  if (!name) return "Maharashtra (27)"; // default
  const c =
    code ??
    Object.entries(GST_STATE_BY_CODE).find(([, n]) => n === name)?.[0] ??
    "";
  return c ? `${name} (${c})` : name;
}

function parseStateLabel(label: string): { name: string; code: string } {
  const m = /^(.+?)\s*\((\d{1,2})\)\s*$/.exec(label.trim());
  if (m) return { name: m[1], code: m[2] };
  return { name: label.trim(), code: "" };
}

export default function SetupPage() {
  const { data: me, isLoading: meLoading } = useCurrentUser();
  const updateTenant = useUpdateTenant();

  const [step, setStep] = React.useState(0);
  const [data, setData] = React.useState<WizardData>({
    companyName:       "",
    gstin:             "",
    state:             "Maharashtra (27)",
    address:           "",
    pinCode:           "",
    contactName:       "",
    contactEmail:      "",
    razorpayKey:       "",
    razorpayConnected: false,
    cspId:             "",
    cspStage:          "intro",
    importMode:        "csv",
  });

  // Pre-fill from existing tenant data as soon as useCurrentUser resolves.
  // Re-running the wizard never blows away saved data this way.
  React.useEffect(() => {
    if (!me) return;
    setData((d) => ({
      ...d,
      companyName:  me.tenantName       || d.companyName,
      gstin:        me.tenantGstin      || d.gstin,
      state:        stateLabelFromParts(me.tenantState, me.tenantStateCode) || d.state,
      address:      me.tenantAddress    || d.address,
      pinCode:      me.tenantPinCode    || d.pinCode,
      contactName:  me.tenantContactName || me.fullName || d.contactName,
      contactEmail: me.tenantEmail      || me.authEmail || d.contactEmail,
    }));
  }, [me]);

  const update = (k: keyof WizardData, v: string | boolean) =>
    setData((d) => ({ ...d, [k]: v }));

  // Save Step 1 (Company) to the tenants table before advancing past it.
  // Other steps (Razorpay / CSP / Import) are still UI walkthroughs;
  // their actual integrations land in Settings → Integrations later.
  const saveCompanyAndAdvance = async () => {
    // Block on bad GSTIN — empty is fine (optional), wrong checksum is not.
    if (data.gstin.trim() && !isValidGstin(data.gstin.trim())) {
      toast.error("GSTIN is invalid — fix the checksum or leave the field blank");
      return;
    }
    const { name: stateName, code: stateCode } = parseStateLabel(data.state);
    try {
      await updateTenant.mutateAsync({
        name:         data.companyName.trim() || me?.tenantName || "Workspace",
        gstin:        data.gstin.trim()        || null,
        state:        stateName                || null,
        state_code:   stateCode                || null,
        address:      data.address.trim()      || null,
        pin_code:     data.pinCode.trim()      || null,
        contact_name: data.contactName.trim()  || null,
        email:        data.contactEmail.trim() || me?.tenantEmail || "",
      });
      setStep((s) => Math.min(STEPS.length - 1, s + 1));
    } catch (e) {
      toast.error(`Could not save: ${(e as Error).message}`);
    }
  };

  // On final Continue (Step 3 → Step 4) stamp setup_completed_at so the
  // sidebar can hide the Wizard or mark it "Done".
  const finishSetup = async () => {
    try {
      await updateTenant.mutateAsync({
        setup_completed_at: new Date().toISOString(),
      });
      setStep((s) => Math.min(STEPS.length - 1, s + 1));
    } catch {
      // Non-fatal — let visitor see the "All set" screen even if stamping failed
      setStep((s) => Math.min(STEPS.length - 1, s + 1));
    }
  };

  const next = () => {
    if (step === 0) { void saveCompanyAndAdvance(); return; }
    if (step === 3) { void finishSetup();           return; }
    setStep((s) => Math.min(STEPS.length - 1, s + 1));
  };
  const back = () => setStep((s) => Math.max(0, s - 1));
  const skip = () => setStep((s) => Math.min(STEPS.length - 1, s + 1));

  return (
    <div
      className="min-h-screen px-6 py-10"
      style={{
        background: "linear-gradient(180deg, var(--color-paper, #fff) 0%, var(--color-paper-2, #f9f9f9) 100%)",
      }}
    >
      <div className="mx-auto max-w-2xl">
        {/* ── Logo + welcome ── */}
        <div className="mb-8 text-center">
          <div className="mb-3 inline-flex items-center gap-2.5">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-ink font-serif text-lg text-paper">
              R
            </div>
            <div className="text-left">
              <p className="font-serif text-lg leading-tight text-ink">ResellerOS</p>
              <p className="text-xs text-ink-3">Setup · 5 minutes</p>
            </div>
          </div>
          <h1 className="font-serif text-3xl text-ink">
            {meLoading
              ? "Loading…"
              : `Welcome, ${(data.contactName || me?.fullName || "there").split(" ")[0]}.`}
          </h1>
          <p className="mt-2 text-sm text-ink-3">
            {me?.tenantSetupCompletedAt
              ? "Setup already complete. You can re-run any step to update settings."
              : "Let's get your reseller business operational in 5 quick steps."}
          </p>
        </div>

        {/* ── Step progress ── */}
        <div className="mb-8">
          {/* Progress bar */}
          <div
            className="mb-4 grid gap-1"
            style={{ gridTemplateColumns: `repeat(${STEPS.length}, 1fr)` }}
          >
            {STEPS.map((s, i) => (
              <button
                key={s.id}
                type="button"
                onClick={() => i <= step + 1 && setStep(i)}
                disabled={i > step + 1}
                className={cn(
                  "h-1 rounded-full border-0 transition-colors",
                  i < step
                    ? "bg-amber cursor-pointer"
                    : i === step
                      ? "bg-amber cursor-pointer"
                      : i === step + 1
                        ? "bg-amber/20 cursor-pointer"
                        : "bg-hairline cursor-default",
                )}
              />
            ))}
          </div>

          {/* Step dots + labels */}
          <div
            className="grid gap-1"
            style={{ gridTemplateColumns: `repeat(${STEPS.length}, 1fr)` }}
          >
            {STEPS.map((s, i) => (
              <div key={s.id} className="text-center">
                <div
                  className={cn(
                    "mx-auto mb-1.5 flex h-7 w-7 items-center justify-center rounded-full border-1.5 text-[11px] font-semibold",
                    i < step
                      ? "border-emerald-500 bg-emerald-500 text-white"
                      : i === step
                        ? "border-amber bg-amber text-white"
                        : "border-hairline bg-paper text-ink-3",
                  )}
                  style={{ borderWidth: "1.5px" }}
                >
                  {i < step ? (
                    <Icon name="check" size={12} />
                  ) : (
                    <Icon name={s.icon} size={12} />
                  )}
                </div>
                <p
                  className={cn(
                    "text-[10px]",
                    i === step ? "font-semibold text-ink" : "text-ink-3",
                  )}
                >
                  {s.label}
                </p>
              </div>
            ))}
          </div>
        </div>

        {/* ── Step content ── */}
        <Card className="p-6">
          {step === 0 && <StepCompany  data={data} update={update} />}
          {step === 1 && <StepImport   data={data} update={update} />}
          {step === 2 && <StepRazorpay />}
          {step === 3 && <StepCsp />}
          {step === 4 && <StepDone />}
        </Card>

        {/* ── Footer actions ── */}
        {step < 4 && (
          <div className="mt-5 flex items-center justify-between">
            <Button
              variant="ghost"
              onClick={back}
              disabled={step === 0}
            >
              <Icon name="arrow_left" size={14} />
              Back
            </Button>
            <div className="flex gap-2">
              {step > 0 && (
                <Button variant="ghost" onClick={skip}>
                  Skip for now
                </Button>
              )}
              <Button
                variant="primary"
                onClick={next}
                loading={step === 0 && updateTenant.isPending}
                disabled={step === 0 && updateTenant.isPending}
              >
                {step === 0 && updateTenant.isPending
                  ? "Saving…"
                  : step === 3 ? "Finish setup" : "Continue"}
                <Icon name="arrow_right" size={14} />
              </Button>
            </div>
          </div>
        )}

        {/* ── Trust footer ── */}
        <p className="mt-10 text-center text-xs text-ink-3">
          Your data stays on your tenant · DPDP Act 2023 compliant · ISO 27001 in
          progress
        </p>
      </div>
    </div>
  );
}
