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
import { ConsequenceList } from "@/components/shared/consequence-list";
import { sendQuoteConsequences } from "@/lib/quotes/send-consequences";
import { sendQuoteEmail, quoteEmailOutcome, quoteEmailErrorOutcome } from "@/lib/quotes/send-quote-email";

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
  /**
   * The quote's own figures, for the "what this will do" list above the send button.
   *
   * OPTIONAL so the two existing call sites keep working unchanged — the list simply
   * does not render without them. Deliberately not defaulted to zeroes: a
   * consequence list built from invented figures is worse than none, and "₹0 goes to
   * the customer" on a real quote would be a lie the operator might believe.
   */
  amount?:            number | null;
  subtotal?:          number | null;
  taxRate?:           number | null;
  validityDays?:      number | null;
}

export function SendQuoteDialog({
  open,
  onOpenChange,
  quoteId,
  customerName,
  defaultRecipient,
  alreadySent = false,
  amount,
  subtotal,
  taxRate,
  validityDays,
}: SendQuoteDialogProps) {
  const qc = useQueryClient();

  const {
    register,
    handleSubmit,
    reset,
    /* Read live so the consequence list judges the address the operator can SEE. Using
       defaultRecipient instead would warn about a recipient they had already
       corrected, which reads as the app being broken. */
    watch,
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
    /* R-408: the same call the builder's "Save & send quote" makes — one path. */
    mutationFn: (data: FormData) =>
      sendQuoteEmail(quoteId, { to: data.to, subject: data.subject, message: data.message }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["quotes"] });
      qc.invalidateQueries({ queryKey: ["quotes", quoteId] });
      qc.invalidateQueries({ queryKey: ["quote-send-log", quoteId] });

      const out = quoteEmailOutcome(res, { quoteId, alreadySent });
      if (out.ok) {
        toast.success(out.title, out.description ? { description: out.description } : undefined);
        onOpenChange(false);
      } else {
        // Sheet stays open so "Send now" is the retry.
        toast.error(out.title, { description: out.description });
      }
    },
    onError: (err) => {
      const out = quoteEmailErrorOutcome(err, { alreadySent });
      toast.error(out.title, { description: out.description });
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
              <div className="pt-1 text-2xs text-ink-3">
                <Badge kind="muted">Tip</Badge>{" "}
                Status flips to <b>Sent</b> on success — downstream automation (reminders, renewals) starts tracking from here.
              </div>
            )}
            {/* ── What sending actually commits you to ──────────────────────
                Only when the caller supplied the figures — a list built from
                invented numbers would be worse than none. The wording and every
                rule behind it live in lib/quotes/send-consequences.ts, unit-tested
                there; this only places it above the button. */}
            {amount !== undefined && (
              <div className="rounded-md border border-hairline/60 bg-paper-2 p-3">
                <div className="text-2xs uppercase tracking-wider text-ink-3 font-semibold mb-2">
                  What this does
                </div>
                <ConsequenceList
                  items={sendQuoteConsequences({
                    id: quoteId,
                    customerName,
                    /* The address as it stands in the form right now, not the default —
                       the operator can change it, and a warning about a recipient they
                       have already corrected reads as broken. */
                    recipientEmail: watch("to") ?? defaultRecipient ?? null,
                    amount: amount ?? null,
                    subtotal: subtotal ?? null,
                    taxRate: taxRate ?? null,
                    validityDays: validityDays ?? null,
                    alreadySent,
                  })}
                />
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
