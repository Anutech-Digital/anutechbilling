/**
 * TdsDetailDialog — view + manage a single TDS receivable entry.
 *
 * Surfaces all the lifecycle actions for the current status:
 *   pending_cert      Upload Form 16A · WhatsApp chase · Write off
 *   cert_received     View 16A · Verify on 26AS · Re-upload
 *   verified_26as     View 16A · Claim in ITR
 *   claimed           View only (audit trail)
 *   disputed          Re-attempt · WhatsApp customer · Write off
 *   written_off       Restore to pending
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { toastError } from "@/lib/errors/toast-error";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { rupee, formatDate } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import { useConfirm, useAskText } from "@/components/providers/confirm-provider";
import {
  type TdsReceivable,
  TDS_STATUS_LABEL,
  TDS_STATUS_DESCRIPTION,
  uploadForm16a,
  getForm16aSignedUrl,
  useMarkCertReceived,
  useMarkVerified26AS,
  useMarkClaimed,
  useMarkDisputed,
  useWriteOffTds,
  useDeleteTdsReceivable,
} from "@/lib/queries/tds-receivable";

interface Props {
  open:         boolean;
  onOpenChange: (open: boolean) => void;
  tds:          TdsReceivable | null;
}

export function TdsDetailDialog({ open, onOpenChange, tds }: Props) {
  const [uploading, setUploading]   = React.useState(false);
  const [customerPhone, setCustomerPhone] = React.useState<string | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const markCertReceived   = useMarkCertReceived();
  const markVerified26AS   = useMarkVerified26AS();
  const markClaimed        = useMarkClaimed();
  const markDisputed       = useMarkDisputed();
  const writeOff           = useWriteOffTds();
  const deleteTds          = useDeleteTdsReceivable();
  const confirm            = useConfirm();
  const askText            = useAskText();

  // Fetch customer phone for WhatsApp chase
  React.useEffect(() => {
    if (!open || !tds?.customer_id) {
      setCustomerPhone(null);
      return;
    }
    (async () => {
      const supabase = createClient();
      const { data } = await supabase
        .from("customers")
        .select("contact_phone")
        .eq("id", tds.customer_id!)
        .maybeSingle();
      setCustomerPhone(data?.contact_phone ?? null);
    })();
  }, [open, tds?.customer_id]);

  if (!tds) return null;

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    if (!tds) return;
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      setUploading(true);
      const path = await uploadForm16a(tds.id, file);
      await markCertReceived.mutateAsync({ id: tds.id, form16aUrl: path });
      toast.success(`${file.name} uploaded · status moved to "Cert received"`);
    } catch (err) {
      toastError(err, { fallback: "Upload failed.", description: "The certificate was not saved and the status is unchanged. Try again." });
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function handleView16a() {
    if (!tds?.form_16a_url) return;
    try {
      const url = await getForm16aSignedUrl(tds.form_16a_url);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (err) {
      toastError(err, { fallback: "Could not open the document.", description: "The file is still saved. Refresh the page and try again." });
    }
  }

  function whatsappLink(message: string): string {
    if (!customerPhone) return "#";
    const clean = customerPhone.replace(/[^0-9]/g, "");
    return `https://wa.me/${clean}?text=${encodeURIComponent(message)}`;
  }

  const chaseMessage = (() => {
    switch (tds.status) {
      case "pending_cert":
        return `Hi ${tds.customer_name}, you deducted ₹${tds.tds_amount.toLocaleString("en-IN")} TDS (${tds.section} @ ${Number(tds.rate_pct).toFixed(2)}%) on our invoice. ${tds.fiscal_year} is closing — kindly share Form 16A certificate so I can claim it in my ITR. Thanks — Pardeep`;
      case "disputed":
        return `Hi ${tds.customer_name}, the ₹${tds.tds_amount.toLocaleString("en-IN")} TDS you deducted doesn't appear in my Form 26AS for ${tds.fiscal_year}. Could you confirm it was deposited with govt? BSR code / Challan number share kar do please — bohut zaruri hai. — Pardeep`;
      default:
        return `Hi ${tds.customer_name}, regarding TDS ₹${tds.tds_amount.toLocaleString("en-IN")} on ${tds.section}/${tds.fiscal_year} — quick check-in. — Pardeep`;
    }
  })();

  // Status-aware actions
  const actions = renderActions(tds.status);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="md:!max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3">
            TDS Entry
            <Badge color={statusColor(tds.status)}>{TDS_STATUS_LABEL[tds.status]}</Badge>
          </DialogTitle>
          <DialogDescription>
            {TDS_STATUS_DESCRIPTION[tds.status]}
          </DialogDescription>
        </DialogHeader>

        {/* ── Details grid ───────────────────────────────────────── */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-y-3 gap-x-6 text-sm border-y border-hairline py-4">
          <Field label="Customer" value={
            tds.customer_id
              ? <Link href={`/customers/${tds.customer_id}`} className="text-amber-ink hover:underline">{tds.customer_name}</Link>
              : tds.customer_name
          } />
          <Field label="Customer TAN" value={
            <span className="font-mono">{tds.customer_tan ?? "—"}</span>
          } />
          <Field label="Section" value={tds.section} mono />
          <Field label="Rate" value={`${Number(tds.rate_pct).toFixed(2)}%`} mono />
          <Field label="Pre-GST taxable" value={rupee(tds.gross_amount)} mono />
          <Field label="TDS amount" value={<span className="text-rose font-semibold">{rupee(tds.tds_amount)}</span>} mono />
          <Field label="Net paid to bank" value={<span className="text-emerald">{rupee(tds.net_paid)}</span>} mono />
          <Field label="Fiscal year" value={tds.fiscal_year} mono />
          <Field label="Payment date" value={formatDate(tds.payment_received_date)} />
          <Field label="Invoice" value={
            tds.invoice_id
              ? <Link href="/invoices" className="font-mono text-amber-ink hover:underline">{tds.invoice_id}</Link>
              : <span className="text-ink-3">—</span>
          } />
          {tds.form_16a_received_date && (
            <Field label="Form 16A received" value={formatDate(tds.form_16a_received_date)} />
          )}
          {tds.appears_in_26as && tds.appears_in_26as_date && (
            <Field label="26AS verified on" value={formatDate(tds.appears_in_26as_date)} />
          )}
          {tds.claimed_in_itr && tds.claimed_in_itr_date && (
            <Field label="ITR claimed on" value={formatDate(tds.claimed_in_itr_date)} />
          )}
        </div>

        {tds.notes && (
          <div className="bg-paper-2/40 rounded-md p-3 text-xs text-ink-2 leading-relaxed">
            <div className="text-3xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Notes</div>
            {tds.notes}
          </div>
        )}

        {/* ── Document section ───────────────────────────────────── */}
        <div className="border border-hairline rounded-md p-3">
          <div className="flex items-center justify-between mb-2">
            <div>
              <div className="text-sm font-medium text-ink">Form 16A Certificate</div>
              <div className="text-xs text-ink-3 mt-0.5">
                {tds.form_16a_url
                  ? "Uploaded · verify on Form 26AS next"
                  : "PDF or image, max 10 MB"}
              </div>
            </div>
            {tds.form_16a_url ? (
              <Button variant="default" size="sm" onClick={handleView16a}>
                <Icon name="external" size={12} className="mr-1" /> Open
              </Button>
            ) : (
              <>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="application/pdf,image/jpeg,image/png"
                  onChange={handleFileUpload}
                  className="hidden"
                />
                <Button
                  variant="primary"
                  size="sm"
                  loading={uploading}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Icon name="upload" size={12} className="mr-1" /> Upload
                </Button>
              </>
            )}
          </div>
        </div>

        {/* ── WhatsApp chase ─────────────────────────────────────── */}
        {(tds.status === "pending_cert" || tds.status === "disputed") && customerPhone && (
          <a
            href={whatsappLink(chaseMessage)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center justify-center gap-2 w-full px-4 h-11 rounded-lg font-medium text-paper transition-transform hover:scale-[1.01] text-sm"
            style={{ background: "#25D366" }}
          >
            <Icon name="whatsapp" size={16} />
            {tds.status === "pending_cert" ? "Chase customer for Form 16A" : "Chase deposit proof"}
          </a>
        )}

        {/* ── Action buttons ─────────────────────────────────────── */}
        <DialogFooter className="flex-wrap gap-2">
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Close
          </Button>

          {actions.delete && (
            <Button
              type="button"
              variant="default"
              onClick={async () => {
                if (await confirm({ title: "Delete this TDS entry permanently?", danger: true, confirmLabel: "Delete" })) {
                  deleteTds.mutate(tds.id, { onSuccess: () => onOpenChange(false) });
                }
              }}
            >
              <Icon name="trash" size={12} className="mr-1" /> Delete
            </Button>
          )}

          {actions.writeOff && (
            <Button
              type="button"
              variant="default"
              onClick={async () => {
                if (await confirm({ title: `Write off ₹${tds.tds_amount.toLocaleString("en-IN")} as loss?`, body: "You won't claim this in ITR.", danger: true, confirmLabel: "Write off" })) {
                  writeOff.mutate(tds.id, { onSuccess: () => onOpenChange(false) });
                }
              }}
            >
              Write off
            </Button>
          )}

          {actions.dispute && (
            <Button
              type="button"
              variant="default"
              onClick={async () => {
                const reason = await askText({ title: "Mark this TDS as disputed?", label: "Reason", placeholder: "e.g. not on Form 26AS, customer denies deduction", confirmLabel: "Mark disputed" });
                if (reason) {
                  markDisputed.mutate({ id: tds.id, reason }, { onSuccess: () => onOpenChange(false) });
                }
              }}
            >
              Mark disputed
            </Button>
          )}

          {actions.markCertReceived && !tds.form_16a_url && (
            <Button
              type="button"
              variant="default"
              onClick={() => {
                markCertReceived.mutate({ id: tds.id }, { onSuccess: () => onOpenChange(false) });
              }}
            >
              <Icon name="check" size={12} className="mr-1" /> Mark cert received (no upload)
            </Button>
          )}

          {actions.verify26AS && (
            <Button
              type="button"
              variant="primary"
              onClick={() => {
                markVerified26AS.mutate(tds.id, { onSuccess: () => onOpenChange(false) });
              }}
            >
              <Icon name="check_circle" size={12} className="mr-1" /> Verified on 26AS
            </Button>
          )}

          {actions.claim && (
            <Button
              type="button"
              variant="primary"
              onClick={() => {
                markClaimed.mutate(tds.id, { onSuccess: () => onOpenChange(false) });
              }}
            >
              <Icon name="check" size={12} className="mr-1" /> Mark claimed in ITR
            </Button>
          )}

          {actions.restore && (
            <Button
              type="button"
              variant="default"
              onClick={() => {
                markCertReceived.mutate({ id: tds.id }, { onSuccess: () => onOpenChange(false) });
              }}
            >
              Restore to pending
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

function statusColor(status: TdsReceivable["status"]) {
  return status === "pending_cert"  ? "rose"
       : status === "cert_received" ? "amber"
       : status === "verified_26as" ? "emerald"
       : status === "claimed"       ? "indigo"
       : status === "disputed"      ? "rose"
       :                              "slate";
}

interface ActionFlags {
  markCertReceived?: boolean;
  verify26AS?:       boolean;
  claim?:            boolean;
  dispute?:          boolean;
  writeOff?:         boolean;
  restore?:          boolean;
  delete?:           boolean;
}

function renderActions(status: TdsReceivable["status"]): ActionFlags {
  switch (status) {
    case "pending_cert":
      return { markCertReceived: true, writeOff: true, delete: true };
    case "cert_received":
      return { verify26AS: true, dispute: true, writeOff: true };
    case "verified_26as":
      return { claim: true, dispute: true };
    case "claimed":
      return { delete: false }; // audit trail — no actions
    case "disputed":
      return { markCertReceived: true, writeOff: true, delete: true };
    case "written_off":
      return { restore: true, delete: true };
    default:
      return {};
  }
}

function Field({
  label, value, mono,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div>
      <div className="text-3xs uppercase tracking-wider text-ink-3 font-semibold mb-0.5">{label}</div>
      <div className={`text-ink ${mono ? "font-mono" : ""}`}>{value}</div>
    </div>
  );
}
