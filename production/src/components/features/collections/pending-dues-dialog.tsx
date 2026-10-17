/**
 * R-1526 — "Send pending dues": preview the customer's Statement of pending dues (every open
 * bill, the total, one UPI QR for the total) and let a PERSON send it.
 *
 * DECISION (R-1514): nothing is sent on its own. Opening this dialog only reads the preview
 * (GET /api/customers/{id}/pending-dues). Nothing leaves until the person presses:
 *   • "Open WhatsApp" — wa.me/<customer's number>?text=<the edited text> (the text carries the
 *     total and a 7-day signed link to the statement PDF); they press send inside WhatsApp.
 *     The follow-up is logged at that moment through R-1517's POST /api/collections/followups.
 *   • "Send email" — POST /api/customers/{id}/pending-dues/email: the PDF is rendered on the
 *     server from the books, attached, sent through lib/messaging, and the follow-up logged there.
 * The next follow-up date is required (default +3 days). §24: no UPI ID → the "add UPI ID in
 * Settings" line with a Settings button; no phone / email → that button off, with how to fix it.
 *
 * The WhatsApp window opens synchronously inside the click (a popup opened after an await is
 * blocked), so validation is a direct zod parse of the form values.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import type { Route } from "next";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { FormField } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Icon } from "@/components/ui/icon";
import { istToday } from "@/lib/dates/ist";
import { rupee, formatDate } from "@/lib/utils";
import { defaultNextFollowUp, NEXT_REQUIRED, type FollowupRequest } from "@/lib/collections/followup-rules";
import { reminderNote, waMeUrl } from "@/lib/collections/reminder-draft";
import type { DuesLine, StatementQrNotice } from "@/lib/collections/pending-dues";
import { followupsKey, useAddFollowup } from "@/lib/queries/payment-followups";

export interface PendingDuesPreview {
  customerName: string;
  asOn: string;
  lines: DuesLine[];
  total: number;
  qrNotice: StatementQrNotice | null;
  hasBank: boolean;
  subject: string;
  emailText: string;
  whatsappText: string;
  whatsapp: string | null;
  whatsappBlocked: string | null;
  email: string | null;
  emailBlocked: string | null;
  about: { invoiceId: string | null; subscriptionId: string | null; quoteId: string | null };
}

class DuesError extends Error {}

async function readJson<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    throw new DuesError("Could not reach the server — check your internet and try again.");
  }
  const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  if (!res.ok || !json.ok) throw new DuesError(json.error || "Something went wrong — try again.");
  return json as T;
}

export const pendingDuesUrl = (customerId: string) => `/api/customers/${encodeURIComponent(customerId)}/pending-dues`;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const formSchema = z.object({
  channel: z.enum(["whatsapp", "email"]),
  subject: z.string().trim().max(300, "Keep the subject under 300 characters."),
  whatsappText: z.string().trim().max(4000, "Keep the message under 4,000 characters."),
  emailText: z.string().trim().max(4000, "Keep the message under 4,000 characters."),
  nextFollowUpOn: z.string().regex(ISO_DATE, NEXT_REQUIRED),
});
type FormValues = z.infer<typeof formSchema>;

export interface PendingDuesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  customerId: string;
  customerName: string;
}

export function PendingDuesDialog({ open, onOpenChange, customerId, customerName }: PendingDuesDialogProps) {
  const qc = useQueryClient();
  const preview = useQuery({
    queryKey: ["pending-dues", customerId],
    enabled: open,
    queryFn: () => readJson<PendingDuesPreview>(pendingDuesUrl(customerId)),
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const addFollowup = useAddFollowup();
  const [problem, setProblem] = React.useState<string | null>(null);
  const [unlogged, setUnlogged] = React.useState<FollowupRequest | null>(null);

  const form = useForm<FormValues>({
    defaultValues: { channel: "whatsapp", subject: "", whatsappText: "", emailText: "", nextFollowUpOn: defaultNextFollowUp(istToday()) },
  });
  const { register, reset, getValues, setValue, watch, setError, clearErrors, formState: { errors } } = form;
  const channel = watch("channel");

  const filledFrom = React.useRef<number>(0);
  React.useEffect(() => {
    if (!open) { filledFrom.current = 0; setProblem(null); setUnlogged(null); return; }
    const d = preview.data;
    if (d && preview.dataUpdatedAt !== filledFrom.current) {
      filledFrom.current = preview.dataUpdatedAt;
      reset({
        channel: d.whatsapp || !d.email ? "whatsapp" : "email",
        subject: d.subject,
        whatsappText: d.whatsappText,
        emailText: d.emailText,
        nextFollowUpOn: defaultNextFollowUp(istToday()),
      });
    }
  }, [open, preview.data, preview.dataUpdatedAt, reset]);

  const sendEmail = useMutation({
    mutationFn: (body: { subject: string; message: string; nextFollowUpOn: string }) =>
      readJson<{ sentTo: string; logged: boolean; warning?: string }>(`${pendingDuesUrl(customerId)}/email`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      }),
    onSuccess: (out) => {
      void qc.invalidateQueries({ queryKey: ["collections"] });
      void qc.invalidateQueries({ queryKey: followupsKey(customerId) });
      if (out.logged) {
        toast.success(`Statement emailed to ${out.sentTo}`, { description: "PDF attached. Follow-up logged." });
        onOpenChange(false);
      } else {
        setProblem(out.warning ?? `The statement went to ${out.sentTo}, but the follow-up was not logged — log it with Follow-up.`);
      }
    },
    onError: (e) => setProblem(e instanceof Error ? e.message : "The email was not sent — try again."),
  });

  const validate = (): FormValues | null => {
    clearErrors();
    setProblem(null);
    const parsed = formSchema.safeParse(getValues());
    if (!parsed.success) {
      for (const i of parsed.error.issues) setError(i.path[0] as keyof FormValues, { message: i.message });
      return null;
    }
    const v = parsed.data;
    const text = v.channel === "email" ? v.emailText : v.whatsappText;
    if (!text) {
      setError(v.channel === "email" ? "emailText" : "whatsappText", { message: "The message is empty — write a short note first." });
      return null;
    }
    if (v.channel === "email" && !v.subject) {
      setError("subject", { message: "Write a subject for the email." });
      return null;
    }
    return v;
  };

  const d = preview.data;
  const logWhatsapp = (body: FollowupRequest) => {
    setUnlogged(null);
    addFollowup.mutate(body, {
      onSuccess: () => onOpenChange(false),
      onError: (e) => {
        setUnlogged(body);
        setProblem(`WhatsApp opened, but the follow-up was not logged: ${e instanceof Error ? e.message : "try again"}`);
      },
    });
  };

  const onWhatsapp = () => {
    if (!d?.whatsapp) return;
    const v = validate();
    if (!v) return;
    window.open(waMeUrl(d.whatsapp, v.whatsappText), "_blank", "noopener,noreferrer");
    logWhatsapp({
      customerId,
      kind: "whatsapp",
      note: reminderNote(v.whatsappText),
      nextFollowUpOn: v.nextFollowUpOn,
      invoiceId: d.about.invoiceId ?? undefined,
      quoteId: d.about.quoteId ?? undefined,
      subscriptionId: d.about.subscriptionId ?? undefined,
    });
  };

  const onEmail = () => {
    if (!d?.email) return;
    const v = validate();
    if (!v) return;
    sendEmail.mutate({ subject: v.subject, message: v.emailText, nextFollowUpOn: v.nextFollowUpOn });
  };

  const busy = addFollowup.isPending || sendEmail.isPending;
  const nothingDue = !!d && d.total <= 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="md:!max-w-2xl">
        <DialogHeader>
          <DialogTitle>Send pending dues · {customerName}</DialogTitle>
          <DialogDescription>
            One statement with every open bill, the total and one pay QR. Nothing is sent until you press WhatsApp or Send email.
          </DialogDescription>
        </DialogHeader>

        {preview.isLoading ? (
          <div className="space-y-3" aria-busy="true" aria-label="Reading this customer's bills">
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-32 w-full" />
          </div>
        ) : preview.isError || !d ? (
          <div role="alert" className="rounded-md border border-rose/40 bg-rose/5 px-3 py-3 text-sm">
            <p className="text-ink"><b>Could not read the statement.</b> {preview.error instanceof Error ? preview.error.message : "Try again."}</p>
            <Button type="button" size="sm" variant="default" icon="refresh" className="mt-2" onClick={() => { void preview.refetch(); }}>
              Try again
            </Button>
          </div>
        ) : nothingDue ? (
          <p className="text-sm text-ink-2">This customer owes nothing right now — there is no statement to send.</p>
        ) : (
          <form className="space-y-4" noValidate onSubmit={(e) => e.preventDefault()}>
            <div className="rounded-md border border-hairline">
              <ul className="divide-y divide-hairline max-h-48 overflow-y-auto text-sm" aria-label="Open bills on the statement">
                {d.lines.map((l) => (
                  <li key={`${l.kind}:${l.id}`} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-3 py-2">
                    <span className="min-w-0 flex-1 break-all">
                      <span className="text-3xs uppercase tracking-wider text-ink-3 mr-2">{l.kind === "invoice" ? "Invoice" : "Subscription"}</span>
                      <span className="font-mono text-xs">{l.label}</span>
                    </span>
                    <span className="text-xs text-ink-3">
                      {l.dueDate ? `Due ${formatDate(l.dueDate)}` : ""}
                      {l.daysOverdue > 0 && <span className="text-rose"> · {l.daysOverdue}d overdue</span>}
                    </span>
                    <span className="font-mono text-xs tabular-nums text-ink">{rupee(l.amountDue)}</span>
                  </li>
                ))}
              </ul>
              <div className="flex flex-wrap items-center gap-2 border-t border-hairline px-3 py-2">
                <span className="text-sm text-ink-2">{d.lines.length} {d.lines.length === 1 ? "bill" : "bills"} · Total due</span>
                <b className="font-mono tabular-nums text-ink">{rupee(d.total)}</b>
                <a
                  href={`${pendingDuesUrl(customerId)}/pdf`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="ml-auto inline-flex items-center gap-1 min-h-[44px] md:min-h-0 text-sm text-ink underline underline-offset-2"
                >
                  <Icon name="file" size={14} /> Open statement PDF
                </a>
              </div>
            </div>

            {d.qrNotice && (
              <div role="note" className="flex flex-wrap items-center gap-2 rounded-md border border-amber/40 bg-amber-soft px-3 py-2 text-sm text-ink">
                <Icon name="info" size={16} className="shrink-0" />
                <span className="flex-1 min-w-0">{d.qrNotice.text}</span>
                {d.qrNotice.action && (
                  <Link href={d.qrNotice.action.href as Route} className="inline-flex items-center min-h-[44px] md:min-h-0 rounded-full border border-hairline bg-paper px-3 py-1 text-sm hover:border-amber/60">
                    {d.qrNotice.action.label}
                  </Link>
                )}
              </div>
            )}
            {!d.hasBank && (
              <p className="text-xs text-ink-3">No bank account in Settings — the statement shows the bills and total without bank details.</p>
            )}

            <div className="flex flex-wrap gap-2" role="group" aria-label="Send by">
              {(["whatsapp", "email"] as const).map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-pressed={channel === c}
                  onClick={() => setValue("channel", c)}
                  className={`min-h-[44px] md:min-h-0 px-3 py-1.5 rounded-full border text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber ${
                    channel === c ? "border-amber bg-amber-soft text-ink" : "border-hairline bg-paper text-ink-2 hover:border-amber/60"
                  }`}
                >
                  {c === "whatsapp" ? "WhatsApp" : "Email (PDF attached)"}
                </button>
              ))}
            </div>

            {channel === "email" && (
              <FormField label="Email subject" required htmlFor="pd-subject">
                <Input id="pd-subject" error={errors.subject?.message} {...register("subject")} />
              </FormField>
            )}
            {channel === "email" ? (
              <FormField label="Message" required htmlFor="pd-email-text">
                <Textarea id="pd-email-text" rows={9} {...register("emailText")} />
              </FormField>
            ) : (
              <FormField label="Message" required htmlFor="pd-wa-text">
                <Textarea id="pd-wa-text" rows={9} {...register("whatsappText")} />
              </FormField>
            )}
            {(channel === "email" ? errors.emailText?.message : errors.whatsappText?.message) && (
              <p className="-mt-3 text-xs text-rose">{channel === "email" ? errors.emailText?.message : errors.whatsappText?.message}</p>
            )}

            <FormField label="Next follow-up" required htmlFor="pd-next">
              <Input id="pd-next" type="date" min={istToday()} error={errors.nextFollowUpOn?.message} {...register("nextFollowUpOn")} />
            </FormField>

            {problem && (
              <div role="alert" className="flex flex-wrap items-start gap-2 rounded-md border border-rose/40 bg-rose/5 px-3 py-2 text-sm">
                <Icon name="alert" size={16} className="mt-0.5 shrink-0 text-rose" />
                <span className="flex-1 min-w-0 text-ink">{problem}</span>
                {unlogged && (
                  <Button type="button" size="sm" variant="ghost" loading={addFollowup.isPending} onClick={() => logWhatsapp(unlogged)}>
                    Log it again
                  </Button>
                )}
              </div>
            )}

            {channel === "whatsapp" ? (
              <div>
                <Button
                  type="button" variant="primary" icon="message" className="w-full justify-center"
                  disabled={!d.whatsapp || busy}
                  aria-describedby={d.whatsappBlocked ? "pd-wa-why" : undefined}
                  onClick={onWhatsapp}
                >
                  Open WhatsApp
                </Button>
                {d.whatsappBlocked
                  ? <p id="pd-wa-why" className="mt-1 text-xs text-ink-3">{d.whatsappBlocked}</p>
                  : <p className="mt-1 text-xs text-ink-3">Opens WhatsApp with this text for +{d.whatsapp} — press send there. Logged as a follow-up.</p>}
              </div>
            ) : (
              <div>
                <Button
                  type="button" variant="primary" icon="mail" className="w-full justify-center"
                  disabled={!d.email || busy} loading={sendEmail.isPending}
                  aria-describedby={d.emailBlocked ? "pd-em-why" : undefined}
                  onClick={onEmail}
                >
                  Send email
                </Button>
                {d.emailBlocked
                  ? <p id="pd-em-why" className="mt-1 text-xs text-ink-3">{d.emailBlocked}</p>
                  : <p className="mt-1 text-xs text-ink-3 break-all">To {d.email}, statement PDF attached. Logged as a follow-up once it is sent.</p>}
              </div>
            )}
          </form>
        )}

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
