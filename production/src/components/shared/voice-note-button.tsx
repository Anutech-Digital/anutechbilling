/**
 * VoiceNoteButton — Phase 0 voice agent. One click sends a Hindi TTS reminder to
 * a customer as a WhatsApp voice note (via /api/voice/whatsapp-note). Confirms
 * first (it sends a real message). Degrades with a clear toast when TTS or the
 * WhatsApp Business API isn't configured yet.
 *
 * R-1452: looks up the customer's phone BEFORE confirming. No phone → a §24 toast
 * ("No phone number for this customer — add one" + "Open customer") and no send.
 */
"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/providers/confirm-provider";
import { createClient } from "@/lib/supabase/client";
import { hasPhone, noPhoneNotice, NO_PHONE_CODE } from "@/lib/voice/voice-note-phone";

interface Props {
  customerId: string;
  purpose?: "reminder" | "renewal";
  label?: string;
  customerName?: string;
  size?: "sm" | "md";
  variant?: "outline" | "ghost" | "primary";
}

export function VoiceNoteButton({
  customerId, purpose = "reminder", label = "🔊 Voice note", customerName, size = "sm", variant = "ghost",
}: Props) {
  const [sending, setSending] = React.useState(false);
  const confirm = useConfirm();
  const router = useRouter();

  function showNoPhone() {
    const n = noPhoneNotice(customerId, customerName);
    toast.error(n.error, {
      description: n.description,
      action: { label: n.actionLabel, onClick: () => router.push(n.href as never) },
    });
  }

  async function send() {
    // R-1452: check for a phone first — never fire the send for a customer without one.
    // If the lookup itself fails, fall through: the route answers no_phone the same way.
    setSending(true);
    try {
      const { data, error } = await createClient()
        .from("customers").select("contact_phone").eq("id", customerId).maybeSingle();
      if (!error && data && !hasPhone(data.contact_phone)) { showNoPhone(); return; }
    } catch {
      /* lookup failed — the route still guards */
    } finally {
      setSending(false);
    }

    if (!(await confirm({
      title: `Send a Hindi voice-note ${purpose} to ${customerName ?? "this customer"} on WhatsApp?`,
      confirmLabel: "Send",
      icon: "whatsapp",
    }))) return;
    setSending(true);
    try {
      const res = await fetch("/api/voice/whatsapp-note", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ customerId, purpose }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (data?.code === NO_PHONE_CODE) { showNoPhone(); return; }
        toast.error(data.error ?? "Couldn't send the voice note.");
        return;
      }
      toast.success("Voice note sent on WhatsApp ✓");
    } catch {
      toast.error("Couldn't reach the voice service.");
    } finally {
      setSending(false);
    }
  }

  return (
    <Button size={size} variant={variant} loading={sending} onClick={send}>{label}</Button>
  );
}
