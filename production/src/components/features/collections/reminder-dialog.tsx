/**
 * R-1518 — "Remind": the AI drafts a payment reminder, a PERSON reads it, edits it and sends it.
 *
 * DECISION (Pardeep, 17 Oct, R-1514): no automatic messages. Opening this dialog only drafts
 * (POST /api/collections/reminder/draft). Nothing leaves until the person presses:
 *   • "Open WhatsApp" — opens wa.me/<customer's number>?text=<the edited text> in a new tab;
 *     the person presses send inside WhatsApp. The follow-up is logged at the same moment
 *     through R-1517's POST /api/collections/followups (kind whatsapp).
 *   • "Send email" — POST /api/collections/reminder/email: lib/messaging → the customer's billing
 *     email, then the follow-up is logged on the server (kind email).
 * Either way the note is the message's first line and the next follow-up date is required
 * (default +3 days). A missing phone / email disables that button and says how to fix it (§24).
 *
 * The window opens synchronously inside the click (a popup opened after an await is blocked),
 * so validation here is a direct zod parse of the form values rather than handleSubmit.
 */
"use client";

import * as React from "react";
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
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Icon } from "@/components/ui/icon";
import { istToday } from "@/lib/dates/ist";
import { rupee } from "@/lib/utils";
import { defaultNextFollowUp, NEXT_REQUIRED, type FollowupRequest } from "@/lib/collections/followup-rules";
import { reminderNote, waMeUrl } from "@/lib/collections/reminder-draft";
import { followupsKey, useAddFollowup } from "@/lib/queries/payment-followups";

export interface ReminderDraftResponse {
  subject: string;
  message: string;
  mode: "gemini" | "template";
  note: string | null;
  amountDue: number;
  whatsapp: string | null;
  whatsappBlocked: string | null;
  email: string | null;
  emailBlocked: string | null;
  about: { invoiceId: string | null; subscriptionId: string | null; quoteId: string | null };
}

class ReminderError extends Error {}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    throw new ReminderError("Could not reach the server — check your internet and try again.");
  }
  const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  if (!res.ok || !json.ok) throw new ReminderError(json.error || "Something went wrong — try again.");
  return json as T;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const formSchema = z.object({
  subject: z.string().trim().max(300, "Keep the subject under 300 characters."),
  message: z.string().trim().min(1, "The message is empty — write the reminder first.").max(4000, "Keep the message under 4,000 characters."),
  nextFollowUpOn: z.string().regex(ISO_DATE, NEXT_REQUIRED),
});
type FormValues = z.infer<typeof formSchema>;

export interface ReminderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  customerId: string;
  customerName: string;
}

