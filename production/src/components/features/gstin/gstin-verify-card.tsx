/**
 * GstinVerifyCard — shows the cached + live verification of a GSTIN.
 *
 * Two responsibilities:
 *  1. "Verify with GSTN" button — calls /api/gstin/verify, persists the
 *     result on the tenants row (when the GSTIN matches current tenant).
 *  2. Result preview — legal name, trade name, status, constitution, etc.
 *
 * Used in Settings → Company tab and Setup Wizard Step 1.
 */

"use client";

import * as React from "react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { cn, formatDate, daysBetween, isValidGstin, validateGstin } from "@/lib/utils";
import type { GstinVerification } from "@/lib/supabase/database.types";

interface Props {
  /** Live value from the GSTIN field — used by the button to know what
   *  to verify, and to compare against the cached verification. */
  gstin: string;
  /** Verification last persisted on this tenant. null = never verified. */
  cached?:        GstinVerification | null;
  cachedAt?:      string | null;
  /** When true, hide the "Save to tenant" persistence — useful inside the
   *  Setup Wizard where the tenant write happens together with the rest
   *  of Step 1 on Continue. */
  noPersist?:     boolean;
  /** Optional onVerified callback so the host can refresh its own data. */
  onVerified?:    (v: GstinVerification) => void;
  /** Called when the visitor clicks "Fill form from GST" — host pushes
   *  the structured fields back into its own form (RHF setValue or local
   *  state updates). When omitted, the Fill button is hidden. */
  onFillForm?:    (v: GstinVerification) => void;
}

function statusTone(s?: string | null): "success" | "warning" | "danger" | "muted" {
  if (!s)                              return "muted";
  if (/active/i.test(s))               return "success";
  if (/cancel|inactive/i.test(s))      return "danger";
  if (/suspend|provis/i.test(s))       return "warning";
  return "muted";
}

