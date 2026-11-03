/**
 * R-2413 — bulk "Send reminder" / "Send statement" over the rows ticked on Payment Follow-up.
 *
 * ONE flow, ONE confirm: the dialog itself is the confirm. It
 *   1. splits the ticked rows into who gets it and who is skipped, with the reason
 *      (lib/collections/bulk-actions.ts bulkSendTargets — on hold: promised / disputed, R-2411;
 *      nothing late yet; owes nothing; no customer record);
 *   2. READS each recipient's message through the SAME routes the Send reminder dialog uses
 *      (R-2412): reminder → POST /api/collections/reminder/draft with `standard: true` (the plain
 *      template, no AI call per customer — every amount from the books); statement → GET
 *      /api/customers/{id}/pending-dues. Reading sends nothing;
 *   3. lists every recipient (name · email · amount) and every skipped customer (why), with one
 *      Next follow-up date for all;
 *   4. sends ONLY when the person presses "Email N customers" — each email through the same
 *      per-customer route as the dialog (reminder/email, pending-dues/email: the company's
 *      "Customer messages" switch, email_log, the follow-up logged), one at a time, each with its
 *      own requestId made when it was read, so pressing Send again after a failure never mails
 *      anyone twice (R-1544: "already sent").
 *
 * Email only: WhatsApp needs a person to press send inside WhatsApp for each customer, so a
 * customer with no email is listed as skipped with the way on (the row's ⋯ → Send reminder opens
 * WhatsApp for them). Owner / manager / accountant only — the page shows the bar only to them.
 */
"use client";

import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { istToday } from "@/lib/dates/ist";
import { rupee } from "@/lib/utils";
import { defaultNextFollowUp, NEXT_REQUIRED } from "@/lib/collections/followup-rules";
import {
  bulkSendReport, bulkSendTargets, skipSummary, type BulkSendMode, type Skipped,
} from "@/lib/collections/bulk-actions";
import type { CollectionRow } from "@/lib/queries/collections";
import { pendingDuesUrl, type PendingDuesPreview, type ReminderDraftResponse } from "./send-reminder-dialog";

/** One recipient, read and ready to send. */
export interface BulkRecipient {
  row: CollectionRow;
  email: string;
  subject: string;
  text: string;
  amount: number;
  about: { invoiceId: string | null; subscriptionId: string | null; quoteId: string | null };
  /** R-1544: made once per read — a second press of Send for the same customer is "already sent". */
  requestId: string;
}

class BulkError extends Error {}