export function ReminderDialog({ open, onOpenChange, customerId, customerName }: ReminderDialogProps) {
  const qc = useQueryClient();
  const draft = useQuery({
    queryKey: ["reminder-draft", customerId],
    enabled: open,
    queryFn: () => postJson<ReminderDraftResponse>("/api/collections/reminder/draft", { customerId }),
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const addFollowup = useAddFollowup();
  const [problem, setProblem] = React.useState<string | null>(null);
  /* WhatsApp opened but the log failed — offer to log again WITHOUT opening WhatsApp twice. */
  const [unlogged, setUnlogged] = React.useState<FollowupRequest | null>(null);

  const form = useForm<FormValues>({
    defaultValues: { subject: "", message: "", nextFollowUpOn: defaultNextFollowUp(istToday()) },
  });
  const { register, reset, getValues, setError, clearErrors, formState: { errors } } = form;

  // Fill the form once per draft (a redraft replaces it; typing is never overwritten otherwise).
  const filledFrom = React.useRef<number>(0);
  // R-1544: one id per opening of the dialog — a retry after a timeout sends the SAME id, so the
  // server answers "already sent" instead of mailing the customer twice.
  const [requestId, setRequestId] = React.useState(() => crypto.randomUUID());
  React.useEffect(() => {
    if (!open) { filledFrom.current = 0; setProblem(null); setUnlogged(null); setRequestId(crypto.randomUUID()); return; }
    if (draft.data && draft.dataUpdatedAt !== filledFrom.current) {
      filledFrom.current = draft.dataUpdatedAt;
      reset({ subject: draft.data.subject, message: draft.data.message, nextFollowUpOn: defaultNextFollowUp(istToday()) });
    }
  }, [open, draft.data, draft.dataUpdatedAt, reset]);

  const sendEmail = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      postJson<{ sentTo: string; logged: boolean; warning?: string; alreadySent?: boolean }>("/api/collections/reminder/email", body),
    onSuccess: (out) => {
      void qc.invalidateQueries({ queryKey: ["collections"] });
      void qc.invalidateQueries({ queryKey: followupsKey(customerId) });
      if (out.alreadySent) {
        toast.success(`Reminder already went to ${out.sentTo}`, { description: "It was not sent again." });
        onOpenChange(false);
      } else if (out.logged) {
        toast.success(`Reminder emailed to ${out.sentTo}`, { description: "Follow-up logged." });
        onOpenChange(false);
      } else {
        setProblem(out.warning ?? `The email went to ${out.sentTo}, but the follow-up was not logged — log it with Follow-up.`);
      }
    },
    onError: (e) => setProblem(e instanceof Error ? e.message : "The email was not sent — try again."),
  });

  /** zod on the current values; puts each message under its field. */
  const validate = (needSubject: boolean): FormValues | null => {
    clearErrors();
    setProblem(null);
    const parsed = formSchema.safeParse(getValues());
    let ok = parsed.success;
    if (!parsed.success) {
      for (const i of parsed.error.issues) setError(i.path[0] as keyof FormValues, { message: i.message });
    }
    if (needSubject && !getValues("subject").trim()) {
      setError("subject", { message: "Write a subject for the email." });
      ok = false;
    }
    return ok && parsed.success ? parsed.data : null;
  };

  const about = draft.data?.about;
  const followupBody = (kind: "whatsapp" | "email", v: FormValues): FollowupRequest => ({
    customerId,
    kind,
    note: reminderNote(v.message),
    nextFollowUpOn: v.nextFollowUpOn,
    invoiceId: about?.invoiceId ?? undefined,
    quoteId: about?.quoteId ?? undefined,
    subscriptionId: about?.subscriptionId ?? undefined,
  });

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
    const number = draft.data?.whatsapp;
    if (!number) return;
    const v = validate(false);
    if (!v) return;
    window.open(waMeUrl(number, v.message), "_blank", "noopener,noreferrer");
    logWhatsapp(followupBody("whatsapp", v));
  };

  const onEmail = () => {
    if (!draft.data?.email) return;
    const v = validate(true);
    if (!v) return;
    sendEmail.mutate({
      customerId,
      subject: v.subject,
      message: v.message,
      nextFollowUpOn: v.nextFollowUpOn,
      invoiceId: about?.invoiceId ?? undefined,
      quoteId: about?.quoteId ?? undefined,
      subscriptionId: about?.subscriptionId ?? undefined,
      requestId,
    });
  };

  const d = draft.data;
  const busy = addFollowup.isPending || sendEmail.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="md:!max-w-2xl">
        <DialogHeader>
          <DialogTitle>Remind · {customerName}</DialogTitle>
          <DialogDescription>
            {d ? <>Owes <b className="text-ink">{rupee(d.amountDue)}</b>. </> : null}
            Read and edit the draft — nothing is sent until you press WhatsApp or Send email.
          </DialogDescription>
        </DialogHeader>

        {draft.isLoading ? (
          <div className="space-y-3" aria-busy="true" aria-label="Drafting the reminder">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : draft.isError || !d ? (
          <div role="alert" className="rounded-md border border-rose/40 bg-rose/5 px-3 py-3 text-sm">
            <p className="text-ink"><b>Could not draft the reminder.</b> {draft.error instanceof Error ? draft.error.message : "Try again."}</p>
            <Button type="button" size="sm" variant="default" icon="refresh" className="mt-2" onClick={() => { void draft.refetch(); }}>
              Try again
            </Button>
          </div>
        ) : (
          <form className="space-y-4" noValidate onSubmit={(e) => e.preventDefault()}>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <Badge kind={d.mode === "gemini" ? "info" : "muted"}>{d.mode === "gemini" ? "AI draft" : "Standard reminder"}</Badge>
              {d.note && <span className="text-ink-3">{d.note}</span>}
              <Button type="button" size="sm" variant="ghost" icon="refresh" className="ml-auto" loading={draft.isFetching} onClick={() => { void draft.refetch(); }}>
                Draft again
              </Button>
            </div>

            <FormField label="Message" required htmlFor="rm-message">
              <Textarea id="rm-message" rows={10} {...register("message")} />
            </FormField>
            {errors.message?.message && <p className="-mt-3 text-xs text-rose">{errors.message.message}</p>}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <FormField label="Email subject" htmlFor="rm-subject">
                <Input id="rm-subject" error={errors.subject?.message} {...register("subject")} />
              </FormField>
              <FormField label="Next follow-up" required htmlFor="rm-next">
                <Input id="rm-next" type="date" min={istToday()} error={errors.nextFollowUpOn?.message} {...register("nextFollowUpOn")} />
              </FormField>
            </div>

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

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <Button
                  type="button" variant="primary" icon="message" className="w-full justify-center"
                  disabled={!d.whatsapp || busy}
                  aria-describedby={d.whatsappBlocked ? "rm-wa-why" : undefined}
                  onClick={onWhatsapp}
                >
                  Open WhatsApp
                </Button>
                {d.whatsappBlocked
                  ? <p id="rm-wa-why" className="mt-1 text-xs text-ink-3">{d.whatsappBlocked}</p>
                  : <p className="mt-1 text-xs text-ink-3">Opens WhatsApp with this text for +{d.whatsapp} — press send there. Logged as a follow-up.</p>}
              </div>
              <div>
                <Button
                  type="button" variant="default" icon="mail" className="w-full justify-center"
                  disabled={!d.email || busy} loading={sendEmail.isPending}
                  aria-describedby={d.emailBlocked ? "rm-em-why" : undefined}
                  onClick={onEmail}
                >
                  Send email
                </Button>
                {d.emailBlocked
                  ? <p id="rm-em-why" className="mt-1 text-xs text-ink-3">{d.emailBlocked}</p>
                  : <p className="mt-1 text-xs text-ink-3 break-all">To {d.email}. Logged as a follow-up once it is sent.</p>}
              </div>
            </div>
          </form>
        )}

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