export default function GstinVerifyCard({
  gstin, cached, cachedAt, noPersist = false, onVerified, onFillForm,
}: Props) {
  const qc = useQueryClient();
  const [verifying, setVerifying] = React.useState(false);
  const [result,    setResult]    = React.useState<GstinVerification | null>(cached ?? null);

  // When the underlying cache prop changes (e.g. useCurrentUser refetches),
  // keep the displayed verification in sync.
  React.useEffect(() => { setResult(cached ?? null); }, [cached]);

  const cleanGstin = (gstin || "").trim().toUpperCase();
  const canVerify  = isValidGstin(cleanGstin);

  // Foreign online-service suppliers (OIDAR — e.g. Anthropic, Google, Microsoft)
  // register under state code "99" (Centre Jurisdiction). Their GSTIN does NOT
  // follow the domestic PAN-based format/checksum, and GSTN online-verify does
  // not cover them — so we recognise it, skip the "invalid" error, and let the
  // vendor be saved as-is.
  const isOidar = cleanGstin.length === 15 && /^99/.test(cleanGstin);

  // Friendly, specific reason the Verify button is still locked — so the user
  // knows what to do instead of staring at a disabled button.
  const gstinHint = React.useMemo(() => {
    if (!cleanGstin) return { tone: "muted" as const, text: "Enter the supplier's GSTIN to verify & auto-fill their details." };
    if (isOidar)     return { tone: "info" as const,  text: "Foreign supplier (OIDAR) GSTIN — online GSTN verification isn't available for these. You can still save this vendor; place of supply is set to Centre Jurisdiction." };
    const v = validateGstin(cleanGstin);
    if (v.ok) return null;
    if (v.reason === "length")   return { tone: "bad" as const, text: `A GSTIN is 15 characters — you've typed ${cleanGstin.length}.` };
    if (v.reason === "format")   return { tone: "bad" as const, text: "This GSTIN doesn't look right — it should be 2 digits, 5 letters, 4 digits, then 4 more characters." };
    if (v.reason === "checksum") return { tone: "bad" as const, text: "This GSTIN's check digit doesn't match — please re-check the number." };
    return { tone: "bad" as const, text: "Enter a valid GSTIN to verify." };
  }, [cleanGstin, isOidar]);

  // Staleness: if the cached verification is > 30 days old, surface a
  // gentle nudge to re-verify. (We don't auto-invalidate — GSTN status
  // rarely changes day-to-day for an active registration.)
  const ageDays = cachedAt ? daysBetween(new Date(cachedAt), new Date()) : null;
  const stale   = ageDays != null && ageDays > 30;

  async function verify() {
    if (!canVerify) {
      toast.error("Fix the GSTIN format / checksum first");
      return;
    }
    setVerifying(true);
    try {
      const res  = await fetch("/api/gstin/verify", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ gstin: cleanGstin, save: !noPersist }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        toast.error(json.error ?? "Verification failed");
        return;
      }
      const verification = json.verification as GstinVerification;
      setResult(verification);
      onVerified?.(verification);

      const note = json.mock
        ? "Mock verification (Sandbox not configured). UI is testable; add SANDBOX_API_KEY to .env.local for real GSTN data."
        : `Verified — ${verification.legal_name ?? "GSTIN"} is ${verification.status}`;
      toast.success(note);

      // Refresh useCurrentUser so the dashboard / settings pre-fills see
      // the new verification immediately.
      if (!noPersist) await qc.invalidateQueries({ queryKey: ["current-user"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Network error");
    } finally {
      setVerifying(false);
    }
  }

  // ── Render
  return (
    <div className="mt-2 space-y-2">
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant={result ? "default" : "primary"}
          size="sm"
          loading={verifying}
          disabled={!canVerify}
          onClick={verify}
        >
          <Icon name="check_circle" size={13} />
          {result ? "Re-verify with GSTN" : "Verify with GSTN"}
        </Button>
        {result && cachedAt && !stale && (
          <span className="inline-flex items-center gap-1 text-[10px] text-emerald">
            <Icon name="check" size={11} />
            Verified · {formatDate(cachedAt)}
          </span>
        )}
        {result && stale && (
          <span className="inline-flex items-center gap-1 text-[10px] text-amber-ink">
            <Icon name="alert" size={11} />
            Cached {ageDays} days ago — consider re-verifying
          </span>
        )}
        {!canVerify && gstinHint && (
          <span className={cn(
            "text-[11px] leading-snug",
            gstinHint.tone === "bad" ? "text-rose" : gstinHint.tone === "info" ? "text-amber-ink" : "text-ink-3"
          )}>
            {gstinHint.text}
          </span>
        )}
      </div>

      {result && (
        <div className="rounded-lg border border-hairline bg-paper p-3 space-y-2">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="font-medium text-sm text-ink truncate" title={result.legal_name ?? ""}>
                {result.legal_name ?? "(legal name not provided)"}
              </p>
              {result.trade_name && result.trade_name !== result.legal_name && (
                <p className="text-xs text-ink-3 truncate" title={result.trade_name}>
                  Trade name: {result.trade_name}
                </p>
              )}
            </div>
            <Badge kind={statusTone(result.status)} dot>{result.status}</Badge>
          </div>

          <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[11px] text-ink-3">
            {result.constitution && (
              <div><span className="text-ink-3">Constitution</span><br /><span className="text-ink-2">{result.constitution}</span></div>
            )}
            {result.registration_type && (
              <div><span className="text-ink-3">Type</span><br /><span className="text-ink-2">{result.registration_type}</span></div>
            )}
            {result.valid_from && (
              <div><span className="text-ink-3">Registered</span><br /><span className="text-ink-2">{formatDate(result.valid_from)}</span></div>
            )}
            {result.last_return_filed && (
              <div><span className="text-ink-3">Last return filed</span><br /><span className="text-ink-2">{formatDate(result.last_return_filed)}</span></div>
            )}
            {result.jurisdiction && (
              <div className="col-span-2"><span className="text-ink-3">Jurisdiction</span><br /><span className="text-ink-2">{result.jurisdiction}</span></div>
            )}
            {result.address && (
              <div className="col-span-2">
                <span className="text-ink-3">Principal address</span><br />
                <span className="text-ink-2">{result.address}</span>
              </div>
            )}
          </div>

          {/* Fill form from GST — explicit user action; never silent */}
          {onFillForm && (
            <div className="flex items-center justify-between gap-3 pt-2 mt-1 border-t border-hairline">
              <p className="text-[11px] text-ink-3 leading-snug max-w-[60%]">
                Copy legal name, address and PIN from this verification into the Company form?
              </p>
              <Button
                type="button"
                variant="primary"
                size="sm"
                icon="download"
                onClick={() => {
                  onFillForm(result);
                  toast.success("Form populated from GST portal data");
                }}
              >
                Fill form from GST
              </Button>
            </div>
          )}

          {result.source === "mock" && (
            <p className={cn(
              "text-[10px] inline-flex items-center gap-1.5 mt-1 px-2 py-1 rounded",
              "bg-amber-soft/60 text-amber-ink"
            )}>
              <Icon name="info" size={10} />
              Mock data — configure Sandbox.co.in credentials in Settings → Integrations for live GSTN lookups.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
