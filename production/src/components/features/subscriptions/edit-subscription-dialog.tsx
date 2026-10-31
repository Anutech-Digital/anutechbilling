/**
 * EditSubscriptionDialog — correct a subscription's details (data-entry fix).
 *
 * For fixing a mis-typed plan / vendor / seats / price / dates / status on a
 * subscription. It only updates the subscription record — it does NOT re-bill
 * or touch the linked payment / quote / invoice. To remove a whole subscription
 * that was created by mistake, use Delete (which is blocked when it came from a
 * paid quote — fix that at the source by deleting the payment).
 */
"use client";

import * as React from "react";

import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { FormField } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import {
  useUpdateSubscription, useCorrectSubscriptionTerms, useCorrectSubscriptionCommitment, useScheduleInvoices,
} from "@/lib/queries/subscriptions";
import {
  COMMITMENT_OPTIONS, THREE_YEAR_OPTION, FREQUENCY_LABEL, catalogCostPerSeatMonth, commitmentLabel, commitmentOf,
  commitmentRenewal, commitmentVerdict, frequenciesFor,
} from "@/lib/subscriptions/commitment-change";
import { BILLING_CYCLE_INVOICES_PER_YEAR as PARTS_PER_YEAR, type BillingCycle } from "@/lib/supabase/database.types";
import { useItems } from "@/lib/queries/items";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { subscriptionProducts, productsForVendor } from "@/lib/subscriptions/catalog-options";
import { cleanDomain } from "./duplicate-subscription";
import {
  correctionVerdict, mrrForSeats, seatCutWarning, MIN_CORRECTION_REASON,
} from "@/lib/subscriptions/correct-terms";
import { subscriptionSchedule } from "@/lib/billing/subscription-schedule";
import { scheduleInvoices } from "./schedule-invoices";
import { formatDate, rupee } from "@/lib/utils";
import Link from "next/link";
import { MIN_SUSPEND_REASON, useSuspendSubscription } from "./suspend-subscription-dialog";
import type { Subscription } from "@/lib/supabase/database.types";
import { checkNceLock, lockWarning } from "@/lib/subscriptions/nce-lock";
import { Icon } from "@/components/ui/icon";
import { toast } from "sonner";
/* Reused rather than rewritten. termEndInclusive carries both the month clamp (31 Jan
   + 1 month is 28 Feb, not 3 March) and the "last covered day" rule the column holds
   since 11 Sep 2026; nextTermStart is its inverse; monthsBetween because a term is
   calendar months, not 30-day arithmetic. */
import { termEndInclusive, nextTermStart } from "@/lib/billing/schedule";
import { monthsBetween } from "@/lib/accounting/saas-charts";
import { istToday } from "@/lib/dates/ist";

const VENDORS: Subscription["vendor"][] = ["google", "microsoft", "zoho", "other"];
/** R-1684: the Plan box value for "keep the plan as recorded" (not in the catalog). */
const KEEP = "__keep__";
const STATUSES: Subscription["status"][] = ["active", "paused", "expired", "cancelled"];
/** R-2095: native select, styled like the inputs (the same class the bank reconcile sale uses). */
const SELECT_CLS =
  "w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-amber/40 disabled:opacity-70";

