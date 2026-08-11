/**
 * SendQuoteDialog — email the quote PDF to the customer.
 *
 * Replaces the legacy mailto: handler. POSTs to /api/quotes/[id]/send,
 * which server-renders the PDF, attaches it, and sends via the
 * lib/email/send.ts seam (stub mode when RESEND_API_KEY is absent).
 *
 * Defaults:
 *   - Recipient: customer.contact_email
 *   - Subject:   set server-side from a sane template
 *   - Message:   set server-side from a sane template
 * Operator can override any of the three before sending.
 */
"use client";

import * as React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { FormField } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Badge } from "@/components/ui/badge";

const schema = z.object({
  to:      z.string().email("Invalid email"),
  subject: z.string().max(200).optional(),
  message: z.string().max(4000).optional(),
});
type FormData = z.infer<typeof schema>;

interface SendQuoteDialogProps {
  open:               boolean;
  onOpenChange:       (open: boolean) => void;
  quoteId:            string;
  customerName:       string;
  /** Pre-fill recipient. Comes from customers.contact_email when available. */
  defaultRecipient?:  string | null;
  /** Toggle button label and toast copy. */
  alreadySent?:       boolean;
}

export function SendQuoteDialog({
  open,
  onOpenChange,
  quoteId,
  customerName,
  defaultRecipient,
  alreadySent = false,
}: SendQuoteDialogProps) {
  const qc = useQueryClient();

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: {
      to:      defaultRecipient ?? "",
      subject: "",
      message: "",
    },
  });

  React.useEffect(() => {
    if (!open) {
      reset({ to: "", subject: "", message: "" });
    } else {
      reset({
        to:      defaultRecipient ?? "",
        subject: "",
        message: "",
      });
    }
  }, [open, defaultRecipient, reset]);

  const sendQuote = useMutation({
    mutationFn: async (data: FormData) => {
      const res = await fetch(`/api/quotes/${quoteId}/send`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          to:      data.to.trim(),
          subject: data.subject?.trim() || undefined,
          message: data.message?.trim() || undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error ?? "Send failed");
      }
      return json as {
        status:       "sent" | "stubbed" | "failed";
        email_mode:   "real" | "stub";
        providerId:   string | null;
        errorMessage: string | null;
        recipient:    string;
        attachedPdf:  boolean;
        quoteStatus:  string;
      };
    },
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["quotes"] });
      qc.invalidateQueries({ queryKey: ["quotes", quoteId] });
      qc.invalidateQueries({ queryKey: ["quote-send-log", quoteId] });

      if (res.status === "sent") {
        toast.success(
          `${alreadySent ? "Resent" : "Sent"} quote ${quoteId} to ${res.recipient}` +
          (res.attachedPdf ? " · PDF attached" : "")
        );
      } else if (res.status === "stubbed") {
        toast.success(
          `Logged ${quoteId} (stub mode — no real email sent yet)`,
          { description: "Add RESEND_API_KEY to .env.local to flip on real delivery." }
        );
      } else {
        toast.error(`Send failed: ${res.errorMessage ?? "unknown error"}`);
      }
      if (res.status !== "failed") {
        onOpenChange(false);
      }
    },
    onError: (err) => {
      toast.error((err as Error).message);
    },
  });

  const onSubmit = (data: FormData) => sendQuote.mutate(data);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-[480px] md:max-w-[520px] p-0 flex flex-col overflow-x-hidden"
      >
        <SheetHeader>
          <SheetTitle>
            {alreadySent ? "Resend" : "Send"} quote {quoteId}
          </SheetTitle>
          <SheetDescription>
            Email a copy of the quote PDF to {customerName}. The customer-facing accept link is included automatically.
          </SheetDescription>
        </SheetHeader>

        <form
          onSubmit={handleSubmit(onSubmit)}
          className="flex flex-col flex-1 min-h-0 min-w-0 w-full"
        >
          <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-4">
          <FormField label="To" required htmlFor="send-to">
            <Input
              id="send-to"
              type="email"
              className="font-mono"
              placeholder="e.g. customer@example.com"
              error={errors.to?.message}
              autoFocus
              {...register("to")}
            />
          </FormField>

          <FormField label="Subject (optional)" htmlFor="send-subject">
            <Input
              id="send-subject"
              placeholder={`Quotation ${quoteId} from your reseller`}
              error={errors.subject?.message}
              {...register("subject")}
            />
          </FormField>

          <FormField label="Message (optional)" htmlFor="send-message">
            <Textarea
              id="send-message"
              rows={6}
              placeholder="A default cover note will be used if you leave this blank — including total, validity, and the accept link."
              {...register("message")}
            />
            {errors.message && (
              <p className="mt-1 text-xs text-rose">{errors.message.message}</p>
            )}
          </FormField>

          <div className="flex items-center gap-2 rounded-md border border-hairline bg-paper-2/40 px-3 py-2 text-xs text-ink-3">
            <Icon name="link" size={14} className="shrink-0" />
            <span>
              The current quote PDF is attached automatically. The customer can also review and accept online via the included link.
            </span>
          </div>

            {!alreadySent && (
              <div className="pt-1 text-[11px] text-ink-3">
                <Badge kind="muted">Tip</Badge>{" "}
                Status flips to <b>Sent</b> on success — downstream automation (reminders, renewals) starts tracking from here.
              </div>
            )}
          </div>  {/* close scrollable form body */}

          <SheetFooter className="gap-2 sm:gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              icon="send"
              loading={isSubmitting || sendQuote.isPending}
            >
              {alreadySent ? "Resend now" : "Send now"}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}
