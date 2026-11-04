/**
 * R-2412 — ONE "Send reminder" dialog. It replaces the two near-identical dialogs "Remind"
 * (R-1518) and "Send pending dues" (R-1526) — audit #6: two buttons that both message the
 * customer, with the difference hidden.
 *
 * The person picks WHAT to send:
 *   • "This invoice" — one open bill (the most overdue unless they pick another). The AI drafts
 *     the reminder (POST /api/collections/reminder/draft with the bill), money-checked; the text
 *     carries a UPI pay link for exactly that bill's amount.
 *   • "Full statement" — every open bill and the total (POST /api/customers/{id}/pending-dues —
 *     R-2439: the POST also makes the Razorpay link; a GET only reads it).
 *     WhatsApp carries the 7-day statement PDF link; email attaches the PDF. Both carry the UPI
 *     pay link for the total.
 * …and HOW: WhatsApp first (when the customer has a mobile number), email as the fallback.
 *
 * Pay link: the app's existing `upi://pay` link (lib/invoices/pay-link, pending-dues
 * statementUpiUri) — no gateway call. A Razorpay payment link is deliberately NOT minted here:
 * that code (lib/payments/payment-link*, R-1608) is quote-only, sends its own email, and minting
 * one per dialog opening would leave a bill with many live links (see lib/invoices/pay-link.ts).
 * No link → the dialog says why and the next step (§24: add the UPI ID in Settings).
 *
 * R-2415: next to the UPI link, ONE Razorpay link (card / UPI / net banking) for that bill or
 * the statement total — made by the draft / statement POST the first time (R-2439: a GET only reads), the SAME link on
 * every later opening, replaced when the amount changes (lib/payments/payment-link.server).
 * The text already carries it; the dialog says what it asks for (and TEST MODE on a test key),
 * or why there is none and the fix. Razorpay sends nothing itself.
 *
 * DECISION (Pardeep, 17 Oct, R-1514): nothing goes out on its own. Opening the dialog, switching
 * the choice or picking a bill only DRAFTS / READS. A message leaves only when the person presses
 * "Open WhatsApp" (wa.me opens; they press send inside WhatsApp; the follow-up is logged through
 * R-1517's route) or "Send email" (sent on the server through lib/messaging, follow-up logged
 * there; R-1544 one email per press via requestId).
 *
 * The old exports ReminderDialog / PendingDuesDialog render this dialog with the matching
 * default choice, so callers keep working until the page shows the single button.
 *
 * The WhatsApp window opens synchronously inside the click (a popup opened after an await is
 * blocked), so validation is a direct zod parse of the form values, not handleSubmit.
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
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Icon } from "@/components/ui/icon";
import { istToday } from "@/lib/dates/ist";
import { rupee, formatDate } from "@/lib/utils";
import { defaultNextFollowUp, NEXT_REQUIRED, type FollowupRequest } from "@/lib/collections/followup-rules";
import {
  reminderNote, waMeUrl, type PayLinkNotice, type ReminderLineChoice, type ReminderLineRef,
} from "@/lib/collections/reminder-draft";
import type { DuesLine, StatementQrNotice } from "@/lib/collections/pending-dues";
import type { CardLinkNotice } from "@/lib/payments/payment-link";
import { followupsKey, useAddFollowup } from "@/lib/queries/payment-followups";

// ─── What the two reads return ───────────────────────────────────────────────

type About = { invoiceId: string | null; subscriptionId: string | null; quoteId: string | null };

/** R-2415: the bill's / statement's Razorpay link, or why there is none. */
export interface CardLinkInfo {
  url: string;
  amount: number;
  billAmount: number;
  mode: "live" | "test";
}

interface Reach {
  whatsapp: string | null;
  whatsappBlocked: string | null;
  email: string | null;
  emailBlocked: string | null;
}

export interface ReminderDraftResponse extends Reach {
  subject: string;
  message: string;
  mode: "gemini" | "template";
  note: string | null;
  amountDue: number;
  /** R-2412: the bill this reminder is about, every open bill for the picker, the pay link. */
  line?: ReminderLineRef;
  lines?: ReminderLineChoice[];
  payLink?: string | null;
  payLinkNotice?: PayLinkNotice | null;
  cardLink?: CardLinkInfo | null;
  cardLinkNotice?: CardLinkNotice | null;
  about: About;
}

