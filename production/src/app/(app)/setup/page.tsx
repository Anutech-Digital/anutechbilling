/**
 * Setup Wizard — matches prototype screen "setup-wizard".
 *
 * 5-step first-run wizard (order = first-value-first):
 *   1. Company details (legal name, GSTIN, state, address, optional UPI/bank)  → SAVES to tenants
 *   2. Import customers (CSV / fresh) — opens the real ImportCustomersDialog
 *   3. Razorpay — optional; real status, connect lives in Settings → Integrations
 *   4. Google Reseller API — optional; real status, set up in Settings → Integrations
 *   5. All set — statuses from real data + next steps
 *
 * R-260: EVERY way of reaching step 5 (Finish, Skip, progress bar) stamps
 * setup_completed_at — see wizard-nav.ts.
 *
 * Step 1 pre-fills from `useCurrentUser` so re-running the wizard never wipes
 * what was already saved in Settings → Company. The actual persistence is
 * via `useUpdateTenant` (same hook Settings uses) — single source of truth.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { toastError } from "@/lib/errors/toast-error";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { useUpdateTenant } from "@/lib/queries/tenant";
import { gstStateFromGstin, isValidGstin, validateGstin } from "@/lib/utils";
import { GST_STATE_OPTIONS, initialStateCode, normalizeStateCode, resolveCompanyState } from "./company-state";
import { InvoiceCodeField, useInvoiceCode, useSaveInvoiceCode, type InvoiceCodeState } from "./invoice-code-field";
import { invoiceCodeProblem, normalizeInvoiceCode, suggestInvoiceCode } from "./invoice-code";
import GstinVerifyCard from "@/components/features/gstin/gstin-verify-card";
import { ImportCustomersDialog } from "@/components/features/customers/import-customers-dialog";
import { useItems, useLoadDefaultCatalog } from "@/lib/queries/items";
import { productCount } from "@/lib/items/catalog-state";
import type { ChecklistItem } from "./done-checklist";
import { StepDone } from "./done-screen";
import { useGoogleResellerStatus, useRazorpayStatus } from "./integration-status";
import { paymentDetailsPatch, paymentDetailsProblem } from "./payment-details";
import { DONE_STEP, wizardMove } from "./wizard-nav";

// ─── Step config ──────────────────────────────────────────────────────────────

// Order = first-value first. Company (needed for GST) → Import customers (the step
// that actually lights up renewals/margins/dashboard) → then the two integration
// steps that can only be *started* here and finish later (Razorpay KYC, Google CSP
// approval). Index 0 must stay Company (saves the tenant) and index 3 stays the last
// content step before Done (DONE_STEP = 4 fires finishSetup); see wizard-nav.ts.
const STEPS = [
  { id: "company",  label: "Company",    icon: "building" },
  { id: "import",   label: "Import",     icon: "upload"   },
  { id: "razorpay", label: "Razorpay",   icon: "rupee"    },
  { id: "csp",      label: "Google",     icon: "globe"    },
  { id: "done",     label: "All set",    icon: "rocket"   },
] as const;


// ─── State ────────────────────────────────────────────────────────────────────

interface WizardData {
  companyName:   string;
  gstin:         string;
  /** R-250: 2-digit GST state code, "" = not chosen yet (no default). */
  state:         string;
  address:       string;
  pinCode:       string;
  /** R-259: invoice code (tenants.doc_code), "" = keep what prints today. */
  invoiceCode:   string;
  contactName:   string;
  contactEmail:  string;
  /** R-260: optional payment details (tenants.upi_vpa / remit_*), same columns as Settings. */
  upiVpa:        string;
  bankName:      string;
  accountName:   string;
  accountNumber: string;
  ifsc:          string;
  importMode:    "csv" | "skip";
}

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

// ─── Step 1: Company ─────────────────────────────────────────────────────────

