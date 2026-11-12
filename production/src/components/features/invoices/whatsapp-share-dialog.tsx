/**
 * WhatsApp Quick Share Dialog for Invoices.
 *
 * Allows solo freelancers and resellers to preview and customize the invoice
 * payment reminder message, verify/enter the client's phone number, view
 * the embedded UPI payment link, and send directly via WhatsApp or copy to clipboard.
 */
"use client";

import * as React from "react";
import { toast } from "sonner";
import { Icon } from "@/components/ui/icon";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { rupee, formatDate, toWhatsAppDigits } from "@/lib/utils";
import { buildUpiIntent } from "@/lib/payments/upi";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import type { Invoice, Customer } from "@/lib/supabase/database.types";

export interface WhatsAppShareDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  invoice: Invoice;
  customer?: Customer | null;
  amountDue: number;
}

export function WhatsAppShareDialog({
  open,
  onOpenChange,
  invoice,
  customer,
  amountDue,
}: WhatsAppShareDialogProps) {
  const { data: me } = useCurrentUser();

  const [phone, setPhone] = React.useState(customer?.contact_phone || "");
  const [customGreeting, setCustomGreeting] = React.useState(customer?.contact_name || invoice.customer_name || "");

  // Keep phone synced with customer when opened
  React.useEffect(() => {
    if (open) {
      setPhone(customer?.contact_phone || "");
      setCustomGreeting(customer?.contact_name || invoice.customer_name || "");
    }
  }, [open, customer, invoice]);

  const vpa = me?.tenantUpiVpa?.trim();
  const payeeName = me?.tenantUpiPayeeName?.trim() || me?.tenantName?.trim();
  const businessName = me?.tenantName?.trim() || "";

  // Compute UPI link if applicable
  const upiIntent = React.useMemo(() => {
    if (!vpa || !payeeName || amountDue <= 0) return null;
    const res = buildUpiIntent({
      vpa,
      payeeName,
      amount: amountDue,
      note: `Invoice ${invoice.id}`,
      ref: invoice.id,
    });
    return res.ok ? res.uri : null;
  }, [vpa, payeeName, amountDue, invoice.id]);

  // Construct message
  const message = React.useMemo(() => {
    const greetingName = customGreeting?.trim() ? ` ${customGreeting.trim()}` : "";
    const dueClause = invoice.due_date ? ` which is due on *${formatDate(invoice.due_date)}*` : "";
    const payClause = upiIntent
      ? `\n\n💳 *Pay instantly via UPI (GPay / PhonePe / Paytm / BHIM):*\n${upiIntent}`
      : "";
    const sign = businessName ? `\n\nBest regards,\n*${businessName}*` : "";

    return `Namaste${greetingName} 🙏,

This is regarding Tax Invoice *${invoice.id}* for *${rupee(amountDue)}*${dueClause}.

Kindly arrange the payment at your convenience. If already paid, please ignore this note.${payClause}

Thank you!${sign}`;
  }, [customGreeting, invoice.id, invoice.due_date, amountDue, upiIntent, businessName]);

  const handleSend = () => {
    const digits = toWhatsAppDigits(phone);
    if (!digits) {
      toast.error("Please enter a valid 10-digit mobile number");
      return;
    }

    const waUrl = `https://wa.me/91${digits}?text=${encodeURIComponent(message)}`;
    window.open(waUrl, "_blank");
    onOpenChange(false);
  };

  const handleCopyMessage = () => {
    navigator.clipboard.writeText(message);
    toast.success("WhatsApp message copied to clipboard", {
      description: "You can paste this in any messaging app, SMS, or email.",
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg p-6">
        <DialogHeader className="mb-3">
          <DialogTitle className="flex items-center gap-2">
            <Icon name="whatsapp" size={18} className="text-emerald-600" />
            <span>Share Invoice via WhatsApp</span>
          </DialogTitle>
          <DialogDescription>
            Preview and send an instant payment reminder with your UPI link to the client.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Phone and Name row */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-2xs font-semibold uppercase tracking-wider text-ink-3 mb-1">
                Client Mobile (10-Digit)
              </label>
              <Input
                type="tel"
                placeholder="e.g. 9876543210"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                className="text-xs h-9"
              />
            </div>
            <div>
              <label className="block text-2xs font-semibold uppercase tracking-wider text-ink-3 mb-1">
                Client Contact Name
              </label>
              <Input
                type="text"
                placeholder="e.g. Rahul Sharma"
                value={customGreeting}
                onChange={(e) => setCustomGreeting(e.target.value)}
                className="text-xs h-9"
              />
            </div>
          </div>

          {/* Message Preview Box */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-2xs font-semibold uppercase tracking-wider text-ink-3">
                Message Preview
              </label>
              <button
                type="button"
                onClick={handleCopyMessage}
                className="text-3xs text-primary hover:underline flex items-center gap-1 font-medium"
              >
                <Icon name="copy" size={10} />
                <span>Copy text</span>
              </button>
            </div>
            <div className="p-3 bg-paper-2 rounded-md border border-hairline text-xs font-mono whitespace-pre-wrap text-ink-2 max-h-[220px] overflow-y-auto leading-relaxed select-all">
              {message}
            </div>
          </div>

          {/* Action Footer */}
          <div className="flex items-center justify-between gap-2 pt-2 border-t border-hairline">
            <Button
              size="sm"
              variant="outline"
              icon="copy"
              onClick={handleCopyMessage}
            >
              Copy Message
            </Button>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                variant="primary"
                icon="whatsapp"
                className="bg-emerald-600 hover:bg-emerald-700 text-white"
                onClick={handleSend}
              >
                Send on WhatsApp
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
