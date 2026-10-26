"use client";

import * as React from "react";
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
import { Icon } from "@/components/ui/icon";
import { Label } from "@/components/ui/label";
import { useSendWhatsApp } from "@/lib/queries/whatsapp";

import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import {
  buildWhatsAppTemplates,
  senderFromUser,
  type WhatsAppCategory,
  type WhatsAppTemplateVars,
} from "@/lib/whatsapp/action-templates";

export type { WhatsAppCategory };

export interface WhatsAppActionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  phone?: string | null;
  recipientName?: string | null;
  companyName?: string | null;
  category?: WhatsAppCategory;
  /** Context variables to populate templates */
  vars?: WhatsAppTemplateVars;
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
  const fieldId = React.useId();

  // Clean phone number (strip + or spaces, default +91 for India if 10 digits)
  const cleanPhone = React.useMemo(() => {
    if (!phone) return "";
    let p = phone.replace(/[^\d]/g, "");
    if (p.length === 10) p = "91" + p;
    return p;
  }, [phone]);

  // Presets speak for the logged-in company (R-1924): its own name, bank, UPI, email, phone.
  const { data: me } = useCurrentUser();
  const sender = React.useMemo(() => senderFromUser(me), [me]);
  const templates = React.useMemo(
    () => buildWhatsAppTemplates({ recipientName, companyName, vars, sender }),
    [recipientName, companyName, vars, sender],
  );

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
      toast.error("No phone number for this contact", { description: "Add a mobile number to the contact, then try again." });
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
      toast.error("No phone number for this contact", { description: "Add a mobile number to the contact, then try again." });
      return;
    }
    try {
      await sendApi.mutateAsync({ to: cleanPhone, text: message });
      toast.success("WhatsApp message sent via Cloud API!");
      onOpenChange(false);
    } catch (e) {
      toastError(e, { fallback: "Could not send via WhatsApp API", description: "Use the WhatsApp Web button instead, or check the WhatsApp connection in Settings." });
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
            <p id={`${fieldId}-template`} className="text-xs font-semibold leading-none text-ink-2 mb-1.5 block">Select Preset Template:</p>
            <div role="group" aria-labelledby={`${fieldId}-template`} className="flex items-center gap-1.5 flex-wrap">
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
                  aria-pressed={selectedTemplate === t.id}
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
            <Label htmlFor={`${fieldId}-message`} className="text-xs font-semibold text-ink-2 mb-1.5 block">Message Body (Editable):</Label>
            <textarea
              id={`${fieldId}-message`}
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