export interface PendingDuesPreview extends Reach {
  customerName: string;
  asOn: string;
  lines: DuesLine[];
  total: number;
  qrNotice: StatementQrNotice | null;
  hasBank: boolean;
  subject: string;
  emailText: string;
  whatsappText: string;
  /** R-2412: the UPI pay link for the total that both messages carry (null = none). */
  payLink?: string | null;
  cardLink?: CardLinkInfo | null;
  cardLinkNotice?: CardLinkNotice | null;
  about: About;
}

class SendError extends Error {}
/** R-2439: middleware refused a write because this is a demo visitor (read-only). */
class DemoRefusal extends SendError {}

async function readJson<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    throw new SendError("Could not reach the server — check your internet and try again.");
  }
  const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; demo?: boolean };
  if (!res.ok && json.demo === true) throw new DemoRefusal(json.error || "This is a demo — changes are off.");
  if (!res.ok || !json.ok) throw new SendError(json.error || "Something went wrong — try again.");
  return json as T;
}
const postJson = <T,>(url: string, body: unknown) =>
  readJson<T>(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export const pendingDuesUrl = (customerId: string) => `/api/customers/${encodeURIComponent(customerId)}/pending-dues`;

/**
 * R-2439: the statement preview. POST — it also makes / reuses the statement's Razorpay link
 * (a GET of the same URL only reads it, so a prefetch or reload can never make or cancel one).
 * A demo visitor's POSTs are refused by middleware: they get the read-only GET (no link made).
 */
export async function readStatementPreview(customerId: string): Promise<PendingDuesPreview> {
  try {
    return await postJson<PendingDuesPreview>(pendingDuesUrl(customerId), {});
  } catch (e) {
    if (e instanceof DemoRefusal) return readJson<PendingDuesPreview>(pendingDuesUrl(customerId));
    throw e;
  }
}

// ─── The form (same for both choices) ────────────────────────────────────────

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const formSchema = z.object({
  channel: z.enum(["whatsapp", "email"]),
  subject: z.string().trim().max(300, "Keep the subject under 300 characters."),
  whatsappText: z.string().trim().max(4000, "Keep the message under 4,000 characters."),
  emailText: z.string().trim().max(4000, "Keep the message under 4,000 characters."),
  nextFollowUpOn: z.string().regex(ISO_DATE, NEXT_REQUIRED),
});
type FormValues = z.infer<typeof formSchema>;
type Channel = FormValues["channel"];

export type ReminderScope = "invoice" | "statement";

export interface SendReminderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  customerId: string;
  customerName: string;
  /** Which choice is selected when the dialog opens (default "This invoice"). */
  defaultScope?: ReminderScope;
  /** "This invoice" starts on this bill (else the most overdue one). */
  invoiceId?: string | null;
}

const SCOPES: { value: ReminderScope; label: string; hint: string }[] = [
  { value: "invoice", label: "This invoice", hint: "One bill, AI draft, pay link for that bill." },
  { value: "statement", label: "Full statement", hint: "Every open bill and the total, statement PDF, pay link for the total." },
];

const pill = (on: boolean) =>
  `min-h-[44px] md:min-h-0 px-3 py-1.5 rounded-full border text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber ${
    on ? "border-amber bg-amber-soft text-ink" : "border-hairline bg-paper text-ink-2 hover:border-amber/60"
  }`;

