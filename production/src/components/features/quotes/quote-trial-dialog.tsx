/**
 * R-282 — "Start trial (pay later)" on an accepted, unpaid quote.
 *
 * The customer has agreed the price and wants to try Workspace before paying. Two inputs:
 * days (default 14) and users (default the quote's seats, Google caps a trial at 10 — above
 * that is a warning, not a block). Saving puts the quote's lead on a trial ending N days from
 * today (IST), makes that end day the payment due date, and writes three owner tasks. The quote
 * stays accepted; nothing is sent to the customer and nothing is suspended automatically.
 * Rules live in lib/trials/start-from-quote.ts.
 */
"use client";

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { toastError } from "@/lib/errors/toast-error";
import { createClient } from "@/lib/supabase/client";
import { Sheet, SheetContent, SheetFooter, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Icon } from "@/components/ui/icon";
import {
  QUOTE_TRIAL_DAYS, QUOTE_TRIAL_MIN_DAYS, QUOTE_TRIAL_MAX_DAYS,
  defaultTrialUsers, trialUsersWarning, validTrialDays, planQuoteTrial, formatIstDate,
  startTrialFromQuote, type StartTrialFromQuoteInput,
} from "@/lib/trials/start-from-quote";
import { toIstDate } from "@/lib/dates/ist";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  quote: StartTrialFromQuoteInput["quote"] & { seats: number | null };
  lead: StartTrialFromQuoteInput["lead"];
  customer: StartTrialFromQuoteInput["customer"];
  ownerId: string | undefined;
}

export function QuoteTrialDialog({ open, onOpenChange, quote, lead, customer, ownerId }: Props) {
  const qc = useQueryClient();
  const [days, setDays]   = React.useState(String(QUOTE_TRIAL_DAYS));
  const [users, setUsers] = React.useState(String(defaultTrialUsers(quote.seats)));
  const [saving, setSaving] = React.useState(false);

  // Fresh defaults each time it opens.
  React.useEffect(() => {
    if (open) { setDays(String(QUOTE_TRIAL_DAYS)); setUsers(String(defaultTrialUsers(quote.seats))); }
  }, [open, quote.seats]);

  const nDays  = Number(days);
  const nUsers = Number(users);
  const daysOk  = validTrialDays(nDays);
  const usersOk = Number.isInteger(nUsers) && nUsers >= 1;
  const warning = usersOk ? trialUsersWarning(nUsers) : null;
  const plan = daysOk && usersOk
    ? planQuoteTrial({ now: new Date(), days: nDays, users: nUsers, company: quote.customer_name, quoteId: quote.id })
    : null;

  const onSave = async () => {
    if (!plan || !ownerId) return;
    setSaving(true);
    try {
      const res = await startTrialFromQuote(createClient(), { quote, lead, customer, days: nDays, users: nUsers, ownerId });
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["leads"] }),
        qc.invalidateQueries({ queryKey: ["trials"] }),
        qc.invalidateQueries({ queryKey: ["tasks"] }),
        qc.invalidateQueries({ queryKey: ["quotes", quote.id] }),
      ]);
      if (res.tasksCreated === 0) {
        toast.warning(`Trial started, ends ${formatIstDate(res.endDate)}. The 3 reminder tasks could not be saved.`, {
          description: "Add them from Tasks so the payment follow-up is not missed.",
        });
      } else {
        toast.success(`Trial started · ends ${formatIstDate(res.endDate)} · ${res.tasksCreated} tasks added`);
      }
      onOpenChange(false);
    } catch (err) {
      toastError(err, { fallback: "Could not start the trial.", description: "Nothing was changed on the quote. Try again." });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-[480px] p-0 flex flex-col overflow-x-hidden">
        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4">
          <header className="border-b border-hairline pb-3 mb-4">
            <p className="text-3xs uppercase tracking-wider font-semibold text-amber-ink mb-1">{quote.id}</p>
            <SheetTitle className="font-serif text-2xl text-ink">Start trial, pay later</SheetTitle>
            <SheetDescription className="text-xs text-ink-3 mt-1">
              {quote.customer_name} accepted this quote. Give them a trial now; payment is due the day it ends.
            </SheetDescription>
          </header>

          <div className="grid grid-cols-2 gap-3 mb-2">
            <div>
              <Label htmlFor="quote-trial-days">Days</Label>
              <Input
                id="quote-trial-days" type="number" inputMode="numeric"
                min={QUOTE_TRIAL_MIN_DAYS} max={QUOTE_TRIAL_MAX_DAYS}
                value={days} onChange={(e) => setDays(e.target.value)} className="font-mono"
                aria-invalid={!daysOk}
              />
              {!daysOk && <p className="text-xs text-rose mt-1">{QUOTE_TRIAL_MIN_DAYS}–{QUOTE_TRIAL_MAX_DAYS} days.</p>}
            </div>
            <div>
              <Label htmlFor="quote-trial-users">Users</Label>
              <Input
                id="quote-trial-users" type="number" inputMode="numeric" min={1}
                value={users} onChange={(e) => setUsers(e.target.value)} className="font-mono"
                aria-invalid={!usersOk} aria-describedby={warning ? "quote-trial-users-warning" : undefined}
              />
              {!usersOk && <p className="text-xs text-rose mt-1">At least 1 user.</p>}
            </div>
          </div>
          {warning && (
            <p id="quote-trial-users-warning" role="status" className="flex items-start gap-1.5 rounded-md border border-amber/60 bg-amber-soft p-2.5 text-xs text-amber-ink mb-3">
              <Icon name="alert" size={14} className="mt-px shrink-0" /> {warning}
            </p>
          )}

          {plan && (
            <div className="bg-paper-2 rounded-md p-3 mt-3 text-xs text-ink-2 leading-relaxed">
              <p>
                Trial <b>{formatIstDate(plan.startDate)}</b> to <b>{formatIstDate(plan.endDate)}</b>.
                {" "}Payment due <b>{formatIstDate(plan.endDate)}</b>. The quote stays accepted.
              </p>
              <p className="font-medium text-ink-2 mt-2 mb-1">Tasks for you:</p>
              <ul className="space-y-0.5 text-ink-3">
                {plan.tasks.map((t) => (
                  <li key={t.title}>
                    {formatIstDate(toIstDate(t.due_at))} · {t.title.replace(/ · .*$/, "")}
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-ink-3">Nothing is sent to the customer and nothing is suspended automatically.</p>
            </div>
          )}
        </div>

        <SheetFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
          <Button variant="primary" icon="check_circle" onClick={onSave} disabled={!plan || !ownerId || saving} loading={saving}>
            Start {daysOk ? `${nDays}-day ` : ""}trial
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