function StepCompany({
  data,
  update,
  codeState,
  codeError,
  payError,
}: {
  data: WizardData;
  update: (k: keyof WizardData, v: string | boolean) => void;
  codeState: InvoiceCodeState | undefined;
  codeError: string | null;
  payError: string | null;
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

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field htmlFor="setup-legal-company-name" label="Legal company name" className="sm:col-span-2">
          <Input id="setup-legal-company-name"
            placeholder="e.g. Sharma Cloud Solutions Pvt Ltd"
            value={data.companyName}
            onChange={(e) => update("companyName", e.target.value)}
          />
        </Field>
        <Field htmlFor="setup-gstin" label="GSTIN">
          <Input id="setup-gstin"
            className="font-mono"
            placeholder="e.g. 27AABCE9876D1Z3"
            value={data.gstin}
            onChange={(e) => {
              const v = e.target.value.toUpperCase();
              update("gstin", v);
              // First 2 digits of a GSTIN encode the state per GSTN master list.
              // Auto-fill the State dropdown when those digits match a known code.
              const { code, name } = gstStateFromGstin(v);
              if (code && name) update("state", code);
            }}
          />
          {/* Live feedback — same logic as Settings → Company. Suppress
              until the visitor has typed all 15 chars to avoid noise. */}
          {(() => {
            const v = data.gstin.trim();
            if (v.length < 15) return (
              <p className="mt-1 text-3xs text-ink-3">
                State auto-fills from the first 2 digits of your GSTIN.
              </p>
            );
            if (isValidGstin(v)) return (
              <p className="mt-1 text-3xs text-emerald inline-flex items-center gap-1">
                <Icon name="check_circle" size={11} /> Format + checksum match. Click Verify to confirm with GSTN.
              </p>
            );
            const r = validateGstin(v);
            return (
              <p className="mt-1 text-3xs text-rose inline-flex items-center gap-1">
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
              const code = normalizeStateCode(v.state_code);
              if (code) update("state", code);
            }}
          />
        </Field>
        <Field htmlFor="setup-state" label="State">
          {/* R-250: no default — a wrong state means the wrong IGST/CGST on every invoice. */}
          <select id="setup-state"
            className="w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-amber"
            value={data.state}
            aria-invalid={!resolveCompanyState(data.state, data.gstin)}
            aria-describedby={resolveCompanyState(data.state, data.gstin) ? undefined : "setup-state-hint"}
            onChange={(e) => update("state", e.target.value)}
          >
            <option value="" disabled>Choose your state</option>
            {GST_STATE_OPTIONS.map(({ code, name }) => (
              <option key={code} value={code}>
                {name} ({code})
              </option>
            ))}
          </select>
          {!resolveCompanyState(data.state, data.gstin) && (
            <p id="setup-state-hint" className="mt-1 text-3xs text-ink-3">
              Needed for the right GST on your invoices.
            </p>
          )}
        </Field>
        <Field htmlFor="setup-registered-address" label="Registered address" className="sm:col-span-2">
          <Input id="setup-registered-address"
            placeholder="Office address"
            value={data.address}
            onChange={(e) => update("address", e.target.value)}
          />
        </Field>
        <Field htmlFor="setup-invoice-code" label="Invoice code (2–4 letters)" className="sm:col-span-2">
          <InvoiceCodeField
            id="setup-invoice-code"
            value={data.invoiceCode}
            onChange={(v) => update("invoiceCode", v)}
            state={codeState}
            serverError={codeError}
          />
        </Field>
        <Field htmlFor="setup-owner-contact-name" label="Owner / Contact name">
          <Input id="setup-owner-contact-name"
            placeholder="Your name"
            value={data.contactName}
            onChange={(e) => update("contactName", e.target.value)}
          />
        </Field>
        <Field htmlFor="setup-contact-email" label="Contact email">
          <Input id="setup-contact-email"
            type="email"
            placeholder="e.g. owner@yourcompany.in"
            className="font-mono"
            value={data.contactEmail}
            onChange={(e) => update("contactEmail", e.target.value)}
          />
        </Field>
        <Field htmlFor="setup-pin-code" label="PIN code">
          <Input id="setup-pin-code"
            className="font-mono"
            placeholder="400001"
            value={data.pinCode}
            onChange={(e) => update("pinCode", e.target.value)}
          />
        </Field>
      </div>

      {/* R-260: the old GSTIN note claimed verification happened by itself; it was false — verifying is the
          Verify button above. Replaced by the optional payment details. */}
      <details className="rounded-lg border border-hairline p-3" open={payError ? true : undefined}>
        <summary className="cursor-pointer text-sm font-medium text-ink">
          How customers pay you{" "}
          <span className="font-normal text-ink-3">
            {data.upiVpa.trim() || data.accountNumber.trim() ? "(added)" : "(optional)"}
          </span>
        </summary>
        <p className="mt-1 text-xs text-ink-3">Printed on every invoice. UPI also prints as a scan-to-pay QR.</p>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field htmlFor="setup-upi" label="UPI ID" className="sm:col-span-2">
            <Input id="setup-upi"
              className="font-mono"
              placeholder="e.g. yourname@okhdfcbank"
              value={data.upiVpa}
              onChange={(e) => update("upiVpa", e.target.value)}
            />
          </Field>
          <Field htmlFor="setup-bank-name" label="Bank name">
            <Input id="setup-bank-name"
              placeholder="e.g. HDFC Bank"
              value={data.bankName}
              onChange={(e) => update("bankName", e.target.value)}
            />
          </Field>
          <Field htmlFor="setup-account-name" label="Account holder name">
            <Input id="setup-account-name"
              placeholder="As on the bank account"
              value={data.accountName}
              onChange={(e) => update("accountName", e.target.value)}
            />
          </Field>
          <Field htmlFor="setup-account-number" label="Account number">
            <Input id="setup-account-number"
              className="font-mono"
              inputMode="numeric"
              value={data.accountNumber}
              onChange={(e) => update("accountNumber", e.target.value)}
            />
          </Field>
          <Field htmlFor="setup-ifsc" label="IFSC">
            <Input id="setup-ifsc"
              className="font-mono"
              placeholder="e.g. HDFC0001234"
              value={data.ifsc}
              onChange={(e) => update("ifsc", e.target.value.toUpperCase())}
            />
          </Field>
        </div>
        {payError && (
          <p role="alert" className="mt-2 inline-flex items-center gap-1 text-xs text-rose">
            <Icon name="alert" size={11} /> {payError}
          </p>
        )}
      </details>
    </div>
  );
}

// ─── Step 2: Razorpay ────────────────────────────────────────────────────────

type LineStatus = Exclude<ChecklistItem["status"], "unknown">;

function IntegrationStatusLine({ status, text }: { status: LineStatus; text: string }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-hairline p-3 text-sm">
      <span className="inline-flex items-center gap-2 text-ink">
        <Icon
          name={status === "done" ? "check_circle" : status === "pending" ? "alert" : status === "checking" ? "clock" : "info"}
          size={14}
          className={status === "done" ? "text-emerald" : status === "pending" ? "text-amber" : "text-ink-3"}
        />
        {text}
      </span>
      <Link href="/settings?tab=integrations" className="text-xs font-medium text-ink-2 underline underline-offset-2 hover:text-amber-ink">
        {status === "done" ? "Manage" : "Set up in Settings"}
      </Link>
    </div>
  );
}

function StepRazorpay() {
  // R-260: real status from the same GET as Settings → Integrations.
  const { data: rz, isLoading } = useRazorpayStatus();
  const state = rz?.readiness?.state ?? (rz?.configured ? "ready" : "not_configured");
  return (
    <div className="space-y-4">
      <div>
        <h2 className="font-serif text-2xl text-ink">Connect Razorpay</h2>
        <p className="mt-1 text-sm text-ink-3">
          Optional. Lets customers pay online by UPI, card or net banking, and marks
          the invoice paid by itself.
        </p>
      </div>

      <div
        className="flex items-center justify-between gap-4 rounded-xl p-5"
        style={{ background: "linear-gradient(135deg, #001A47 0%, #002B5C 100%)" }}
      >
        <div>
          <p className="text-lg font-semibold text-white">Razorpay</p>
          <p className="text-sm text-white/80">
            Payment gateway · Razorpay charges a fee per payment
          </p>
        </div>
      </div>

      <IntegrationStatusLine
        status={isLoading ? "checking" : state === "ready" ? "done" : state === "collect_only" ? "pending" : "todo"}
        text={isLoading ? "Checking…"
          : rz === null ? "Could not read the status"
          : state === "ready" ? "Connected"
          : state === "collect_only" ? "Keys saved. Add the webhook secret"
          : "Not connected"}
      />
      <p className="text-sm text-ink-3">
        You can skip this. Quotes and invoices work without Razorpay, and customers
        can still pay by UPI or bank transfer.
      </p>
    </div>
  );
}

// ─── Step 3: Google CSP ──────────────────────────────────────────────────────

function StepCsp() {
  // R-260: real status from the same probe as Settings → Integrations.
  const { data: g, isLoading } = useGoogleResellerStatus();
  return (
    <div className="space-y-4">
      <div>
        <h2 className="font-serif text-2xl text-ink">Google Reseller API</h2>
        <p className="mt-1 text-sm text-ink-3">
          Optional. For Google Workspace resellers: syncs your customers&apos;
          subscriptions and seats from Google.
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
              Sync subscriptions and seats
            </p>
          </div>
        </div>
        <ul className="ml-4 list-disc space-y-1 text-sm text-ink-3">
          <li>Needs a Google Workspace reseller account</li>
          <li>Turn on the Reseller API in Google Cloud, then connect your reseller-admin Google account in Settings → Integrations</li>
        </ul>
      </div>

      <IntegrationStatusLine
        status={isLoading ? "checking" : g?.connected ? "done" : "todo"}
        text={isLoading ? "Checking…"
          : g?.connected ? "Connected"
          : g?.code === "api_disabled" ? "The Reseller API is turned off in Google Cloud"
          : g?.code === "needs_reauth" ? "Google needs you to sign in again"
          : g?.code === "not_connected" || g?.code === "missing_scope" ? "Connect Google Reseller in Settings → Integrations"
          : "Not connected"}
      />
      <p className="text-sm text-ink-3">
        You can skip this. Quotes, invoices and renewals all work without it.
      </p>
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
  /* Catalogue isi kadam me — 1 Sep 2026 ke audit ka B2: naya tenant wizard
     poora karke bhi KHALI quote-builder par pahunchta tha, kyunki default-
     catalog ka button sirf /items ke empty-state me chhupa tha. Quote banane
     ke liye customer AUR daam dono chahiye; ye "data laao" wala step hai,
     to dono yahin. */
  const { data: catalogItems } = useItems();
  const loadCatalog = useLoadDefaultCatalog();
  const catalogCount = productCount(catalogItems); // support tiers are not a catalog

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

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-paper-2 p-3 text-sm text-ink-3">
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

      {/* ── Price list — quote iske bina ban hi nahi sakta ─────────────── */}
      <div className="rounded-xl border border-hairline bg-paper p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-ink">Your price list</p>
            <p className="mt-0.5 text-xs text-ink-3">
              {catalogCount > 0
                ? `${catalogCount} item${catalogCount === 1 ? "" : "s"} in your catalog — quotes are ready to build.`
                : "Quotes need a catalog. Load the standard one (Google Workspace, M365, Zoho — 7 products + 8 add-ons) and edit rates anytime."}
            </p>
          </div>
          {catalogCount > 0 ? (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-soft px-3 py-1 text-xs font-semibold text-emerald">
              <Icon name="check" size={12} /> Loaded
            </span>
          ) : (
            <Button
              variant="primary"
              size="sm"
              loading={loadCatalog.isPending}
              onClick={() => loadCatalog.mutate()}
            >
              <Icon name="download" size={13} />
              Load default catalog
            </Button>
          )}
        </div>
      </div>

      <ImportCustomersDialog open={importOpen} onOpenChange={setImportOpen} />
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function SetupPage() {
  const { data: me, isLoading: meLoading } = useCurrentUser();
  const updateTenant = useUpdateTenant();

  const [step, setStep] = React.useState(0);
  const [data, setData] = React.useState<WizardData>({
    companyName:       "",
    gstin:             "",
    state:             "", // R-250: no default state
    address:           "",
    pinCode:           "",
    invoiceCode:       "",
    contactName:       "",
    contactEmail:      "",
    upiVpa:            "",
    bankName:          "",
    accountName:       "",
    accountNumber:     "",
    ifsc:              "",
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
      state:        initialStateCode(me.tenantState, me.tenantStateCode) || d.state,
      address:      me.tenantAddress    || d.address,
      pinCode:      me.tenantPinCode    || d.pinCode,
      contactName:  me.tenantContactName || me.fullName || d.contactName,
      contactEmail: me.tenantEmail      || me.authEmail || d.contactEmail,
      upiVpa:        me.tenantUpiVpa             || d.upiVpa,
      bankName:      me.tenantRemitBankName      || d.bankName,
      accountName:   me.tenantRemitAccountName   || d.accountName,
      accountNumber: me.tenantRemitAccountNumber || d.accountNumber,
      ifsc:          me.tenantRemitIfsc          || d.ifsc,
    }));
  }, [me]);

  const [payError, setPayError] = React.useState<string | null>(null);
  const update = (k: keyof WizardData, v: string | boolean) => {
    if (k === "invoiceCode") setCodeError(null);
    if (k === "upiVpa" || k === "bankName" || k === "accountName" || k === "accountNumber" || k === "ifsc") setPayError(null);
    setData((d) => ({ ...d, [k]: v }));
  };

  // R-259: invoice code — prefill the saved one, else a suggestion from the company name.
  const { data: codeState } = useInvoiceCode();
  const saveInvoiceCode = useSaveInvoiceCode();
  const [codeError, setCodeError] = React.useState<string | null>(null);
  const codePrefilled = React.useRef(false);
  React.useEffect(() => {
    if (!codeState || codePrefilled.current) return;
    if (!codeState.saved && !me) return; // wait for the company name to suggest from
    codePrefilled.current = true;
    if (codeState.locked) return;
    setData((d) => d.invoiceCode ? d : {
      ...d,
      invoiceCode: codeState.saved ?? suggestInvoiceCode(me?.tenantName || d.companyName),
    });
  }, [codeState, me]);

  // Save Step 1 (Company) to the tenants table before advancing past it.
  // Other steps (Razorpay / CSP / Import) are still UI walkthroughs;
  // their actual integrations land in Settings → Integrations later.
  const saveCompanyAndAdvance = async () => {
    // Block on bad GSTIN — empty is fine (optional), wrong checksum is not.
    if (data.gstin.trim() && !isValidGstin(data.gstin.trim())) {
      toast.error("GSTIN is invalid", { description: "Check the 15 characters, or leave the field blank for now." });
      return;
    }
    // R-250: never save a guessed state — chosen, or proven by a valid GSTIN.
    const companyState = resolveCompanyState(data.state, data.gstin);
    if (!companyState) {
      toast.error("Choose your state", { description: "It decides IGST vs CGST + SGST on every invoice." });
      return;
    }
    // R-260: optional UPI / bank — blank is fine, a wrong UPI ID or IFSC is not.
    const payment = {
      upiVpa: data.upiVpa, bankName: data.bankName, accountName: data.accountName,
      accountNumber: data.accountNumber, ifsc: data.ifsc,
    };
    const payProblem = paymentDetailsProblem(payment);
    if (payProblem) {
      setPayError(payProblem);
      toast.error("Check your payment details", { description: payProblem });
      return;
    }
    // R-259: save the invoice code first — if another business has it, stay on this step.
    const code = normalizeInvoiceCode(data.invoiceCode);
    if (code && codeState && !codeState.locked && code !== codeState.saved) {
      const problem = invoiceCodeProblem(code);
      if (problem) { setCodeError(problem); return; }
      try {
        await saveInvoiceCode.mutateAsync(code);
      } catch (e) {
        setCodeError((e as Error).message);
        toast.error("Invoice code not saved", { description: (e as Error).message });
        return;
      }
    }
    try {
      await updateTenant.mutateAsync({
        name:         data.companyName.trim() || me?.tenantName || "Workspace",
        gstin:        data.gstin.trim()        || null,
        state:        companyState.name,
        state_code:   companyState.code,
        address:      data.address.trim()      || null,
        pin_code:     data.pinCode.trim()      || null,
        contact_name: data.contactName.trim()  || null,
        email:        data.contactEmail.trim() || me?.tenantEmail || "",
        ...paymentDetailsPatch(payment),
      });
      setStep((s) => Math.min(STEPS.length - 1, s + 1));
    } catch (e) {
      toastError(e, { fallback: "Could not save your business details" });
    }
  };

  // Reaching the Done screen — by Finish, Skip or the progress bar — stamps
  // setup_completed_at so the dashboard's setup prompt closes (R-260).
  const finishSetup = async () => {
    try {
      await updateTenant.mutateAsync({
        setup_completed_at: new Date().toISOString(),
      });
    } catch {
      // Non-fatal — useUpdateTenant already toasts the error; still show the Done screen.
    }
    setStep(DONE_STEP);
  };

  const goTo = (target: number) => {
    const move = wizardMove(step, target);
    if (move === "save-company") { void saveCompanyAndAdvance(); return; }
    if (move === "finish")       { void finishSetup();           return; }
    setStep(Math.max(0, Math.min(STEPS.length - 1, target)));
  };
  const next = () => goTo(step + 1);
  // R-250: Continue stays off on step 1 until a state is chosen (or a valid GSTIN gives one).
  const companyStateReady = resolveCompanyState(data.state, data.gstin) !== null;
  const back = () => setStep((s) => Math.max(0, s - 1));
  // R-260: Skip on the last step used to bypass finishSetup — it now goes through goTo.
  const skip = () => goTo(step + 1);
  const busy = updateTenant.isPending || saveInvoiceCode.isPending;

  return (
    <div
      className="min-h-screen px-4 py-8 sm:px-6 sm:py-10"
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
                aria-label={`Go to step ${i + 1}: ${s.label}`}
                onClick={() => {
                  if (i === step || i > step + 1 || (step === 0 && i > 0 && !companyStateReady)) return;
                  if (i < step) { setStep(i); return; }
                  goTo(i); // R-260: forward goes through the same save / finish rules as the buttons
                }}
                disabled={i > step + 1 || (step === 0 && i > 0 && !companyStateReady) || busy}
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
                    "mx-auto mb-1.5 flex h-7 w-7 items-center justify-center rounded-full border-1.5 text-2xs font-semibold",
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
                    "text-3xs",
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
        <Card className="p-4 sm:p-6">
          {step === 0 && <StepCompany  data={data} update={update} codeState={codeState} codeError={codeError} payError={payError} />}
          {step === 1 && <StepImport   data={data} update={update} />}
          {step === 2 && <StepRazorpay />}
          {step === 3 && <StepCsp />}
          {step === 4 && <StepDone />}
        </Card>

        {/* ── Footer actions ── */}
        {step < 4 && (
          <div className="mt-5 flex flex-wrap items-center justify-between gap-2">
            <Button
              variant="ghost"
              onClick={back}
              disabled={step === 0 || busy}
            >
              <Icon name="arrow_left" size={14} />
              Back
            </Button>
            <div className="flex flex-wrap justify-end gap-2">
              {step > 0 && (
                <Button variant="ghost" onClick={skip} disabled={busy}>
                  {step === 3 ? "Skip and finish" : "Skip for now"}
                </Button>
              )}
              <Button
                variant="primary"
                onClick={next}
                loading={busy}
                disabled={busy || (step === 0 && !companyStateReady)}
              >
                {busy
                  ? "Saving…"
                  : step === 3 ? "Finish setup" : "Continue"}
                <Icon name="arrow_right" size={14} />
              </Button>
            </div>
          </div>
        )}

        {/* ── Trust footer ── */}
        <p className="mt-10 text-center text-xs text-ink-3">
          Your data stays in your own workspace. Change any of this later in Settings.
        </p>
      </div>
    </div>
  );
}
