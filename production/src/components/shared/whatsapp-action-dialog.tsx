"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Label } from "@/components/ui/label";
import { useSendWhatsApp } from "@/lib/queries/whatsapp";

export type WhatsAppCategory = "quote" | "invoice" | "renewal" | "welcome" | "custom";

export interface WhatsAppActionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  phone?: string | null;
  recipientName?: string | null;
  companyName?: string | null;
  category?: WhatsAppCategory;
  /** Context variables to populate templates */
  vars?: {
    quoteNumber?: string;
    invoiceNumber?: string;
    amount?: string;
    dueDate?: string;
    domain?: string;
    productName?: string;
    seats?: number;
    link?: string;
    bankDetails?: string;
  };
}

export function WhatsAppActionDialog({
  open,
  onOpenChange,
  phone,
  recipientName = "Valued Partner",
  companyName = "Customer",
  category = "quote",
  vars = {},
}: WhatsAppActionDialogProps) {
  const sendApi = useSendWhatsApp();
  const [selectedTemplate, setSelectedTemplate] = React.useState<WhatsAppCategory>(category);
  const [message, setMessage] = React.useState("");

  // Clean phone number (strip + or spaces, default +91 for India if 10 digits)
  const cleanPhone = React.useMemo(() => {
    if (!phone) return "";
    let p = phone.replace(/[^\d]/g, "");
    if (p.length === 10) p = "91" + p;
    return p;
  }, [phone]);

  // Template generators
  const templates = React.useMemo(() => {
    const cName = recipientName || companyName || "Valued Client";
    const co = companyName || "your organization";

    return {
      quote: `Hi ${cName},\n\n` +
        `Greetings from Anutech Digital! 🚀\n\n` +
        `We have generated Quote *${vars.quoteNumber || "Q-2026-XXXX"}* for ${co}.\n` +
        `• *Plan/Product:* ${vars.productName || "Google Workspace / M365"}\n` +
        `• *Seats:* ${vars.seats || 10} licenses\n` +
        `• *Total Value:* ${vars.amount || "₹XX,XXX"}\n\n` +
        `You can view, download, and approve your quote online here:\n${vars.link || "https://anutechbilling.com/quote"}\n\n` +
        `Please let us know if you need any adjustments or custom licensing terms!`,

      invoice: `Hi ${cName},\n\n` +
        `Hope you are having a productive day!\n\n` +
        `This is a gentle payment reminder for GST Invoice *${vars.invoiceNumber || "INV-XXXX"}* issued to ${co}.\n` +
        `• *Amount Due:* *${vars.amount || "₹XX,XXX"}*\n` +
        `• *Due Date:* ${vars.dueDate || "Immediate"}\n\n` +
        `*Bank Details for RTGS/NEFT/UPI:*\n` +
        `Bank: ICICI Bank Ltd\n` +
        `A/c Name: Anutech Digital Solutions\n` +
        `A/c No: 002105001928\n` +
        `IFSC: ICIC0000021\n` +
        `UPI ID: anutech@icici\n\n` +
        `Kindly share the transaction UTR once processed. Thank you!`,

      renewal: `Hi ${cName},\n\n` +
        `⚠️ *Subscription Expiration Warning*\n\n` +
        `Your subscription for *${vars.domain || co}* (${vars.productName || "Cloud Service"}) is due for renewal on *${vars.dueDate || "soon"}*.\n\n` +
        `To avoid service interruption, admin lockout, or email bounce, please confirm your renewal quote *${vars.quoteNumber || "Q-XXXX"}* (${vars.amount || "₹XX,XXX"}).\n\n` +
        `Quick Link: ${vars.link || "https://anutechbilling.com/renewals"}\n\n` +
        `Reply YES to auto-renew or call us at +91 98765 43210.`,

      welcome: `Hi ${cName},\n\n` +
        `🎉 Welcome to Anutech Digital!\n\n` +
        `Your service provisioning for *${co}* is now COMPLETE.\n` +
        `• *Domain/Tenant:* ${vars.domain || "Your Workspace"}\n` +
        `• *Licenses Active:* ${vars.seats || 10} seats\n\n` +
        `Your admin console is active. For technical support or license additions, reply to this chat or email support@anutechdigital.com.`,

      custom: `Hi ${cName},\n\n`,
    };
  }, [recipientName, companyName, vars]);

  // Sync message when category or template changes
  React.useEffect(() => {
    setSelectedTemplate(category);
    setMessage(templates[category] || templates.quote);
  }, [category, templates]);

  const handleTemplateChange = (cat: WhatsAppCategory) => {
    setSelectedTemplate(cat);
    setMessage(templates[cat]);
  };

  const handleOpenWhatsAppWeb = () => {
    if (!cleanPhone) {
      toast.error("No phone number available for this contact");
      return;
    }
    const url = `https://api.whatsapp.com/send?phone=${cleanPhone}&text=${encodeURIComponent(message)}`;
    window.open(url, "_blank", "noopener,noreferrer");
    toast.success("Opening WhatsApp Web...");
  };

  const handleCopyMessage = () => {
    navigator.clipboard.writeText(message);
    toast.success("Message copied to clipboard!");
  };

  const handleSendMetaApi = async () => {
    if (!cleanPhone) {
      toast.error("No phone number available");
      return;
    }
    try {
      await sendApi.mutateAsync({ to: cleanPhone, text: message });
      toast.success("WhatsApp message sent via Cloud API!");
      onOpenChange(false);
    } catch (e: any) {
      toast.error(e?.message || "Could not send via API. Use WhatsApp Web button instead.");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg bg-paper border border-hairline p-5">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-lg font-serif">
            <Icon name="whatsapp" size={20} className="text-emerald" />
            Send WhatsApp Action Message
          </DialogTitle>
          <DialogDescription className="text-xs text-ink-3">
            Recipient: <b className="text-ink">{companyName}</b> ({phone || "No phone"})
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 my-2">
          {/* Category Chips */}
          <div>
            <Label className="text-xs font-semibold text-ink-2 mb-1.5 block">Select Preset Template:</Label>
            <div className="flex items-center gap-1.5 flex-wrap">
              {[
                { id: "quote", label: "📄 Quote Link" },
                { id: "invoice", label: "💳 Invoice Due" },
                { id: "renewal", label: "⏰ Renewal Notice" },
                { id: "welcome", label: "🚀 Provisioned" },
                { id: "custom", label: "✏️ Custom" },
              ].map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => handleTemplateChange(t.id as WhatsAppCategory)}
                  className={`px-2.5 py-1 text-xs font-medium rounded-full border transition-all cursor-pointer ${
                    selectedTemplate === t.id
                      ? "bg-emerald/15 border-emerald text-emerald font-semibold"
                      : "bg-paper-2 border-hairline text-ink-2 hover:bg-paper-3"
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          {/* Editable Message Text Area */}
          <div>
            <Label className="text-xs font-semibold text-ink-2 mb-1.5 block">Message Body (Editable):</Label>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={8}
              className="w-full text-xs font-mono p-3 rounded-md border border-hairline bg-paper-2/60 focus:bg-paper focus:outline-none focus:ring-1 focus:ring-amber text-ink leading-relaxed"
            />
          </div>
        </div>

        <DialogFooter className="flex items-center justify-between gap-2 sm:justify-between pt-2 border-t border-hairline">
          <Button
            type="button"
            variant="default"
            size="sm"
            onClick={handleCopyMessage}
            className="gap-1.5 text-xs"
          >
            <Icon name="copy" size={13} /> Copy Text
          </Button>

          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="default"
              size="sm"
              onClick={handleSendMetaApi}
              disabled={sendApi.isPending || !cleanPhone}
              className="gap-1.5 text-xs hidden sm:inline-flex"
            >
              <Icon name="send" size={13} /> Via Cloud API
            </Button>
            <Button
              type="button"
              variant="primary"
              size="sm"
              onClick={handleOpenWhatsAppWeb}
              disabled={!cleanPhone}
              className="gap-1.5 text-xs bg-emerald hover:bg-emerald/90 text-white"
            >
              <Icon name="whatsapp" size={14} /> Open WhatsApp
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
