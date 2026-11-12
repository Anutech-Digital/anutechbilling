/**
 * Interactive Dynamic UPI QR Code Component for ResellerOS & Solo Freelancers.
 *
 * Renders an instant scan-to-pay QR code (GPay / PhonePe / Paytm / BHIM) using
 * NPCI-compliant `upi://pay?...` intent string generated from `@/lib/payments/upi`.
 *
 * FEATURES:
 * 1. Client-side QR generation via `qrcode` (no third-party tracking or external server).
 * 2. Instant "Copy UPI Link" & "Open in UPI App".
 * 3. Inline UPI ID (VPA) setup if not yet configured, saving directly via `useUpdateTenant`.
 * 4. Fails safe: if invoice amount due is 0 (already paid in full), politely indicates fully paid.
 */
"use client";

import * as React from "react";
import { toast } from "sonner";
import { Icon } from "@/components/ui/icon";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { rupee } from "@/lib/utils";
import { isValidVpa, buildUpiIntent } from "@/lib/payments/upi";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { useUpdateTenant } from "@/lib/queries/tenant";
import type { Invoice } from "@/lib/supabase/database.types";

export interface UpiQrCardProps {
  invoice: Invoice;
  amountDue: number;
  className?: string;
  compact?: boolean;
}

export function UpiQrCard({
  invoice,
  amountDue,
  className = "",
  compact = false,
}: UpiQrCardProps) {
  const { data: me } = useCurrentUser();
  const updateTenant = useUpdateTenant();

  const [qrDataUrl, setQrDataUrl] = React.useState<string | null>(null);
  const [generating, setGenerating] = React.useState(false);
  const [vpaInput, setVpaInput] = React.useState("");
  const [isSettingVpa, setIsSettingVpa] = React.useState(false);

  const vpa = me?.tenantUpiVpa?.trim() || "";
  const payeeName = me?.tenantUpiPayeeName?.trim() || me?.tenantName?.trim() || "Independent Professional";
  const isPaid = amountDue <= 0 || invoice.status === "paid";

  // Build UPI Intent
  const upiResult = React.useMemo(() => {
    if (!vpa || isPaid) return null;
    return buildUpiIntent({
      vpa,
      payeeName,
      amount: amountDue,
      note: `Invoice ${invoice.id}`,
      ref: invoice.id,
    });
  }, [vpa, payeeName, amountDue, isPaid, invoice.id]);

  const intentUri = upiResult?.ok ? upiResult.uri : null;

  // Generate QR image
  React.useEffect(() => {
    if (!intentUri) {
      setQrDataUrl(null);
      return;
    }

    let active = true;
    setGenerating(true);

    import("qrcode")
      .then((QRCode) => {
        return QRCode.toDataURL(intentUri, {
          errorCorrectionLevel: "M",
          margin: 1,
          width: compact ? 200 : 256,
          color: {
            dark: "#0F172A",
            light: "#FFFFFF",
          },
        });
      })
      .then((url) => {
        if (active) {
          setQrDataUrl(url);
          setGenerating(false);
        }
      })
      .catch((err) => {
        console.error("Failed to generate QR code", err);
        if (active) {
          setQrDataUrl(null);
          setGenerating(false);
        }
      });

    return () => {
      active = false;
    };
  }, [intentUri, compact]);

  const handleCopyLink = () => {
    if (!intentUri) return;
    navigator.clipboard.writeText(intentUri);
    toast.success("UPI Intent link copied to clipboard", {
      description: "Paste in any UPI app or share with your client.",
    });
  };

  const handleCopyVpa = () => {
    if (!vpa) return;
    navigator.clipboard.writeText(vpa);
    toast.success(`Copied UPI ID: ${vpa}`);
  };

  const handleSaveVpa = () => {
    const trimmed = vpaInput.trim();
    if (!isValidVpa(trimmed)) {
      toast.error("Please enter a valid UPI ID", {
        description: "Example format: yourname@okaxis, yourbrand@icici, or 9876543210@upi",
      });
      return;
    }

    updateTenant.mutate(
      { upi_vpa: trimmed },
      {
        onSuccess: () => {
          setIsSettingVpa(false);
          setVpaInput("");
          toast.success("UPI ID activated successfully!", {
            description: "Your clients can now scan and pay instantly via GPay / PhonePe / Paytm.",
          });
        },
        onError: (err) => {
          toast.error("Failed to save UPI ID", {
            description: (err as Error).message || "Please try again.",
          });
        },
      },
    );
  };

  // If invoice is fully settled
  if (isPaid) {
    return (
      <Card className={`p-4 border-emerald-500/20 bg-emerald-500/5 ${className}`}>
        <div className="flex items-center gap-3 text-emerald-700 dark:text-emerald-400">
          <div className="w-8 h-8 rounded-full bg-emerald-500/10 flex items-center justify-center shrink-0">
            <Icon name="check" size={16} />
          </div>
          <div>
            <h4 className="text-xs font-semibold">Invoice Paid in Full</h4>
            <p className="text-2xs text-ink-3">No balance due. UPI payment QR is automatically disabled to prevent double payments.</p>
          </div>
        </div>
      </Card>
    );
  }

  // If tenant has not configured a UPI ID yet
  if (!vpa || isSettingVpa) {
    return (
      <Card className={`p-4 border-amber-500/20 bg-amber-500/5 ${className}`}>
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-amber-800 dark:text-amber-400">
            <Icon name="rupee" size={16} />
            <h4 className="text-xs font-semibold">Enable Instant UPI QR Payments</h4>
            <Badge variant="outline" className="text-3xs bg-white/60 dark:bg-black/40">Solo & Freelancer Ready</Badge>
          </div>
          <p className="text-2xs text-ink-3 leading-relaxed">
            Accept direct zero-fee payments from Google Pay, PhonePe, Paytm, and BHIM into your bank account.
            Enter your personal or business UPI ID below:
          </p>

          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 pt-1">
            <Input
              type="text"
              placeholder="e.g. yourname@okaxis, 9876543210@upi"
              value={vpaInput}
              onChange={(e) => setVpaInput(e.target.value)}
              className="text-xs h-9 bg-white dark:bg-paper-1"
            />
            <div className="flex items-center gap-1.5 shrink-0">
              <Button
                size="sm"
                variant="primary"
                onClick={handleSaveVpa}
                loading={updateTenant.isPending}
                disabled={!vpaInput.trim()}
              >
                Save UPI ID
              </Button>
              {vpa && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setIsSettingVpa(false)}
                >
                  Cancel
                </Button>
              )}
            </div>
          </div>
        </div>
      </Card>
    );
  }

  return (
    <Card className={`p-4 bg-paper-1 border-hairline overflow-hidden ${className}`}>
      <div className="flex flex-col sm:flex-row items-center gap-5">
        {/* QR Canvas / Image */}
        <div className="shrink-0 flex flex-col items-center bg-white p-2.5 rounded-lg border border-hairline shadow-xs">
          {generating ? (
            <div className="w-[180px] h-[180px] flex flex-col items-center justify-center gap-2 text-ink-3">
              <div className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
              <span className="text-3xs">Generating UPI QR…</span>
            </div>
          ) : qrDataUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={qrDataUrl}
              alt={`UPI QR for ${invoice.id}`}
              className="w-[180px] h-[180px] object-contain rounded"
            />
          ) : (
            <div className="w-[180px] h-[180px] flex items-center justify-center text-xs text-ink-3">
              QR unavailable
            </div>
          )}
          <span className="text-[10px] text-ink-3 mt-1.5 font-medium tracking-wide">
            SCAN WITH ANY UPI APP
          </span>
        </div>

        {/* Details & Actions */}
        <div className="flex-1 min-w-0 space-y-2.5 text-center sm:text-left">
          <div>
            <div className="flex flex-wrap items-center justify-center sm:justify-start gap-1.5 mb-1">
              <Badge variant="outline" className="text-3xs bg-primary/5 text-primary border-primary/20 font-semibold">
                Instant UPI (0% Fee)
              </Badge>
              <Badge variant="secondary" className="text-3xs">
                NPCI Standard
              </Badge>
            </div>
            <h4 className="text-base font-bold text-ink flex items-center justify-center sm:justify-start gap-1.5">
              <span>Pay {rupee(amountDue)}</span>
            </h4>
            <p className="text-2xs text-ink-3 mt-0.5">
              Direct settlement to bank. GPay, PhonePe, Paytm, CRED & BHIM.
            </p>
          </div>

          {/* VPA Info Bar */}
          <div className="inline-flex items-center gap-2 px-2.5 py-1.5 bg-paper-2 rounded border border-hairline text-xs font-mono text-ink-2 max-w-full">
            <span className="truncate">{vpa}</span>
            <button
              type="button"
              onClick={handleCopyVpa}
              title="Copy UPI ID"
              className="text-ink-3 hover:text-ink transition-colors shrink-0"
            >
              <Icon name="copy" size={12} />
            </button>
            <button
              type="button"
              onClick={() => {
                setVpaInput(vpa);
                setIsSettingVpa(true);
              }}
              title="Edit UPI ID"
              className="text-ink-3 hover:text-ink transition-colors shrink-0 text-3xs font-sans text-primary underline"
            >
              Change
            </button>
          </div>

          {/* Supported Apps Chips */}
          <div className="flex flex-wrap items-center justify-center sm:justify-start gap-1 text-[11px] text-ink-3">
            <span className="px-1.5 py-0.5 rounded bg-paper-2 border border-hairline">Google Pay</span>
            <span className="px-1.5 py-0.5 rounded bg-paper-2 border border-hairline">PhonePe</span>
            <span className="px-1.5 py-0.5 rounded bg-paper-2 border border-hairline">Paytm</span>
            <span className="px-1.5 py-0.5 rounded bg-paper-2 border border-hairline">BHIM</span>
          </div>

          {/* Action Buttons */}
          <div className="flex flex-wrap items-center justify-center sm:justify-start gap-2 pt-1">
            <Button
              size="sm"
              variant="outline"
              icon="copy"
              onClick={handleCopyLink}
              disabled={!intentUri}
            >
              Copy UPI Link
            </Button>
            {intentUri && (
              <a
                href={intentUri}
                className="inline-flex items-center justify-center font-medium rounded-md transition-colors text-xs px-3 h-8 bg-primary text-white hover:bg-primary/90"
              >
                <Icon name="send" size={13} className="mr-1.5" />
                Pay via UPI App
              </a>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}

/**
 * Dedicated UPI QR Modal Dialog for quick popups anywhere.
 */
export function UpiQrDialog({
  open,
  onOpenChange,
  invoice,
  amountDue,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  invoice: Invoice;
  amountDue: number;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md p-6">
        <DialogHeader className="mb-2">
          <DialogTitle className="flex items-center gap-2">
            <Icon name="rupee" size={18} className="text-primary" />
            <span>UPI Payment QR</span>
          </DialogTitle>
          <DialogDescription>
            Scan to pay Tax Invoice {invoice.id} for {rupee(amountDue)}.
          </DialogDescription>
        </DialogHeader>

        <UpiQrCard invoice={invoice} amountDue={amountDue} />
      </DialogContent>
    </Dialog>
  );
}