async function readJson<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    throw new BulkError("could not reach the server — check your internet");
  }
  const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  if (!res.ok || !json.ok) throw new BulkError(json.error || "something went wrong");
  return json as T;
}
const postJson = <T,>(url: string, body: unknown) =>
  readJson<T>(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const NO_EMAIL = "no email address — use the row's ⋯ → Send reminder to send it on WhatsApp";

/** Read one customer's message. Nothing is sent. */
async function readOne(row: CollectionRow, mode: BulkSendMode): Promise<BulkRecipient | Skipped<CollectionRow>> {
  const customerId = row.customerId!;
  try {
    if (mode === "reminder") {
      const d = await postJson<ReminderDraftResponse>("/api/collections/reminder/draft", { customerId, standard: true });
      if (!d.email) return { row, reason: d.emailBlocked ? `${d.emailBlocked}` : NO_EMAIL };
      return { row, email: d.email, subject: d.subject, text: d.message, amount: d.amountDue, about: d.about, requestId: crypto.randomUUID() };
    }
    const p = await readJson<PendingDuesPreview>(pendingDuesUrl(customerId));
    if (p.total <= 0) return { row, reason: "owes nothing now" };
    if (!p.email) return { row, reason: p.emailBlocked ? `${p.emailBlocked}` : NO_EMAIL };
    return { row, email: p.email, subject: p.subject, text: p.emailText, amount: p.total, about: p.about, requestId: crypto.randomUUID() };
  } catch (e) {
    return { row, reason: `could not read the bills — ${e instanceof Error ? e.message : "try again"}` };
  }
}

const isRecipient = (x: BulkRecipient | Skipped<CollectionRow>): x is BulkRecipient => "email" in x;

/** Reads in small parallel batches (3 at a time) so 20 customers do not take 20 round trips in a row. */
async function readAll(rows: readonly CollectionRow[], mode: BulkSendMode) {
  const out: (BulkRecipient | Skipped<CollectionRow>)[] = [];
  for (let i = 0; i < rows.length; i += 3) {
    out.push(...(await Promise.all(rows.slice(i, i + 3).map((r) => readOne(r, mode)))));
  }
  return { recipients: out.filter(isRecipient), skipped: out.filter((x): x is Skipped<CollectionRow> => !isRecipient(x)) };
}

type SendOut = { alreadySent?: boolean; logged?: boolean; warning?: string };

/** Send one email through the same route as the Send reminder dialog. */
async function sendOne(r: BulkRecipient, mode: BulkSendMode, nextFollowUpOn: string) {
  const customerId = r.row.customerId!;
  if (mode === "statement") {
    return postJson<SendOut>(`${pendingDuesUrl(customerId)}/email`, {
      subject: r.subject, message: r.text, nextFollowUpOn, requestId: r.requestId,
    });
  }
  return postJson<SendOut>("/api/collections/reminder/email", {
    customerId,
    subject: r.subject,
    message: r.text,
    nextFollowUpOn,
    invoiceId: r.about.invoiceId ?? undefined,
    quoteId: r.about.quoteId ?? undefined,
    subscriptionId: r.about.subscriptionId ?? undefined,
    requestId: r.requestId,
  });
}

const TITLE: Record<BulkSendMode, string> = { reminder: "Send reminder", statement: "Send statement" };

export function BulkSendDialog({
  open, onOpenChange, mode, rows, onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: BulkSendMode;
  /** The ticked rows. */
  rows: readonly CollectionRow[];
  /** After a run: the keys NOT sent — the page keeps only those ticked, so a second run never re-reads (and re-mails) the ones that went. */
  onDone?: (failedKeys: string[]) => void;
}) {
  const qc = useQueryClient();
  const { send: targets, skipped: ruleSkipped } = React.useMemo(() => bulkSendTargets(rows, mode), [rows, mode]);
  const keys = targets.map((r) => r.key).join(",");
  const read = useQuery({
    queryKey: ["bulk-send", mode, keys],
    enabled: open && targets.length > 0,
    queryFn: () => readAll(targets, mode),
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });

  const [next, setNext] = React.useState(() => defaultNextFollowUp(istToday()));
  const [nextError, setNextError] = React.useState<string | null>(null);
  const [sending, setSending] = React.useState(false);
  /* After a run with failures: only those are left to send (same requestIds). */
  const [left, setLeft] = React.useState<BulkRecipient[] | null>(null);
  const [failures, setFailures] = React.useState<Map<string, string>>(new Map());

  React.useEffect(() => {
    if (!open) { setLeft(null); setFailures(new Map()); setNextError(null); setNext(defaultNextFollowUp(istToday())); }
  }, [open]);

  const recipients = left ?? read.data?.recipients ?? [];
  const skipped = [...ruleSkipped, ...(read.data?.skipped ?? [])];
  const total = recipients.reduce((s, r) => s + Math.round(r.amount), 0);
  const sample = recipients[0];

  async function onSend() {
    if (sending || recipients.length === 0) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(next)) { setNextError(NEXT_REQUIRED); return; }
    setNextError(null);
    setSending(true);
    let sent = 0;
    let already = 0;
    const failed: { r: BulkRecipient; error: string }[] = [];
    const unlogged: string[] = [];
    for (const r of recipients) {
      try {
        const out = await sendOne(r, mode, next);
        if (out.alreadySent) already += 1; else sent += 1;
        if (!out.alreadySent && out.logged === false) unlogged.push(r.row.customerName);
      } catch (e) {
        failed.push({ r, error: e instanceof Error ? e.message : "not sent" });
      }
    }
    setSending(false);
    void qc.invalidateQueries({ queryKey: ["collections"] });
    void qc.invalidateQueries({ queryKey: ["payment-followups"] });
    const m = bulkSendReport(mode, { sent, already, failed: failed.map((f) => ({ name: f.r.row.customerName, error: f.error })), unlogged });
    if (m.tone === "success") toast.success(m.title);
    else if (m.tone === "warning") toast.warning(m.title, { description: m.description, duration: 15_000 });
    else toast.error(m.title, { description: m.description, duration: 15_000 });
    onDone?.(failed.map((f) => f.r.row.key));
    if (failed.length === 0) {
      onOpenChange(false);
      return;
    }
    setLeft(failed.map((f) => f.r));
    setFailures(new Map(failed.map((f) => [f.r.row.key, f.error])));
  }

  const noun = mode === "statement" ? "statement" : "reminder";
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!sending) onOpenChange(o); }}>
      <DialogContent className="md:!max-w-2xl">
        <DialogHeader>
          <DialogTitle>{TITLE[mode]} · {rows.length} selected</DialogTitle>
          <DialogDescription>
            {mode === "statement"
              ? "Each customer gets their own statement by email — every open bill, the total and the statement PDF."
              : "Each customer gets the standard reminder by email about their most overdue bill — that bill's amount and pay link (the same as This invoice in Send reminder)."}
            {" "}Nothing is sent until you press Email.
          </DialogDescription>
        </DialogHeader>

        {targets.length > 0 && read.isLoading ? (
          <div className="space-y-2" aria-busy="true" aria-label="Reading each customer's bills">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : (
          <div className="space-y-4">
            {recipients.length > 0 ? (
              <section aria-label="Will be emailed">
                <p className="text-sm text-ink-2 mb-1">
                  {left ? "Not sent yet" : "Will be emailed"}: <b className="text-ink">{recipients.length}</b> {recipients.length === 1 ? "customer" : "customers"} ·{" "}
                  <b className="font-mono tabular-nums text-ink">{rupee(total)}</b>
                </p>
                <ul className="max-h-56 overflow-y-auto rounded-md border border-hairline divide-y divide-hairline text-sm">
                  {recipients.map((r) => (
                    <li key={r.row.key} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-3 py-2">
                      <span className="min-w-0 flex-1 font-medium text-ink break-words">{r.row.customerName}</span>
                      <span className="text-xs text-ink-3 break-all">{r.email}</span>
                      <span className="font-mono text-xs tabular-nums text-ink" title={mode === "reminder" ? "Most overdue bill" : "Total due"}>{rupee(r.amount)}</span>
                      {failures.get(r.row.key) && <span className="basis-full text-xs text-rose">Not sent: {failures.get(r.row.key)}</span>}
                    </li>
                  ))}
                </ul>
              </section>
            ) : (
              <p role="status" className="text-sm text-ink-2">Nobody to email — every selected customer is skipped below.</p>
            )}

            {skipped.length > 0 && !left && (
              <section aria-label="Skipped">
                <p className="text-sm text-ink-2 mb-1">
                  Skipped: <b className="text-ink">{skipped.length}</b> <span className="text-ink-3">({skipSummary(skipped)})</span>
                </p>
                <ul className="max-h-40 overflow-y-auto rounded-md border border-hairline divide-y divide-hairline text-sm">
                  {skipped.map((s) => (
                    <li key={s.row.key} className="px-3 py-2">
                      <span className="font-medium text-ink">{s.row.customerName}</span>
                      <span className="text-ink-3"> — {s.reason}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {sample && (
              <details className="rounded-md border border-hairline px-3 py-2 text-sm">
                <summary className="cursor-pointer text-ink-2">See the {noun} for {sample.row.customerName}</summary>
                <p className="mt-2 text-xs text-ink-3">Subject: {sample.subject}</p>
                <pre className="mt-1 whitespace-pre-wrap break-words font-sans text-sm text-ink">{sample.text}</pre>
              </details>
            )}

            {recipients.length > 0 && (
              <FormField label="Next follow-up (for every customer emailed)" required htmlFor="bulk-next">
                <Input id="bulk-next" type="date" min={istToday()} value={next} error={nextError ?? undefined} onChange={(e) => setNext(e.target.value)} />
              </FormField>
            )}
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="ghost" disabled={sending} onClick={() => onOpenChange(false)}>Close</Button>
          {recipients.length > 0 && (
            <Button type="button" variant="primary" icon="mail" loading={sending} onClick={() => void onSend()}>
              {left ? `Send ${recipients.length} again` : `Email ${recipients.length} ${recipients.length === 1 ? "customer" : "customers"}`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