export function EditSubscriptionDialog({
  sub, open, onOpenChange,
}: {
  sub: Subscription;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const update = useUpdateSubscription();
  const suspend = useSuspendSubscription();
  /* R-1684: seats / plan / price go through correct_subscription_terms (reason, role, catalog). */
  const correctTerms = useCorrectSubscriptionTerms();
  /* R-2095: commitment (term_months) and payment frequency (billing_cycle) go through correct_subscription_commitment. */
  const correctCommitment = useCorrectSubscriptionCommitment();
  const { data: me } = useCurrentUser();
  const { data: items } = useItems();
  const products = React.useMemo(() => subscriptionProducts(items ?? []), [items]);
  const { data: termInv } = useScheduleInvoices(open ? sub : null);

  /* R-1684: the plan is a catalog row (items.id), never typed text. KEEP = the record's own plan
     when it is not (or no longer) in the catalog — left exactly as it is. */
  const [itemId, setItemId]   = React.useState<string>(sub.item_id ?? KEEP);
  const [mrrTouched, setMrrTouched] = React.useState(false);
  const [reason, setReason]   = React.useState("");
  const [vendor, setVendor]   = React.useState<Subscription["vendor"]>(sub.vendor);
  /* R-2095: the domain the service runs on — a typo (tattvaspa.com for .org) blocked the real one. */
  const [domain, setDomain]   = React.useState(sub.domain ?? "");
  const [seats, setSeats]     = React.useState(String(sub.seats));
  const [mrr, setMrr]         = React.useState(String(sub.mrr));
  const [startDate, setStart] = React.useState(sub.start_date ?? "");
  const [renewal, setRenewal] = React.useState(sub.renewal_date ?? "");
  /** Postpaid credit clock. Editable HERE because every subscription created before
   *  10 Sep 2026 has none — and money owed with no agreed date shows no countdown at
   *  all, which is the exact silence the countdown was built to end. This is the one
   *  screen that can give those rows a date. */
  const [paymentDue, setPaymentDue] = React.useState(sub.payment_due_date ?? "");
  const [status, setStatus]   = React.useState<Subscription["status"]>(sub.status);
  /* R-1681: pausing here asks why (and whether it is for an unpaid invoice), like Payments. */
  const [pauseReason, setPauseReason] = React.useState("");
  const [pauseForUnpaid, setPauseForUnpaid] = React.useState((sub.outstanding_amount ?? 0) > 0);
  /* R-2095: the commitment (term_months) and the payment frequency (billing_cycle) as recorded. */
  const termNow = Math.max(1, sub.term_months ?? 12);
  const cycleNow = (sub.billing_cycle ?? "yearly") as BillingCycle;
  const [termNext, setTermNext] = React.useState(termNow);
  const [cycleNext, setCycleNext] = React.useState<BillingCycle>(cycleNow);

  // Re-seed when a different subscription is opened.
  React.useEffect(() => {
    setTermNext(Math.max(1, sub.term_months ?? 12)); setCycleNext((sub.billing_cycle ?? "yearly") as BillingCycle);
    setItemId(sub.item_id ?? KEEP); setMrrTouched(false); setReason("");
    setVendor(sub.vendor); setSeats(String(sub.seats)); setDomain(sub.domain ?? "");
    setMrr(String(sub.mrr)); setStart(sub.start_date ?? ""); setRenewal(sub.renewal_date ?? "");
    setStatus(sub.status); setPaymentDue(sub.payment_due_date ?? "");
    setPauseReason(""); setPauseForUnpaid((sub.outstanding_amount ?? 0) > 0);
  }, [sub]);

  const pausing = status === "paused" && sub.status !== "paused";
  const pauseReasonOk = pauseReason.trim().length >= MIN_SUSPEND_REASON;

  /**
   * How long THIS subscription's term is, in months — read off the record itself.
   *
   * ─── WHY NOT JUST 12 ───────────────────────────────────────────────────────
   * Flex subscriptions have a one-month term. Hardcoding a year here would turn a
   * corrected start date on a monthly plan into an annual commitment, silently, in the
   * one dialog whose whole promise is "corrects the record only".
   *
   * The record's OWN start→renewal gap is preferred over `term_months` on purpose:
   * this dialog wrote neither column until 9 Sep 2026, so every row created before that
   * carries the database default of 12 regardless of what was actually sold. The dates
   * are what the operator can see and is correcting; the column may be fiction.
   */
  const recordTermMonths = React.useMemo(() => {
    if (sub.start_date && sub.renewal_date) {
      /* Measured to the day AFTER the stored date, because the stored date is the last
         covered day. Without the +1 a term starting on the 1st reads a month short:
         1 Sep 2026 → 31 Aug 2027 is calendar-month 11, and correcting the start would
         then quietly shorten an annual subscription to eleven months. */
      const gap = monthsBetween(new Date(`${sub.start_date}T00:00:00Z`),
                                new Date(`${nextTermStart(sub.renewal_date)}T00:00:00Z`));
      if (gap > 0) return gap;
    }
    return sub.term_months && sub.term_months > 0 ? sub.term_months : 12;
  }, [sub.start_date, sub.renewal_date, sub.term_months]);

  /**
   * Correcting the start date moves the renewal date with it, keeping the term the same
   * length.
   *
   * Reported 9 Sep 2026: fixing a mis-typed start left the renewal untouched, so a
   * subscription that began a week earlier than recorded silently gained a week of term
   * — and the renewal cron bills from the renewal date, so nothing would have flagged it.
   *
   * Still editable afterwards: a correction sometimes needs both dates set independently,
   * and this is a default rather than a rule.
   */
  const changeStart = (next: string) => {
    setStart(next);
    if (!next) return;
    /* R-2095: a changed commitment sets the term length; otherwise the record's own. */
    setRenewal(termEndInclusive(next, termNext !== termNow ? termNext : recordTermMonths));
  };

  /* R-2095 follow-up: a renewed sub keeps its first start date, so its start→renewal span is
     several terms (a Flexible sub rolled 15 Jun → 14 Nov read "keeping the term 5 months long").
     When the span is longer than the stored term, name the commitment instead; the renewal still
     moves with the start by the same span. */
  const startHint = sub.term_months != null && sub.term_months > 0 && recordTermMonths > sub.term_months
    ? `${commitmentLabel(sub.term_months)} — the renewal date moves with it.`
    : `Renewal follows, keeping the term ${recordTermMonths === 1 ? "one month" : `${recordTermMonths} months`} long.`;

  /* ── R-2095: commitment (term_months) and payment frequency (billing_cycle) ─────────── */
  const commitNext = commitmentOf(termNext);
  const commitChoices = commitmentOf(termNow) === "three_year" ? [...COMMITMENT_OPTIONS, THREE_YEAR_OPTION] : COMMITMENT_OPTIONS;
  const freqChoices = frequenciesFor(commitNext);
  const commitVerdict = commitmentVerdict({
    role: me?.role, termMonthsNow: termNow, termMonthsNext: termNext, cycleNow, cycleNext,
    startDate: sub.start_date, renewalDate: sub.renewal_date, today: istToday(), fmt: formatDate,
  });
  const item = React.useMemo(() => (items ?? []).find((i) => i.id === sub.item_id), [items, sub.item_id]);
  const costNext = termNext !== termNow && !sub.vendor_synced_at ? catalogCostPerSeatMonth(item, termNext) : null;
  const changeCommitment = (months: number) => {
    setTermNext(months);
    const allowed = frequenciesFor(commitmentOf(months));
    if (!allowed.includes(cycleNext)) setCycleNext(allowed.includes(cycleNow) ? cycleNow : allowed[0]);
    /* Renewal per the inclusive rule, counted from the start; back to the record's own when undone. */
    setRenewal(months === termNow
      ? (sub.renewal_date ?? "")
      : commitmentRenewal({ startDate: sub.start_date, renewalDate: sub.renewal_date, termMonthsNow: termNow, termMonthsNext: months, today: istToday() }) ?? "");
  };

  /* Microsoft NCE: seats cannot be reduced and the subscription cannot be
     cancelled more than 7 days after the term starts. Checked against the values
     being SAVED, not the ones on the record, and re-evaluated as the operator
     types so the refusal appears before they press the button rather than after. */
  const nextSeats = Math.max(0, Math.round(Number(seats) || 0));
  const nceCheck = checkNceLock({
    vendor,
    startDate:    startDate || sub.start_date,
    /* R-025. UTC "today" is yesterday before 05:30 IST, and this feeds the Microsoft NCE
       7-day cancellation window — so early in the morning the guard measured one day
       fewer than had actually passed and let through a cancellation NCE would refuse. */
    today:        istToday(),
    currentSeats: sub.seats,
    nextSeats,
    nextStatus:   status,
  });
  const nceHeadsUp = lockWarning({
    vendor,
    startDate:    startDate || sub.start_date,
    today:        istToday(),        // R-025 — same window, same trap.
    currentSeats: sub.seats,
    nextSeats:    sub.seats,
    nextStatus:   "active",
  });

  /* ── R-1684: seats / plan / price ─────────────────────────────────────────── */
  const nextMrr = Math.max(0, Math.round(Number(mrr) || 0));
  const planChoices = React.useMemo(() => productsForVendor(products, vendor), [products, vendor]);
  /* The record's own plan stays choosable when it is not one of this vendor's catalog rows. */
  const recordedInList = !!sub.item_id && planChoices.some((p) => p.id === sub.item_id);
  const keepLabel = recordedInList ? null : sub.plan;
  const planValue = planChoices.some((p) => p.id === itemId) ? itemId : KEEP;
  const nextItem = planValue === KEEP ? null : planValue;
  const verdict = correctionVerdict({
    role: me?.role, seatsNow: sub.seats, seatsNext: nextSeats, mrrNow: sub.mrr, mrrNext: nextMrr,
    itemNow: sub.item_id ?? null, itemNext: nextItem ?? sub.item_id ?? null,
    termMonths: sub.term_months, startDate: sub.start_date, renewalDate: sub.renewal_date, today: istToday(),
  });
  const reasonOk = reason.trim().length >= MIN_CORRECTION_REASON;
  /* The invoice of the term being cut — where a credit note gives money back (the next step). */
  const termInvoice = React.useMemo(() => {
    const periods = subscriptionSchedule(sub);
    const m = scheduleInvoices({
      periods, startDate: sub.start_date, saleInvoice: termInv?.sale ?? null,
      instalments: termInv?.instalments ?? [], renewals: termInv?.renewals ?? [],
    });
    return periods.length > 0 ? m.get(periods[0].index)?.invoiceId ?? null : null;
  }, [sub, termInv]);

  const changeSeats = (v: string) => {
    setSeats(v);
    /* MRR follows the seats at this subscription's own per-seat price, unless a price was typed. */
    if (!mrrTouched) setMrr(String(mrrForSeats(sub.mrr, sub.seats, Math.max(0, Math.round(Number(v) || 0)))));
  };

  const save = async () => {
    if (verdict.roleBlock) {
      toast.error("Not allowed for your role", { description: verdict.roleBlock });
      return;
    }
    if (verdict.changed && !reasonOk) {
      toast.error("Write why the seats, plan or price are changing", { description: "The reason is kept in the subscription's change history." });
      return;
    }
    if (commitVerdict.block || commitVerdict.roleBlock) {
      toast.error("Commitment cannot be changed", { description: commitVerdict.block ?? commitVerdict.roleBlock ?? undefined });
      return;
    }
    if (commitVerdict.changed && !reasonOk) {
      toast.error("Write why the commitment or payment frequency is changing", { description: "The reason is kept in the subscription's change history." });
      return;
    }
    /* Refuse here as well as disabling the button. A disabled button is a hint;
       this is the actual guard, and it survives a stale render or an operator who
       reaches the handler another way. */
    if (nceCheck.locked) {
      toast.error("Microsoft NCE lock", { description: nceCheck.reason });
      return;
    }
    if (pausing && !pauseReasonOk) {
      toast.error("Write why it is being paused", { description: "The reason is kept in the activity log. Fill it in under Status, then save." });
      return;
    }
    try {
      if (verdict.changed) {
        await correctTerms.mutateAsync({ id: sub.id, itemId: nextItem, seats: nextSeats, mrr: nextMrr, reason: reason.trim() });
      }
      if (commitVerdict.changed) {
        await correctCommitment.mutateAsync({
          id: sub.id, termMonths: termNext, billingCycle: cycleNext,
          renewalDate: termNext !== termNow ? (renewal || null) : null, reason: reason.trim(),
        });
      }
      await update.mutateAsync({
        id: sub.id,
        patch: {
          vendor,
          /* R-2095: cleaned like the Onboard dialog; blank keeps the recorded one. */
          domain:       cleanDomain(domain.trim()) || sub.domain || null,
          start_date:   startDate || null,
          renewal_date: renewal || null,
          /* Blank CLEARS it here, unlike the onboarding dialog which defaults an empty
             box to start + 30. The difference is deliberate: onboarding is agreeing new
             credit terms, so a date is always meant; this screen is correcting a record,
             and an operator who empties the field means "there is no agreed date" —
             inventing one would put a countdown against terms nobody set. */
          payment_due_date: paymentDue || null,
          /* A pause goes through suspend_subscription below (reason + unpaid invoice). */
          status: pausing ? sub.status : status,
        },
      });
      if (pausing) {
        await suspend.mutateAsync({ id: sub.id, reason: pauseReason, forUnpaid: pauseForUnpaid });
      }
      onOpenChange(false);
    } catch { /* hook toasts */ }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="md:!max-w-md">
        <DialogHeader>
          <DialogTitle>Correct subscription</DialogTitle>
          <DialogDescription>
            Fix mis-typed details on {sub.customer_name}&apos;s subscription. This corrects the
            record only — it doesn&apos;t re-bill or change the linked payment / invoice.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <FormField label="Plan" htmlFor="sub_plan">
            {/* R-1684: from the catalog (Items) — never typed text. */}
            <Select value={planValue} onValueChange={setItemId}>
              <SelectTrigger id="sub_plan"><SelectValue /></SelectTrigger>
              <SelectContent>
                {keepLabel !== null && <SelectItem value={KEEP}>{keepLabel} (as recorded)</SelectItem>}
                {planChoices.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
              </SelectContent>
            </Select>
            {planChoices.length === 0 && (
              <p className="mt-1 text-2xs leading-snug text-ink-3">
                No {vendor} plans in your catalog. Add the product under <Link href={"/items" as never} className="underline">Items</Link> to switch to it.
              </p>
            )}
          </FormField>

          <FormField label="Domain" htmlFor="sub_domain">
            <Input id="sub_domain" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="e.g. acme.com" />
            {cleanDomain(domain) !== cleanDomain(sub.domain) && cleanDomain(domain) !== "" && (
              <p className="mt-1 text-2xs leading-snug text-ink-3">Corrects the record from {sub.domain || "no domain"} to {cleanDomain(domain)} — nothing is billed.</p>
            )}
          </FormField>

          {/* R-2095: commitment and payment frequency — the two facts a new subscription is sold with. */}
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Commitment" htmlFor="sub_commitment">
              <select id="sub_commitment" value={String(termNext)} onChange={(e) => changeCommitment(Number(e.target.value))} className={SELECT_CLS}>
                {commitChoices.map((c) => <option key={c.months} value={String(c.months)}>{c.label}</option>)}
              </select>
            </FormField>
            <FormField label="Payment frequency" htmlFor="sub_frequency">
              <select id="sub_frequency" value={cycleNext} disabled={freqChoices.length === 1}
                onChange={(e) => setCycleNext(e.target.value as BillingCycle)} className={SELECT_CLS}>
                {freqChoices.map((f) => <option key={f} value={f}>{FREQUENCY_LABEL[f]}</option>)}
              </select>
            </FormField>
          </div>
          {commitNext === "flex"
            ? <p className="-mt-2 text-2xs leading-snug text-ink-3">Flexible is paid monthly only. An annual commitment can be paid monthly, quarterly, half-yearly or yearly.</p>
            : termNext !== termNow || cycleNext !== cycleNow
              ? <p className="-mt-2 text-2xs leading-snug text-ink-3">Renews at the end of the {termNext === 36 ? "3-year" : "12-month"} commitment — paid {FREQUENCY_LABEL[cycleNext].toLowerCase()}, {PARTS_PER_YEAR[cycleNext] * (termNext === 36 ? 3 : 1)} {PARTS_PER_YEAR[cycleNext] * (termNext === 36 ? 3 : 1) === 1 ? "payment" : "payments"}.</p>
              : null}
          {termNext !== termNow && (
            <p data-testid="commitment-cost" className="-mt-2 text-2xs leading-snug text-ink-2">
              {sub.vendor_synced_at
                ? `Licence cost stays ${sub.vendor_cost_per_seat_month != null ? rupee(sub.vendor_cost_per_seat_month) : "as recorded"}/seat/month — it is confirmed from the vendor's bill.`
                : costNext != null
                  ? `Licence cost ${sub.vendor_cost_per_seat_month != null ? `${rupee(sub.vendor_cost_per_seat_month)} → ` : ""}${rupee(costNext)}/seat/month (catalogue, ${commitNext === "flex" ? "Flexible" : "annual"} price). Seats, selling price, domain and start stay as they are.`
                  : "The catalogue has no cost for this commitment — the licence cost stays as recorded."}
            </p>
          )}
          {(commitVerdict.block || (commitVerdict.changed && commitVerdict.roleBlock)) && (
            <p role="alert" className="rounded-md border border-rose/50 bg-rose-soft/40 p-3 text-xs leading-relaxed text-ink-2">
              {commitVerdict.block ?? commitVerdict.roleBlock}
            </p>
          )}

          <div className="grid grid-cols-2 gap-3">
            <FormField label="Vendor" htmlFor="sub_vendor">
              <Select value={vendor} onValueChange={(v) => setVendor(v as Subscription["vendor"])}>
                <SelectTrigger id="sub_vendor"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {VENDORS.map((v) => <SelectItem key={v} value={v}>{v}</SelectItem>)}
                </SelectContent>
              </Select>
            </FormField>
            <FormField label="Status" htmlFor="sub_status">
              <Select value={status} onValueChange={(v) => setStatus(v as Subscription["status"])}>
                <SelectTrigger id="sub_status"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {STATUSES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                </SelectContent>
              </Select>
            </FormField>
          </div>

          {pausing && (
            <div className="space-y-2 rounded-md border border-amber/50 bg-amber-soft/30 p-3">
              <FormField label="Why is it being paused?" htmlFor="sub_pause_reason" required>
                <Textarea id="sub_pause_reason" rows={2} value={pauseReason} onChange={(e) => setPauseReason(e.target.value)} placeholder="Invoice unpaid for 30+ days" />
              </FormField>
              {!pauseReasonOk && <p className="text-2xs text-ink-3">Needed to save — the reason is kept in the activity log.</p>}
              <label className="flex items-start gap-2 text-sm text-ink-2">
                <Checkbox id="sub_pause_for_unpaid" checked={pauseForUnpaid} onCheckedChange={(v) => setPauseForUnpaid(v === true)} className="mt-0.5" />
                <span>
                  Paused because an invoice is unpaid
                  <span className="block text-2xs text-ink-3">When that invoice is paid it turns back on by itself.</span>
                </span>
              </label>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <FormField label="Seats" htmlFor="sub_seats">
              <Input id="sub_seats" type="number" min={0} step={1} value={seats} onChange={(e) => changeSeats(e.target.value)} />
            </FormField>
            <FormField label="MRR (₹ / month)" htmlFor="sub_mrr">
              <Input id="sub_mrr" type="number" min={0} step={1} value={mrr} onChange={(e) => { setMrrTouched(true); setMrr(e.target.value); }} />
              {!mrrTouched && nextSeats !== sub.seats && (
                <p className="mt-1 text-2xs leading-snug text-ink-3">Follows the seats at this subscription&apos;s own price per seat.</p>
              )}
            </FormField>
          </div>

          {/* R-1684: a seat cut inside a running annual term — what it does to money, and the next step. */}
          {verdict.midTermCommitmentCut && (
            <div role="alert" className="space-y-2 rounded-md border border-rose/50 bg-rose-soft/40 p-3">
              <p className="text-xs leading-relaxed text-ink-2">
                {seatCutWarning({ seatsNow: sub.seats, seatsNext: nextSeats, renewalDate: sub.renewal_date, fmt: formatDate })}
              </p>
              {termInvoice && (
                <Link href={`/invoices/${encodeURIComponent(termInvoice)}` as never} className="inline-block text-xs font-semibold text-ink underline underline-offset-2 hover:text-amber-ink">
                  Next step: open {termInvoice} to issue a credit note
                </Link>
              )}
            </div>
          )}

          {(verdict.changed || commitVerdict.changed) && (
            <FormField
              label={verdict.changed && commitVerdict.changed ? "Why are these details changing?"
                : verdict.changed ? "Why are the seats, plan or price changing?" : "Why are the commitment or payment frequency changing?"}
              htmlFor="sub_correct_reason" required>
              <Textarea id="sub_correct_reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={verdict.changed ? "Customer removed 5 users; credit note issued" : "Annual commitment paid monthly; was booked as Flexible"} />
              {!reasonOk && <p className="mt-1 text-2xs text-ink-3">Needed to save — kept in the subscription&apos;s change history.</p>}
            </FormField>
          )}
          {verdict.roleBlock && (
            <p className="rounded-md border border-rose/50 bg-rose-soft/40 p-3 text-xs leading-relaxed text-ink-2">{verdict.roleBlock}</p>
          )}

          <div className="grid grid-cols-2 gap-3">
            <FormField label="Start date" htmlFor="sub_start">
              <Input id="sub_start" type="date" value={startDate} onChange={(e) => changeStart(e.target.value)} />
              <p className="mt-1 text-2xs leading-snug text-ink-3" data-testid="start-term-hint">
                {startHint}
              </p>
            </FormField>
            <FormField label="Renewal date" htmlFor="sub_renewal">
              <Input id="sub_renewal" type="date" value={renewal} onChange={(e) => setRenewal(e.target.value)} />
              <p className="mt-1 text-2xs leading-snug text-ink-3">
                Override it if the real term differs.
              </p>
            </FormField>
          </div>

          {/* Postpaid credit clock. Shown only when money is actually owed — a settled
              subscription has nothing to chase, and a date field on it would invite one
              to be set for no reason. This is the only screen that can give a date to
              the rows created before 10 Sep 2026, which is why the countdown on
              /subscriptions points here. */}
          {(sub.outstanding_amount ?? 0) > 0 && (
            <FormField label="Payment due date" htmlFor="sub_payment_due">
              <Input
                id="sub_payment_due"
                type="date"
                value={paymentDue}
                onChange={(e) => setPaymentDue(e.target.value)}
              />
              <p className="mt-1 text-2xs leading-snug text-ink-3">
                {paymentDue
                  ? "Drives the countdown and the overdue highlight on Subscriptions."
                  : "No agreed date — this subscription shows no countdown. Set one to start the clock."}
              </p>
            </FormField>
          )}
        </div>

        {/* The refusal, in full, where the decision is being made — not as a toast
            that disappears. It names the two things the operator CAN do (§24). */}
        {nceCheck.locked && (
          <div className="flex items-start gap-2 rounded-md border border-rose/50 bg-rose-soft/40 p-3">
            <Icon name="lock" size={15} className="mt-0.5 flex-shrink-0 text-rose" />
            <p className="text-xs leading-relaxed text-ink-2">{nceCheck.reason}</p>
          </div>
        )}

        {/* The heads-up, while it is still allowed. A wall on day 7 with silence on
            day 5 is a bad trade for someone who never knew a deadline existed. */}
        {!nceCheck.locked && nceHeadsUp && (
          <div className="flex items-start gap-2 rounded-md border border-amber/50 bg-amber-soft/40 p-3">
            <Icon name="clock" size={15} className="mt-0.5 flex-shrink-0 text-amber-ink" />
            <p className="text-xs leading-relaxed text-amber-ink">{nceHeadsUp}</p>
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="default" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            type="button" variant="primary" loading={update.isPending || suspend.isPending || correctTerms.isPending || correctCommitment.isPending}
            disabled={nceCheck.locked || !!verdict.roleBlock || !!commitVerdict.block || (commitVerdict.changed && !!commitVerdict.roleBlock)}
            onClick={save}
          >
            {nceCheck.locked ? "Blocked by NCE policy" : "Save changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
