/**
 * AiDraftButton — one-click "✨ AI draft" for a follow-up / reminder / renewal
 * message to a lead or customer. Calls /api/ai/draft-followup (Gemini, with a
 * deterministic stub fallback), shows the draft EDITABLE, and lets the operator
 * copy it or open WhatsApp. ZERO auto-send + zero money-write — human-in-the-loop
 * always: the draft never leaves until the operator sends it themselves.
 */
"use client";

import * as React from "react";
import { toast } from "sonner";

import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Icon } from "@/components/ui/icon";

type Channel = "whatsapp" | "email";
type Purpose = "followup" | "reminder" | "renewal";

interface Props {
  /** Exactly one of leadId / customerId. */
  leadId?: string;
  customerId?: string;
  channel?: Channel;
  purpose?: Purpose;
  /** Button label. */
  label?: string;
  /** Optional E.164-ish phone (digits) — enables an "Open WhatsApp" shortcut. */
  phone?: string | null;
  size?: "sm" | "md";
  variant?: "outline" | "ghost" | "primary";
  /** Extra classes for the trigger button (e.g. "w-full" in a drawer). */
  className?: string;
}

export function AiDraftButton({
  leadId, customerId, channel = "whatsapp", purpose = "followup",
  label = "✨ AI draft", phone, size = "sm", variant = "outline", className,
}: Props) {
  const [open, setOpen] = React.useState(false);
  const [drafting, setDrafting] = React.useState(false);
  const [subject, setSubject] = React.useState("");
  const [message, setMessage] = React.useState("");
  const [mode, setMode] = React.useState<string>("");
  const fieldId = React.useId();

  async function generate() {
    setDrafting(true);
    try {
      const res = await fetch("/api/ai/draft-followup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ leadId, customerId, channel, purpose }),
      });
      const data = await res.json();
      if (!res.ok) { toast.error(data.error ?? "Couldn't draft.", { description: "Try again, or write the message yourself." }); return; }
      setSubject(data.subject ?? "");
      setMessage(data.message ?? "");
      setMode(data.mode ?? "stub");
    } catch {
      toast.error("Couldn't reach the AI service.", { description: "Check your connection and try again, or write the message yourself." });
    } finally {
      setDrafting(false);
    }
  }

  function openAndDraft() {
    setOpen(true);
    setSubject(""); setMessage(""); setMode("");
    void generate();
  }

  async function copy() {
    const text = channel === "email" && subject ? `Subject: ${subject}\n\n${message}` : message;
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Copied — paste it into WhatsApp / email");
    } catch {
      toast.error("Couldn't copy.", { description: "Your browser blocked the clipboard. Select the text and copy it by hand." });
    }
  }

  const waDigits = (phone ?? "").replace(/\D/g, "");
  const waHref = waDigits
    ? `https://wa.me/${waDigits.length === 10 ? "91" + waDigits : waDigits}?text=${encodeURIComponent(message)}`
    : `https://wa.me/?text=${encodeURIComponent(message)}`;

  return (
    <>
      <Button size={size} variant={variant} className={className} onClick={openAndDraft}>{label}</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="md:!max-w-md">
          <DialogHeader>
            <DialogTitle>AI-drafted {purpose === "renewal" ? "renewal nudge" : purpose === "reminder" ? "payment reminder" : "message"}</DialogTitle>
            <DialogDescription>
              Review and edit before sending — nothing is sent automatically.
              {mode === "stub" && " (AI key not set — using a standard template. Add a Gemini key in Settings → Integrations for smarter drafts.)"}
            </DialogDescription>
          </DialogHeader>

          {drafting ? (
            <div className="py-8 text-center text-sm text-ink-3">
              <Icon name="sparkles" size={18} className="mx-auto mb-2 text-amber" />
              Drafting…
            </div>
          ) : (
            <div className="space-y-3">
              {channel === "email" && (
                <div>
                  <label htmlFor={`${fieldId}-subject`} className="block text-xs font-medium text-ink-2 mb-1">Subject</label>
                  <Input id={`${fieldId}-subject`} value={subject} onChange={(e) => setSubject(e.target.value)} />
                </div>
              )}
              <div>
                <label htmlFor={`${fieldId}-message`} className="block text-xs font-medium text-ink-2 mb-1">Message</label>
                <Textarea id={`${fieldId}-message`} rows={6} value={message} onChange={(e) => setMessage(e.target.value)} />
              </div>
            </div>
          )}

          <DialogFooter>
            <Button variant="ghost" onClick={() => void generate()} disabled={drafting} icon="refresh">Re-draft</Button>
            <Button variant="outline" onClick={copy} disabled={drafting || !message} icon="copy">Copy</Button>
            {channel === "whatsapp" && (
              <Button
                variant="primary"
                disabled={drafting || !message}
                icon="whatsapp"
                onClick={() => window.open(waHref, "_blank", "noopener,noreferrer")}
              >
                Open WhatsApp
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
