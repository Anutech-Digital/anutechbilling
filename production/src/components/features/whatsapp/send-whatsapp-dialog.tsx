/**
 * SendWhatsAppDialog — quick "Send via WhatsApp" composer.
 *
 * Lifted into a shared component so quote detail, invoice detail, lead
 * drawer, customer page can all drop it in with the appropriate context.
 *
 * - Pre-fills the recipient phone + an opening line composed by the host
 * - On send, optionally links the message to a lead/quote/customer for
 *   the Inbox thread view
 */

"use client";

import * as React from "react";
import { toast } from "sonner";
import { Sheet, SheetContent, SheetFooter } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Icon } from "@/components/ui/icon";
import { useSendWhatsApp } from "@/lib/queries/whatsapp";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** Pre-fill the recipient phone. E.164 or local — auto-normalised server-side. */
  defaultTo?:    string;
  /** Pre-fill the message body. */
  defaultText?:  string;
  /** Optional context links — surfaces the message in the right place
   *  on the Inbox / lead drawer later. */
  related?: {
    leadId?:     string;
    quoteId?:    string;
    customerId?: string;
  };
  /** Optional title override — defaults to "Send via WhatsApp". */
  title?: string;
  /** When provided, an "Attach quote PDF" checkbox shows (defaults to
   *  checked). Selected at send time → server renders the quote PDF,
   *  uploads it to Meta, and sends as document with the text becoming
   *  the caption. */
  attachQuoteId?: string;
  /** Filename hint shown next to the checkbox. */
  attachQuoteLabel?: string;
  /** Optional click handler — when set, clicking the body of the
   *  attachment card (anywhere except the checkbox) calls this so the
   *  host can preview the actual PDF before sending. */
  onPreviewAttachment?: () => void | Promise<void>;
}

export default function SendWhatsAppDialog({
  open, onOpenChange, defaultTo = "", defaultText = "", related, title,
  attachQuoteId, attachQuoteLabel, onPreviewAttachment,
}: Props) {
  const [to,        setTo]        = React.useState(defaultTo);
  const [text,      setText]      = React.useState(defaultText);
  // Attach defaults to TRUE when an attachQuoteId is supplied — that's
  // typically why the caller opened this dialog. User can untick.
  const [attachOn,   setAttachOn]   = React.useState<boolean>(Boolean(attachQuoteId));
  const [previewing, setPreviewing] = React.useState(false);
  const send = useSendWhatsApp();

  // Sync defaults when re-opened
  React.useEffect(() => {
    if (open) {
      setTo(defaultTo);
      setText(defaultText);
      setAttachOn(Boolean(attachQuoteId));
    }
  }, [open, defaultTo, defaultText, attachQuoteId]);

  async function onSubmit() {
    if (!to.trim() || !text.trim()) {
      toast.error("Recipient + message required");
      return;
    }
    try {
      await send.mutateAsync({
        to:   to.trim(),
        text: text.trim(),
        attach_quote_id: attachOn && attachQuoteId ? attachQuoteId : undefined,
        related,
      });
      onOpenChange(false);
    } catch {
      // toast handled in hook
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-[480px] md:max-w-[520px] p-0 flex flex-col overflow-x-hidden"
      >
        <header className="border-b border-hairline px-5 pt-5 pb-3 flex-shrink-0">
          <p className="text-[10px] uppercase tracking-wider font-semibold text-emerald mb-1 inline-flex items-center gap-1.5">
            <Icon name="whatsapp" size={11} /> WhatsApp · Cloud API
          </p>
          <h2 className="font-serif text-xl text-ink">{title ?? "Send via WhatsApp"}</h2>
          <p className="text-xs text-ink-3 mt-1">
            Sent through your configured Meta Cloud API number. Text only works inside 24-hour customer service window.
          </p>
        </header>

        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-3">
          <div>
            <Label>To (E.164)</Label>
            <Input
              className="font-mono"
              placeholder="e.g. +91 98765 43210"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
            <p className="text-[10px] text-ink-3 mt-1">
              Include country code. Spaces and the leading + are stripped server-side.
            </p>
          </div>
          <div>
            <Label>Message{attachQuoteId && attachOn ? " (becomes the PDF caption)" : ""}</Label>
            <textarea
              rows={5}
              placeholder="Hi, this is regarding your quote …"
              className="w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-amber resize-none"
              value={text}
              onChange={(e) => setText(e.target.value)}
              maxLength={4096}
            />
            <p className="text-[10px] text-ink-3 mt-1">
              {text.length} / 4096 chars
            </p>
          </div>

          {/* Attach PDF — only shown when host supplied an attachQuoteId.
              Card has TWO independent click targets:
                - Checkbox (left)    → toggles attach on/off
                - Body (right)       → opens PDF preview in a new tab via
                                       onPreviewAttachment (when provided) */}
          {attachQuoteId && (
            <div className="flex items-start gap-2 rounded-md border border-hairline bg-paper-2/40 p-3">
              {/* Checkbox — own click area, doesn't trigger preview */}
              <label className="flex shrink-0 items-center pt-0.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={attachOn}
                  onChange={(e) => setAttachOn(e.target.checked)}
                  className="h-4 w-4 accent-amber"
                  aria-label="Attach quote PDF"
                />
              </label>

              {/* Body — click to preview (when host wired a handler).
                  Falls back to a non-interactive label if no preview is
                  available. */}
              {onPreviewAttachment ? (
                <button
                  type="button"
                  onClick={async () => {
                    if (previewing) return;
                    setPreviewing(true);
                    try { await onPreviewAttachment(); }
                    catch (e) { toast.error(e instanceof Error ? e.message : "Could not open preview"); }
                    finally { setPreviewing(false); }
                  }}
                  className="min-w-0 flex-1 text-left group focus:outline-none"
                  title="Click to preview the PDF in a new tab"
                  disabled={previewing}
                >
                  <p className="text-sm font-medium text-ink inline-flex items-center gap-1.5 group-hover:text-amber-ink">
                    <Icon name="file" size={13} />
                    Attach quote PDF
                    <span className="text-[10px] text-ink-3 group-hover:text-amber-ink inline-flex items-center gap-0.5 ml-1">
                      <Icon name={previewing ? "refresh" : "eye"} size={10} />
                      {previewing ? "Loading…" : "Preview"}
                    </span>
                  </p>
                  <p className="text-[11px] text-ink-3 mt-0.5">
                    {attachQuoteLabel ?? `Quote-${attachQuoteId}.pdf`} — click to review · text above becomes the caption when sent.
                  </p>
                </button>
              ) : (
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-ink inline-flex items-center gap-1.5">
                    <Icon name="file" size={13} />
                    Attach quote PDF
                  </p>
                  <p className="text-[11px] text-ink-3 mt-0.5">
                    {attachQuoteLabel ?? `Quote-${attachQuoteId}.pdf`} — rendered server-side and uploaded to Meta. Text above becomes the caption.
                  </p>
                </div>
              )}
            </div>
          )}
        </div>

        <SheetFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={send.isPending}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="primary"
            icon="send"
            onClick={onSubmit}
            loading={send.isPending}
            disabled={!to.trim() || !text.trim()}
          >
            Send
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