export function SendReminderDialog({
  open, onOpenChange, customerId, customerName, defaultScope = "invoice", invoiceId = null,
}: SendReminderDialogProps) {
  const qc = useQueryClient();
  const [scope, setScope] = React.useState<ReminderScope>(defaultScope);
  const [line, setLine] = React.useState<ReminderLineRef | null>(invoiceId ? { kind: "invoice", id: invoiceId } : null);

  const draft = useQuery({
    queryKey: ["reminder-draft", customerId, line?.kind ?? null, line?.id ?? null],
    enabled: open && scope === "invoice",
    queryFn: () => postJson<ReminderDraftResponse>("/api/collections/reminder/draft", line ? { customerId, line } : { customerId }),
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const preview = useQuery({
    queryKey: ["pending-dues", customerId],
    enabled: open && scope === "statement",
    queryFn: () => readStatementPreview(customerId),   // R-2439: POST (makes the link); demo → GET
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const active = scope === "invoice" ? draft : preview;

  const addFollowup = useAddFollowup();
  const [problem, setProblem] = React.useState<string | null>(null);
  /* WhatsApp opened but the log failed — offer to log again WITHOUT opening WhatsApp twice. */
  const [unlogged, setUnlogged] = React.useState<FollowupRequest | null>(null);

  const form = useForm<FormValues>({
    defaultValues: { channel: "whatsapp", subject: "", whatsappText: "", emailText: "", nextFollowUpOn: defaultNextFollowUp(istToday()) },
  });
  const { register, reset, getValues, setValue, watch, setError, clearErrors, formState: { errors } } = form;
  const channel = watch("channel");

  // R-1544: one id per opening AND per choice — a retry after a timeout sends the SAME id, so the
  // server answers "already sent" instead of mailing twice; another choice is another email.
  const [requestId, setRequestId] = React.useState(() => crypto.randomUUID());
  // Fill the form once per read (a redraft replaces it; typing is never overwritten otherwise).
  const filledFrom = React.useRef<string>("");
  React.useEffect(() => {
    if (!open) {
      filledFrom.current = "";
      setProblem(null); setUnlogged(null); setRequestId(crypto.randomUUID());
      setScope(defaultScope);
      setLine(invoiceId ? { kind: "invoice", id: invoiceId } : null);
      return;
    }
    const stamp = `${scope}:${active.dataUpdatedAt}`;
    if (!active.data || filledFrom.current === stamp) return;
    /* A refill (other bill, other choice, Draft again) keeps the person's channel and date. */
    const refill = filledFrom.current !== "";
    filledFrom.current = stamp;
    const keepNext = getValues("nextFollowUpOn") || defaultNextFollowUp(istToday());
    // WhatsApp first; email only when there is no WhatsApp number but there is an email.
    const pick = (r: Reach): Channel => (refill ? getValues("channel") : r.whatsapp || !r.email ? "whatsapp" : "email");
    if (scope === "invoice" && draft.data) {
      const d = draft.data;
      reset({ channel: pick(d), subject: d.subject, whatsappText: d.message, emailText: d.message, nextFollowUpOn: keepNext });
    } else if (scope === "statement" && preview.data) {
      const d = preview.data;
      reset({ channel: pick(d), subject: d.subject, whatsappText: d.whatsappText, emailText: d.emailText, nextFollowUpOn: keepNext });
    }
  }, [open, scope, active.data, active.dataUpdatedAt, draft.data, preview.data, reset, getValues, defaultScope, invoiceId]);

  const chooseScope = (s: ReminderScope) => {
    if (s === scope) return;
    setScope(s);
    setProblem(null);
    setUnlogged(null);
    setRequestId(crypto.randomUUID());
  };
  const chooseLine = (l: ReminderLineChoice) => {
    if (line?.kind === l.kind && line.id === l.id) return;
    setLine({ kind: l.kind, id: l.id });
    setProblem(null);
    setRequestId(crypto.randomUUID());
  };

  const sendEmail = useMutation({
    mutationFn: (args: { url: string; body: Record<string, unknown> }) =>
      postJson<{ sentTo: string; logged: boolean; warning?: string; alreadySent?: boolean }>(args.url, args.body),
    onSuccess: (out) => {
      void qc.invalidateQueries({ queryKey: ["collections"] });
      void qc.invalidateQueries({ queryKey: followupsKey(customerId) });
      const what = scope === "statement" ? "Statement" : "Reminder";
      if (out.alreadySent) {
        toast.success(`${what} already went to ${out.sentTo}`, { description: "It was not sent again." });
        onOpenChange(false);
      } else if (out.logged) {
        toast.success(`${what} emailed to ${out.sentTo}`, { description: scope === "statement" ? "PDF attached. Follow-up logged." : "Follow-up logged." });
        onOpenChange(false);
      } else {
        setProblem(out.warning ?? `The email went to ${out.sentTo}, but the follow-up was not logged — log it with Follow-up.`);
      }
    },
    onError: (e) => setProblem(e instanceof Error ? e.message : "The email was not sent — try again."),
  });

  /** zod on the current values; puts each message under its field. */
  const validate = (): FormValues | null => {
    clearErrors();
    setProblem(null);
    const parsed = formSchema.safeParse(getValues());
    if (!parsed.success) {
      for (const i of parsed.error.issues) setError(i.path[0] as keyof FormValues, { message: i.message });
      return null;
    }
    const v = parsed.data;
    const field = v.channel === "email" ? "emailText" : "whatsappText";
    if (!v[field]) {
      setError(field, { message: "The message is empty — write the reminder first." });
      return null;
    }
    if (v.channel === "email" && !v.subject) {
      setError("subject", { message: "Write a subject for the email." });
      return null;
    }
    return v;
  };

  const reach: Reach | undefined = scope === "invoice" ? draft.data : preview.data;
  const about: About | undefined = scope === "invoice" ? draft.data?.about : preview.data?.about;

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
    const number = reach?.whatsapp;
    if (!number) return;
    const v = validate();
    if (!v) return;
    window.open(waMeUrl(number, v.whatsappText), "_blank", "noopener,noreferrer");
    logWhatsapp({
      customerId,
      kind: "whatsapp",
      note: reminderNote(v.whatsappText),
      nextFollowUpOn: v.nextFollowUpOn,
      invoiceId: about?.invoiceId ?? undefined,
      quoteId: about?.quoteId ?? undefined,
      subscriptionId: about?.subscriptionId ?? undefined,
    });
  };

  const onEmail = () => {
    if (!reach?.email) return;
    const v = validate();
    if (!v) return;
    if (scope === "statement") {
      sendEmail.mutate({
        url: `${pendingDuesUrl(customerId)}/email`,
        body: { subject: v.subject, message: v.emailText, nextFollowUpOn: v.nextFollowUpOn, requestId },
      });
    } else {
      sendEmail.mutate({
        url: "/api/collections/reminder/email",
        body: {
          customerId,
          subject: v.subject,
          message: v.emailText,
          nextFollowUpOn: v.nextFollowUpOn,
          invoiceId: about?.invoiceId ?? undefined,
          quoteId: about?.quoteId ?? undefined,
          subscriptionId: about?.subscriptionId ?? undefined,
          requestId,
        },
      });
    }
  };

  const busy = addFollowup.isPending || sendEmail.isPending;
  const d = draft.data;
  const p = preview.data;
  const nothingDue = scope === "statement" && !!p && p.total <= 0;
  const payLink = scope === "invoice" ? d?.payLink ?? null : p?.payLink ?? null;
  const payAmount = scope === "invoice" ? d?.amountDue ?? 0 : p?.total ?? 0;
  const noLink: { text: string; action?: { label: string; href: string } } | null =
    scope === "invoice" ? d?.payLinkNotice ?? null : p && !p.payLink ? p.qrNotice : null;
  const cardLink = scope === "invoice" ? d?.cardLink ?? null : p?.cardLink ?? null;
  const cardNotice = scope === "invoice" ? d?.cardLinkNotice ?? null : p?.cardLinkNotice ?? null;
  const textField: "whatsappText" | "emailText" = channel === "email" ? "emailText" : "whatsappText";
  const lines = d?.lines ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="md:!max-w-2xl">
        <DialogHeader>
          <DialogTitle>Send reminder · {customerName}</DialogTitle>
          <DialogDescription>
            Choose one bill or the full statement. Read and edit the message — nothing is sent until you press Open WhatsApp or Send email.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap gap-2" role="group" aria-label="What to send">
          {SCOPES.map((s) => (
            <button key={s.value} type="button" aria-pressed={scope === s.value} title={s.hint} onClick={() => chooseScope(s.value)} className={pill(scope === s.value)}>
              {s.label}
            </button>
          ))}
        </div>

        {active.isLoading ? (
          <div className="space-y-3" aria-busy="true" aria-label={scope === "invoice" ? "Drafting the reminder" : "Reading this customer's bills"}>
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : active.isError || !reach ? (
          <div role="alert" className="rounded-md border border-rose/40 bg-rose/5 px-3 py-3 text-sm">
            <p className="text-ink">
              <b>{scope === "invoice" ? "Could not draft the reminder." : "Could not read the statement."}</b>{" "}
              {active.error instanceof Error ? active.error.message : "Try again."}
            </p>
            <Button type="button" size="sm" variant="default" icon="refresh" className="mt-2" onClick={() => { void active.refetch(); }}>
              Try again
            </Button>
          </div>
        ) : nothingDue ? (
          <p className="text-sm text-ink-2">This customer owes nothing right now — there is no statement to send.</p>
        ) : (
          <form className="space-y-4" noValidate onSubmit={(e) => e.preventDefault()}>
            {scope === "invoice" && d && lines.length > 1 && (
              <div role="group" aria-label="Which bill" className="rounded-md border border-hairline">
                <p className="px-3 pt-2 text-xs text-ink-3">Which bill</p>
                <ul className="max-h-40 overflow-y-auto divide-y divide-hairline text-sm">
                  {lines.map((l) => {
                    const on = d.line ? d.line.kind === l.kind && d.line.id === l.id : false;
                    return (
                      <li key={`${l.kind}:${l.id}`}>
                        <button
                          type="button" aria-pressed={on} onClick={() => chooseLine(l)} disabled={draft.isFetching}
                          className={`flex w-full flex-wrap items-baseline gap-x-3 px-3 py-2 min-h-[44px] md:min-h-0 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber ${on ? "bg-amber-soft" : "hover:bg-paper-2"}`}
                        >
                          <span className="min-w-0 flex-1 break-all">
                            <span className="text-3xs uppercase tracking-wider text-ink-3 mr-2">{l.kind === "invoice" ? "Invoice" : "Subscription"}</span>
                            <span className="font-mono text-xs">{l.label}</span>
                          </span>
                          {l.daysOverdue > 0 && <span className="text-xs text-rose">{l.daysOverdue}d overdue</span>}
                          <span className="font-mono text-xs tabular-nums text-ink">{rupee(l.amountDue)}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}

            {scope === "statement" && p && (
              <div className="rounded-md border border-hairline">
                <ul className="divide-y divide-hairline max-h-48 overflow-y-auto text-sm" aria-label="Open bills on the statement">
                  {p.lines.map((l) => (
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
                  <span className="text-sm text-ink-2">{p.lines.length} {p.lines.length === 1 ? "bill" : "bills"} · Total due</span>
                  <b className="font-mono tabular-nums text-ink">{rupee(p.total)}</b>
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
            )}

            {payLink ? (
              <p className="flex items-center gap-2 text-xs text-ink-2">
                <Icon name="check" size={14} className="shrink-0 text-ink-3" />
                <span>Pay link in the message: UPI for <b className="font-mono tabular-nums text-ink">{rupee(payAmount)}</b> (opens GPay / PhonePe / Paytm on the phone).</span>
              </p>
            ) : noLink ? (
              <div role="note" className="flex flex-wrap items-center gap-2 rounded-md border border-amber/40 bg-amber-soft px-3 py-2 text-sm text-ink">
                <Icon name="info" size={16} className="shrink-0" />
                <span className="flex-1 min-w-0">{noLink.text}</span>
                {noLink.action && (
                  <Link href={noLink.action.href as Route} className="inline-flex items-center min-h-[44px] md:min-h-0 rounded-full border border-hairline bg-paper px-3 py-1 text-sm hover:border-amber/60">
                    {noLink.action.label}
                  </Link>
                )}
              </div>
            ) : null}
            {cardLink ? (
              <p className="flex flex-wrap items-center gap-2 text-xs text-ink-2">
                <Icon name="check" size={14} className="shrink-0 text-ink-3" />
                <span className="min-w-0 flex-1">
                  Card / UPI / net-banking link in the message: <b className="font-mono tabular-nums text-ink">{rupee(cardLink.amount)}</b> (Razorpay — the same link every time you send this, until the amount changes).
                </span>
                {cardLink.mode === "test" && <Badge kind="warning">Test mode — takes no real money</Badge>}
              </p>
            ) : cardNotice ? (
              <div role="note" className="flex flex-wrap items-center gap-2 rounded-md border border-hairline bg-paper-2 px-3 py-2 text-xs text-ink-2">
                <Icon name="info" size={14} className="shrink-0" />
                <span className="flex-1 min-w-0">{cardNotice.text}</span>
                {cardNotice.action && (
                  <Link href={cardNotice.action.href as Route} className="inline-flex items-center min-h-[44px] md:min-h-0 rounded-full border border-hairline bg-paper px-3 py-1 text-sm hover:border-amber/60">
                    {cardNotice.action.label}
                  </Link>
                )}
              </div>
            ) : null}
            {scope === "statement" && p && !p.hasBank && (
              <p className="text-xs text-ink-3">No bank account in Settings — the statement shows the bills and total without bank details.</p>
            )}

            {scope === "invoice" && d && (
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <Badge kind={d.mode === "gemini" ? "info" : "muted"}>{d.mode === "gemini" ? "AI draft" : "Standard reminder"}</Badge>
                {d.note && <span className="text-ink-3">{d.note}</span>}
                <Button type="button" size="sm" variant="ghost" icon="refresh" className="ml-auto" loading={draft.isFetching} onClick={() => { void draft.refetch(); }}>
                  Draft again
                </Button>
              </div>
            )}

            <div className="flex flex-wrap gap-2" role="group" aria-label="Send by">
              {(["whatsapp", "email"] as const).map((c: Channel) => (
                <button key={c} type="button" aria-pressed={channel === c} onClick={() => setValue("channel", c)} className={pill(channel === c)}>
                  {c === "whatsapp" ? "WhatsApp" : scope === "statement" ? "Email (PDF attached)" : "Email"}
                </button>
              ))}
            </div>

            {channel === "email" && (
              <FormField label="Email subject" required htmlFor="sr-subject">
                <Input id="sr-subject" error={errors.subject?.message} {...register("subject")} />
              </FormField>
            )}
            <FormField label="Message" required htmlFor={`sr-${textField}`}>
              <Textarea key={textField} id={`sr-${textField}`} rows={10} {...register(textField)} />
            </FormField>
            {errors[textField]?.message && <p className="-mt-3 text-xs text-rose">{errors[textField]?.message}</p>}

            <FormField label="Next follow-up" required htmlFor="sr-next">
              <Input id="sr-next" type="date" min={istToday()} error={errors.nextFollowUpOn?.message} {...register("nextFollowUpOn")} />
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
                  disabled={!reach.whatsapp || busy}
                  aria-describedby={reach.whatsappBlocked ? "sr-wa-why" : undefined}
                  onClick={onWhatsapp}
                >
                  Open WhatsApp
                </Button>
                {reach.whatsappBlocked
                  ? <p id="sr-wa-why" className="mt-1 text-xs text-ink-3">{reach.whatsappBlocked}{reach.email ? " Or choose Email above." : ""}</p>
                  : <p className="mt-1 text-xs text-ink-3">Opens WhatsApp with this text for +{reach.whatsapp} — press send there. Logged as a follow-up.</p>}
              </div>
            ) : (
              <div>
                <Button
                  type="button" variant="primary" icon="mail" className="w-full justify-center"
                  disabled={!reach.email || busy} loading={sendEmail.isPending}
                  aria-describedby={reach.emailBlocked ? "sr-em-why" : undefined}
                  onClick={onEmail}
                >
                  Send email
                </Button>
                {reach.emailBlocked
                  ? <p id="sr-em-why" className="mt-1 text-xs text-ink-3">{reach.emailBlocked}</p>
                  : <p className="mt-1 text-xs text-ink-3 break-all">To {reach.email}{scope === "statement" ? ", statement PDF attached" : ""}. Logged as a follow-up once it is sent.</p>}
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
