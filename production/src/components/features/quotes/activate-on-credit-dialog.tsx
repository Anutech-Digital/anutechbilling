/**
 * R-346 — "Activate now, pay later" on an accepted, unpaid quote.
 *
 * One input: credit days (default = the customer's payment terms, else 15). Seats are the
 * quote's. Saving raises the GST invoice due on that day, switches every recurring line's
 * subscription on, and gives the owner three tasks — in ONE database transaction
 * (activate_quote_on_credit). Nothing is sent to the customer and nothing is ever suspended
 * automatically. Over the customer's credit limit only the owner can go ahead, with a tick.
 * Rules: lib/credit/activate-on-credit.ts.
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
import { rupee } from "@/lib/utils";
import { formatIstDate } from "@/lib/trials/start-from-quote";
import {
  CREDIT_MIN_DAYS, CREDIT_MAX_DAYS,
  defaultCreditDays, validCreditDays, planCredit, creditExposure, overLimitDecision,
  activateQuoteOnCredit, NeedsDatabaseUpdateError,
} from "@/lib/credit/activate-on-credit";
import { useCustomerOpenInvoices } from "@/lib/credit/queries";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  quote: { id: string; customer_name: string; amount: number; invoice_id: string | null; seats: number | null };
  customer: { id: string; name: string; payment_terms_days: number | null; credit_limit?: number | null };
  role: string | null | undefined;
}

export function ActivateOnCreditDialog({ open, onOpenChange, quote, customer, role }: Props) {
  const qc = useQueryClient();
  const initialDays = defaultCreditDays(customer.payment_terms_days);
  const [days, setDays] = React.useState(String(initialDays));
  const [approve, setApprove] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const { data: openInvoices, isLoading: loadingOwed, error: owedError } = useCustomerOpenInvoices(customer.id, open);

  React.useEffect(() => {
    if (open) { setDays(String(initialDays)); setApprove(false); }
  }, [open, initialDays]);

  const nDays = Number(days);
  const daysOk = validCreditDays(nDays);
  const plan = daysOk ? planCredit(new Date(), nDays) : null;
  const exposure = openInvoices
    ? creditExposure({ openInvoices, quoteAmount: quote.amount, quoteInvoiceId: quote.invoice_id, creditLimit: customer.credit_limit })
    : null;
  const decision = exposure ? overLimitDecision(exposure, role, rupee) : null;
  const blocked = decision?.kind === "refused" || (decision?.kind === "owner-approve" && !approve);
  const canSave = Boolean(plan) && Boolean(exposure) && !blocked && !saving;

  const onSave = async () => {
    if (!plan || !canSave) return;
    setSaving(true);
    try {
      const res = await activateQuoteOnCredit(createClient(), {
        quoteId: quote.id, days: nDays, approveOverLimit: decision?.kind === "owner-approve" && approve,
      });
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["quotes"] }),
        qc.invalidateQueries({ queryKey: ["invoices"] }),
        qc.invalidateQueries({ queryKey: ["subscriptions"] }),
        qc.invalidateQueries({ queryKey: ["tasks"] }),
        qc.invalidateQueries({ queryKey: ["credit"] }),
        qc.invalidateQueries({ queryKey: ["aging"] }),
      ]);
      if (res.alreadyActive) {
        toast.info("This quote was already active on credit — nothing new was created.");
      } else {
        toast.success(
          `Active on credit · invoice ${res.invoiceId ?? ""} due ${res.dueDate ? formatIstDate(res.dueDate) : formatIstDate(plan.dueDate)}`,
          { description: `${res.subscriptionsCreated} subscription${res.subscriptionsCreated === 1 ? "" : "s"} on · ${res.tasksCreated} tasks added for the owner.` },
        );
      }
      onOpenChange(false);
    } catch (err) {
      if (err instanceof NeedsDatabaseUpdateError) {
        toast.error(err.message);
      } else {
        toastError(err, { fallback: "Could not activate on credit.", description: "Nothing was created. Fix the reason above and try again." });
      }
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
            <SheetTitle className="font-serif text-2xl text-ink">Activate now, pay later</SheetTitle>
            <SheetDescription className="text-xs text-ink-3 mt-1">
              {customer.name} accepted this quote. Switch the subscription on now; the GST invoice is due after the credit days.
            </SheetDescription>
          </header>

          <div className="grid grid-cols-2 gap-3 mb-2">
            <div>
              <Label htmlFor="credit-days">Credit days</Label>
              <Input
                id="credit-days" type="number" inputMode="numeric"
                min={CREDIT_MIN_DAYS} max={CREDIT_MAX_DAYS}
                value={days} onChange={(e) => setDays(e.target.value)} className="font-mono"
                aria-invalid={!daysOk}
              />
              {!daysOk && <p className="text-xs text-rose mt-1">{CREDIT_MIN_DAYS}–{CREDIT_MAX_DAYS} days.</p>}
            </div>
            <div>
              <Label htmlFor="credit-seats">Seats</Label>
              <output id="credit-seats" className="h-9 flex items-center font-mono text-sm text-ink">{quote.seats ?? "As on quote"}</output>
            </div>
          </div>

          {plan && (
            <div className="bg-paper-2 rounded-md p-3 mt-3 text-xs text-ink-2 leading-relaxed">
              <p>
                GST invoice for <b>{rupee(quote.amount)}</b> today, due <b>{formatIstDate(plan.dueDate)}</b>.
                {" "}Subscriptions are active from today.
              </p>
              <p className="font-medium text-ink-2 mt-2 mb-1">Tasks for the owner:</p>
              <ul className="space-y-0.5 text-ink-3">
                {plan.tasks.map((t) => (
                  <li key={t.title}>{formatIstDate(t.day)} · {t.title}</li>
                ))}
              </ul>
              <p className="mt-2 text-ink-3">Nothing is sent to the customer and nothing is suspended automatically.</p>
            </div>
          )}

          {/* Credit limit */}
          <div className="mt-3 text-xs">
            {loadingOwed ? (
              <p className="text-ink-3">Checking what {customer.name} already owes…</p>
            ) : owedError || !exposure ? (
              <p className="text-rose">Could not read this customer&apos;s unpaid invoices, so the credit limit cannot be checked. Reopen and try again.</p>
            ) : (
              <p className="text-ink-3">
                Owed now {rupee(exposure.owed)} + this invoice {rupee(exposure.thisInvoice)} = <b className="text-ink-2">{rupee(exposure.total)}</b>
                {" "}· limit {rupee(exposure.limit)}
              </p>
            )}
            {decision?.kind === "refused" && (
              <p role="alert" className="flex items-start gap-1.5 rounded-md border border-rose/50 bg-rose-soft p-2.5 mt-2 text-rose">
                <Icon name="alert" size={14} className="mt-px shrink-0" /> {decision.reason}
              </p>
            )}
            {decision?.kind === "owner-approve" && (
              <label className="flex items-start gap-2 rounded-md border border-amber/60 bg-amber-soft p-2.5 mt-2 text-amber-ink cursor-pointer">
                <input
                  type="checkbox" className="mt-0.5 h-4 w-4 accent-[var(--amber)]"
                  checked={approve} onChange={(e) => setApprove(e.target.checked)}
                />
                <span>
                  <b>Approve over limit.</b> {rupee(exposure!.total)} is above the {rupee(exposure!.limit)} limit. Your approval is recorded on the quote.
                </span>
              </label>
            )}
          </div>
        </div>

        <SheetFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
          <Button variant="primary" icon="check_circle" onClick={onSave} disabled={!canSave} loading={saving}>
            Activate on credit
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
