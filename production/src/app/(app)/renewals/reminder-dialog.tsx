/**
 * R-2753 — the Renewals reminder dialog. ONE button opens it, on the ticked rows or (none ticked)
 * the open tab's rows. It lists who gets the renewal reminder email and, apart, who is skipped
 * with the reason (reminders.ts reminderPlan). Nothing is sent until "Email N" is pressed. After
 * the send the SAME dialog says who got it and who did not (with the reason) and offers
 * "Retry failed" — the old result was a toast that was easy to miss.
 */
"use client";

import * as React from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  groupSkips, reminderDialogTitle,
  type BulkReminderResult, type BulkReminderSkip, type RenewalRowLike, type ReminderScope,
} from "./reminders";

export interface ReminderDialogState<T extends RenewalRowLike> {
  scope: ReminderScope;
  send: T[];
  skipped: BulkReminderSkip<T>[];
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function RenewalReminderDialog<T extends RenewalRowLike>({
  state, onClose, onSend, emailOf,
}: {
  /** null = closed. */
  state: ReminderDialogState<T> | null;
  onClose: () => void;
  /** Runs the send-now route for each row; the page refreshes its lists. */
  onSend: (rows: T[]) => Promise<BulkReminderResult<T>>;
  emailOf?: (row: T) => string | null | undefined;
}) {
  const [sending, setSending] = React.useState(false);
  const [result, setResult] = React.useState<{ sent: T[]; failed: BulkReminderResult<T>["failed"]; stub: boolean } | null>(null);

  React.useEffect(() => {
    if (!state) { setResult(null); setSending(false); }
  }, [state]);

  if (!state) return null;
  const { scope, send, skipped } = state;
  const groups = groupSkips(skipped);

  async function run(rows: T[]) {
    if (sending || rows.length === 0) return;
    setSending(true);
    try {
      const r = await onSend(rows);
      const failedIds = new Set(r.failed.map((f) => f.row.sub.id));
      setResult((prev) => ({
        /* a retry adds to the names already reminded */
        sent: [...(prev?.sent ?? []), ...rows.filter((x) => !failedIds.has(x.sub.id))],
        failed: r.failed,
        stub: (prev?.stub ?? false) || r.stub,
      }));
    } catch {
      /* the send loop catches per row; anything else → every row shown as not sent, with a retry */
      setResult((prev) => ({
        sent: prev?.sent ?? [],
        failed: rows.map((row) => ({ row, name: row.sub.customer_name, reason: "The send did not go through — check your internet and retry." })),
        stub: prev?.stub ?? false,
      }));
    } finally {
      setSending(false);
    }
  }

  const title = result
    ? result.failed.length === 0
      ? `Reminded ${plural(result.sent.length, "customer")}`
      : `Reminded ${result.sent.length} · ${result.failed.length} not sent`
    : reminderDialogTitle(send.length, scope);

  return (
    <Dialog open onOpenChange={(o) => { if (!o && !sending) onClose(); }}>
      <DialogContent className="md:!max-w-2xl" data-testid="renewal-reminder-dialog">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {result
              ? result.stub ? "Email is in test mode here — nothing really left this app." : "The renewal reminder email went to each customer's primary contact."
              : send.length > 0
                ? "Each customer gets the renewal reminder for the step it is due, with its renewal quote. Nothing is sent until you press Email."
                : "None of these renewals is due for a reminder email — the reasons are below."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {result ? (
            <>
              {result.sent.length > 0 && (
                <section aria-label="Reminded">
                  <p className="mb-1 text-sm text-ink-2">Got the reminder: <b className="text-ink">{result.sent.length}</b></p>
                  <ul className="max-h-48 overflow-y-auto rounded-md border border-hairline divide-y divide-hairline text-sm">
                    {result.sent.map((r) => <li key={r.sub.id} className="px-3 py-2 font-medium text-ink break-words">{r.sub.customer_name}</li>)}
                  </ul>
                </section>
              )}
              {result.failed.length > 0 && (
                <section aria-label="Not sent">
                  <p className="mb-1 text-sm text-ink-2">Not sent: <b className="text-rose">{result.failed.length}</b></p>
                  <ul className="max-h-48 overflow-y-auto rounded-md border border-hairline divide-y divide-hairline text-sm">
                    {result.failed.map((f) => (
                      <li key={f.row.sub.id} className="px-3 py-2">
                        <span className="font-medium text-ink">{f.name}</span>
                        <span className="text-ink-3"> — {f.reason}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </>
          ) : (
            <>
              {send.length > 0 && (
                <section aria-label="Will be emailed">
                  <p className="mb-1 text-sm text-ink-2">Will be emailed: <b className="text-ink">{send.length}</b></p>
                  <ul className="max-h-56 overflow-y-auto rounded-md border border-hairline divide-y divide-hairline text-sm">
                    {send.map((r) => {
                      const email = emailOf?.(r);
                      return (
                      <li key={r.sub.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-3 py-2">
                        <span className="min-w-0 flex-1 font-medium text-ink break-words">{r.sub.customer_name}</span>
                        {email && <span className="text-xs text-ink-3 break-all">{email}</span>}
                        {r.daysUntil < 0 && <span className="text-xs text-amber-ink">past the date, in grace</span>}
                      </li>
                      );
                    })}
                  </ul>
                </section>
              )}
              {groups.length > 0 && (
                <section aria-label="Skipped">
                  <p className="mb-1 text-sm text-ink-2">Skipped: <b className="text-ink">{skipped.length}</b></p>
                  <ul className="max-h-48 overflow-y-auto rounded-md border border-hairline divide-y divide-hairline text-sm">
                    {groups.map((g) => (
                      <li key={g.reason} className="px-3 py-2">
                        <span className="text-ink-2">{g.reason}</span>
                        <span className="text-ink-3"> ({g.rows.length}): </span>
                        <span className="font-medium text-ink">{g.rows.map((r) => r.sub.customer_name).join(", ")}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" disabled={sending} onClick={onClose}>
            {result || send.length === 0 ? "Close" : "Cancel"}
          </Button>
          {!result && send.length > 0 && (
            <Button type="button" variant="primary" icon="mail" loading={sending} onClick={() => void run(send)}>
              Email {plural(send.length, "customer")}
            </Button>
          )}
          {result && result.failed.length > 0 && (
            <Button type="button" variant="primary" icon="refresh" loading={sending} onClick={() => void run(result.failed.map((f) => f.row))}>
              Retry failed
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
