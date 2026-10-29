/**
 * RecordPaymentDialog — log a received payment against a quote.
 *
 * Triggered from quote detail when payment_status = 'awaiting'.
 * Marks payment_status = 'received', stores method + reference + amount.
 */
"use client";

import * as React from "react";
import { useForm, type UseFormReturn } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { invalidateReceivables } from "@/lib/queries/receivables-refresh";
import { toast } from "sonner";
import { isSubscriptionLine, type QuoteLine } from "@/lib/subscriptions/orphan-quote";
import {
  DEFAULT_PAYMENT_METHOD,
  PAYMENT_METHODS,
  type PaymentMethod,
} from "@/lib/payments/deposit-accounts";
import {
  PAYMENT_FIELD_LABELS,
  ReceivedInField,
  referenceHint,
  referenceLabel,
  referencePlaceholder,
  useReceivedInDefault,
} from "@/components/features/payments/payment-entry-fields";
import { domainSetupLine, fillCustomerStateFromQuote, stampPaymentDomain } from "@/lib/payments/after-payment-fill";
import { FeedbackDialog } from "@/components/shared/feedback-dialog";
import { ConsequenceList } from "@/components/shared/consequence-list";
import { recordPaymentConsequences } from "@/lib/payments/record-consequences";
import { useDocumentSeries, useGenerateInvoice } from "@/lib/queries/invoices";
import { useRouter } from "next/navigation";
import { invoiceHref } from "@/app/(app)/invoices/invoice-href";
import { isPartRequest, partLabelOf, partRequestPaymentToast, partRequestTdsCheck } from "@/lib/billing/part-requests";
import { paymentToast, blankReference, subscriptionNoteFor, type PaymentToastAction, type SubscriptionNote } from "@/lib/payments/record-payment-toast";
import {
  invoiceNowOffer,
  paymentBuyerPlace,
  shouldIssueAfterPayment,
  withIssuedInvoice,
  type BuyerPlace,
} from "@/lib/payments/record-payment-invoice";
import { b2cGstinNudge, type B2cNudge } from "@/lib/payments/b2c-gstin-nudge";
import Link from "next/link";

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
import { FieldPill } from "@/components/ui/field-pill";
import { checkMoney, paymentRefProblem } from "@/lib/forms/poka-yoke";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { createClient } from "@/lib/supabase/client";
import type { SupabaseClient } from "@supabase/supabase-js";
import { rupee, formatDate } from "@/lib/utils";
import { fiscalYearFromDate, TDS_SECTIONS } from "@/lib/queries/tds-receivable";
import { checkTdsRate, tdsDefaultRatePct } from "@/lib/accounting/tds-rates";
import { paymentOutcome, tdsBase } from "@/lib/accounting/tds-receipt";
import { matchTdsShortfall, tdsShortfallLine, type TdsShortfallMatch } from "@/lib/accounting/tds-match";
import { istToday } from "@/lib/dates/ist";
import { domainConflictMessage } from "@/lib/quotes/payment-domain";
import { deskPaymentTagArgs, isReplayResult, replayToast } from "@/lib/payments/record-payment-replay";
import { instalmentPaymentLines, type InstalmentPaymentResult } from "@/lib/payments/instalment-payment";
import { splitExpectation, splitPaymentToast, splitOutcomeSentence, type SplitExpectation, type InstalmentRaiseResult } from "@/lib/payments/split-expected";
import { advanceToUse } from "@/lib/quotes/customer-advance";

const schema = z.object({
  /* R-449: ₹0 used to stop the form with no message — the browser's own min=1 check
     fired silently. The form is noValidate now and this says it. */
  /* R-1520: ₹0 in bank is allowed ONLY when TDS is ticked — "Record TDS" on a part-paid
     invoice, where the TDS alone settles the rest (record_payment_with_tds, net_paid 0).
     Without TDS the old "more than ₹0" rule stands (checked in superRefine below). */
  amount:       z.coerce.number({ invalid_type_error: "Enter the amount received." }).int("Whole rupees only — no paise.").min(0, "Amount cannot be negative."),
  method:       z.string().min(1, "Method required"),
  // R-248: cash may be left blank — it is saved as cashReference() (date + IST time).
  reference:    z.string(),
  receivedDate: z.string().min(1, "Payment date required"),
  notes:        z.string().optional(),
  // Optional — the customer's domain (Google Workspace / M365 subscriptions need
  // it). Stamped onto the subscription that record_payment creates.
  domain:       z.string().optional(),
  // TDS fields — only validated when tdsDeducted is true (handled in submit)
  tdsDeducted:  z.boolean().optional(),
  tdsSection:   z.string().optional(),
  tdsRatePct:   z.coerce.number().min(0).max(100).optional(),
  customerTan:  z.string().optional(),
  /* R-2023: the customer's advance used on this bill ("Use advance"). Set by the sheet, not typed
     here. With it, ₹0 in bank is fine — the advance alone may pay the bill. */
  creditApplied: z.coerce.number().min(0).optional(),
}).superRefine((d, ctx) => {
  if (d.amount < 1 && !d.tdsDeducted && !((d.creditApplied ?? 0) > 0)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["amount"], message: "Amount must be more than ₹0." });
  }
  // Reference sanity — block junk like "dfg" / "asfdgdfgsdfgds". A real UTR /
  // txn id / cheque number always has digits; cash/other can be looser.
  const ref = d.reference.trim();
  const digital = d.method !== "cash" && d.method !== "other";
  /* R-1444: blank is fine for every method — filled on submit with blankReference(). */
  if (d.method === "cash" || !ref) return;
  /* R-449: UPI = 12 digits, bank UTR = 12–22 letters/digits (lib/forms/poka-yoke.ts). */
  const formatProblem = paymentRefProblem(d.method, ref);
  if (ref && formatProblem) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["reference"], message: formatProblem });
    return;
  }
  if (digital && (ref.length < 4 || !/\d/.test(ref))) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["reference"],
      message: "Enter a real UTR / transaction ID (letters + digits, e.g. 402312345678).",
    });
  } else if (!digital && ref.length < 2) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["reference"], message: "Reference too short." });
  }
});

type FormData = z.infer<typeof schema>;

/** Exported for tests only (R-819) — the same schema the sheet validates with. */
export { schema as recordPaymentSchema };
export type RecordPaymentFormData = FormData;

/**
 * R-1442: run `fill` once each time the sheet OPENS — never again while it stays open.
 * The fill effect used to depend on `remaining` and the customer's TDS defaults, which both
 * arrive after opening; each arrival reset the form and put a back-dated "Received on" (and
 * the typed reference) back to today's blank form. Late data now sets only its own fields.
 */
export function useFillOnOpen(open: boolean, fill: () => void): void {
  const wasOpen = React.useRef(false);
  const fillRef = React.useRef(fill);
  fillRef.current = fill;
  React.useEffect(() => {
    if (open && !wasOpen.current) fillRef.current();
    wasOpen.current = open;
  }, [open]);
}

/**
 * R-819: change the payment method and re-check the reference with the NEW method's rule.
 *
 * Abhishek, staging 10 Oct: UPI + "INDBH06054327633" → Confirm → "A UPI reference is 12
 * digits, numbers only" → switched to Bank transfer → the UPI message stayed under the Bank
 * UTR box. react-hook-form only re-validates a field when THAT field changes, and
 * setValue("method") did not touch "reference", so the old method's error was left behind.
 * Now the stale error is cleared, and if the form was already checked (or showed an error)
 * the reference is validated again right away with the current method's rule.
 */
export function applyPaymentMethod(
  form: Pick<UseFormReturn<FormData>, "setValue" | "clearErrors" | "trigger" | "getValues">,
  m: string,
  alreadyChecked: boolean,
): Promise<boolean> {
  form.setValue("method", m, { shouldDirty: true });
  form.clearErrors("reference");
  if (alreadyChecked && (form.getValues("reference") ?? "").trim()) return form.trigger("reference");
  return Promise.resolve(true);
}

/**
 * R-1520: the hint's one click — tick "Customer deducted TDS" and fill section + rate. The
 * bank amount the operator typed is left alone (it IS the bank amount once TDS is ticked).
 */
export function applyTdsSuggestion(
  form: Pick<UseFormReturn<FormData>, "setValue">,
  m: Pick<TdsShortfallMatch, "section" | "ratePct">,
): void {
  form.setValue("tdsDeducted", true, { shouldDirty: true });
  form.setValue("tdsSection", m.section, { shouldDirty: true });
  form.setValue("tdsRatePct", m.ratePct, { shouldDirty: true, shouldValidate: true });
}

/** R-2023: "Use advance — ₹X available" on the Record payment sheet. Ticked = the most that fits
 *  (the bill or the advance, whichever is less); the amount can be lowered to use only part. */
export function UseAdvanceBox({ available, checked, applied, onCheckedChange, onAmountChange }: {
  available: number;
  checked: boolean;
  applied: number;
  onCheckedChange: (v: boolean) => void;
  onAmountChange: (n: number | null) => void;
}) {
  return (
    <div className="rounded-md border border-emerald/30 bg-emerald-soft/40 px-3 py-2.5 text-xs">
      <label className="flex items-start gap-2 cursor-pointer">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={checked}
          onChange={(e) => onCheckedChange(e.target.checked)}
        />
        <div className="flex-1">
          <div className="font-medium text-ink">Use advance — {rupee(available)} available</div>
          <div className="text-ink-3 mt-0.5">
            {checked
              ? `${rupee(applied)} of the advance pays this bill — the customer pays that much less in cash.`
              : "This customer paid ahead (an advance or an earlier overpayment). Tick to use it on this bill."}
          </div>
        </div>
      </label>
      {checked && (
        <label className="mt-2 flex items-center gap-2 pl-5">
          <span className="text-ink-2">Use ₹</span>
          <input
            type="number"
            inputMode="numeric"
            min={0}
            step={1}
            aria-label="Advance to use (₹)"
            className="w-28 rounded border border-hairline bg-paper px-2 py-1 text-xs tabular-nums"
            value={applied}
            onChange={(e) => onAmountChange(e.target.value === "" ? 0 : Number(e.target.value))}
          />
          <span className="text-ink-3">{applied < available ? `${rupee(available - applied)} stays as advance` : "whole advance used"}</span>
        </label>
      )}
    </div>
  );
}

/** R-1520: "The remaining ₹25,500 may be TDS (194J 10%) — was TDS deducted?" + one button.
 *  Renders nothing without a match; never ticks anything by itself. */
export function TdsShortfallHint({ match, onApply }: { match: TdsShortfallMatch | null; onApply: () => void }) {
  if (!match) return null;
  return (
    <div
      role="status"
      data-testid="tds-shortfall-hint"
      className="rounded-md border border-amber/40 bg-amber-soft px-3 py-2 text-xs text-amber-ink flex flex-wrap items-center justify-between gap-2"
    >
      <span className="flex items-start gap-1.5 min-w-0">
        <Icon name="info" size={14} className="shrink-0 mt-0.5" />
        <span>{tdsShortfallLine(match)} — was TDS deducted?</span>
      </span>
      <Button type="button" size="sm" variant="outline" onClick={onApply}>
        Yes, TDS was deducted
      </Button>
    </div>
  );
}

/** Compute TDS amount = pre-GST gross × rate%. R-1119: GST is stripped at the quote's own
 *  rate (5% / 12% / 0% export), not a fixed 18%. */
function computeTds(quoteAmountInclGst: number, ratePct: number, taxRatePct: number | null): { preGST: number; tds: number } {
  const preGST = tdsBase(quoteAmountInclGst, taxRatePct);
  const tds    = Math.round(preGST * ratePct / 100);
  return { preGST, tds };
}

interface RecordPaymentDialogProps {
  /**
   * The quote's line items, used only to explain WHY no subscription was created.
   * Optional: without it the explanation falls back to a generic one rather than
   * blocking the dialog, because a missing prop must never stop a payment being recorded.
   */
  lineItems?: QuoteLine[] | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  quoteId: string;
  customerName: string;
  expectedAmount: number;
  /** Sum already received in prior payments (₹). Defaults to 0 for first payment. */
  alreadyReceived?: number;
  /** When true, this is a prospect quote — a customer record will be auto-created on full payment */
  isProspect?: boolean;
  /** Invoice ID already issued against this quote (if any) — drives correct footer messaging
   *  and signals "no new RV needed" since this payment is post-invoice. */
  invoiceId?: string | null;
  /**
   * R-1564: a subscription INSTALMENT invoice (no quote of its own). The sheet then expects
   * THIS invoice's amount (expectedAmount / alreadyReceived are the invoice's) and saves
   * through record_instalment_payment, which records the money on the subscription's quote
   * (quoteId) AND applies it to this invoice in one transaction — so it is never credited to
   * the next instalment while this one stays Pending.
   */
  instalmentInvoiceId?: string | null;
  /** Customer FK — used to fetch saved TAN + default TDS section/rate so the TDS section
   *  pre-fills correctly. Null for prospect quotes (no customer row yet). */
  customerId?: string | null;
  /** Show the optional Domain field (subscription quotes only — Google Workspace /
   *  M365 need the customer domain). Hidden for one-off / direct invoices. */
  askDomain?: boolean;
  /** R-453: a renewal quote — the sheet says the existing subscription is renewed. */
  isRenewal?: boolean;
  /** R-2087: a support-plan upgrade quote — the sheet says the plan is upgraded, not renewed. */
  isUpgrade?: boolean;
  /** Pre-fill the domain field (e.g. from the customer/lead's known domain). */
  defaultDomain?: string | null;
  /**
   * R-1520 "Record TDS": open with "Customer deducted TDS" already ticked at this section +
   * rate, method Other, ₹0 in bank and no bank account — the TDS alone settles what is left.
   * Saved through the same record_desk_payment → record_payment_with_tds call as any TDS
   * receipt (payment = TDS gross, tds_receivable net_paid 0). The operator still confirms.
   */
  tdsOnly?: { section: string; ratePct: number } | null;
  /**
   * Fired after the payment is saved and every toast has been queued, with the RPC's
   * own result. OPTIONAL and additive — every existing caller keeps its behaviour.
   *
   * Added 9 Sep 2026 for subscription onboarding, which needs to raise the GST invoice
   * once the money is actually recorded. It deliberately does NOT generate an invoice
   * itself: this sheet is used from several places, and making it issue a GST document
   * everywhere would change all of them at once.
   */
  onRecorded?: (result: {
    isFullyPaid: boolean;
    subscriptionCreated: boolean;
    isFirstPayment: boolean;
  }) => void;
}

export function RecordPaymentDialog({
  open,
  onOpenChange,
  quoteId,
  customerName,
  expectedAmount: quoteTotal,
  alreadyReceived = 0,
  isProspect = false,
  invoiceId = null,
  instalmentInvoiceId = null,
  customerId = null,
  askDomain = false,
  defaultDomain = null,
  isRenewal = false,
  isUpgrade = false,
  lineItems,
  onRecorded,
  tdsOnly = null,
}: RecordPaymentDialogProps) {
  const qc = useQueryClient();
  /* The receipt-voucher counter, so the sheet can name the number it will consume. */
  const { data: series } = useDocumentSeries();
  const [method, setMethod] = React.useState<PaymentMethod>(DEFAULT_PAYMENT_METHOD);
  const [bankAccountId, setBankAccountId] = React.useState<string>("");
  /* R-404: "Received in" lists THIS company's own bank / cash accounts (RLS-scoped), never a
     hard-coded row carrying our own company name. One matching account is pre-picked; several → the
     operator picks; none → a link to add one. Rules: lib/payments/deposit-accounts.ts. */
  /* R-1730: the only account, else the one this company usually receives into, else Not sure
     yet — the same rule and field as every other Record payment sheet (payment-entry-fields). */
  const { accounts: receiveAccounts, loading: bankAccountsLoading, defaultId: usualAccountId } = useReceivedInDefault(open, method);
  const [accountTouched, setAccountTouched] = React.useState(false);
  React.useEffect(() => {
    if (!open || accountTouched) return;
    /* R-1520: a TDS-only receipt brought no money to any account — pre-pick none. */
    setBankAccountId(tdsOnly ? "" : usualAccountId);
  }, [open, accountTouched, usualAccountId, tdsOnly]);

  /* R-407: does this quote make a subscription? true / false from its lines (the same rule
     record_payment uses); null when the caller did not pass the lines. The domain field and
     the "start the subscription" promise follow it, so a one-time quote promises nothing. */
  const makesSubscription: boolean | null = lineItems ? lineItems.some((l) => isSubscriptionLine(l)) : null;
  const showDomain = askDomain && makesSubscription !== false;
  // Optional proof-of-payment file (screenshot / PDF). Uploaded best-effort
  // AFTER record_payment succeeds, so it never blocks the money.
  const [receiptFile, setReceiptFile] = React.useState<File | null>(null);

  /* R-527: a split-billed quote (annual commitment billed monthly / quarterly / half-yearly)
     expects only the instalments that have fallen due — the same figure the customer page
     and the online pay button collect — never the whole year. Read once when the sheet
     opens; until it arrives (or for any other quote) the quote total stands. */
  const [split, setSplit] = React.useState<SplitExpectation | null>(null);
  React.useEffect(() => {
    if (!open || invoiceId) { setSplit(null); return; }
    let live = true;
    (async () => {
      const supabase = createClient();
      const [{ data: q }, { data: s }] = await Promise.all([
        supabase.from("quotes")
          .select("subtotal, discount_pct, tax_rate, amount, billing_cycle, line_items")
          .eq("id", quoteId).maybeSingle(),
        supabase.from("subscriptions")
          .select("start_date").eq("quote_id", quoteId)
          .order("created_at", { ascending: true }).limit(1),
      ]);
      if (!live) return;
      setSplit(splitExpectation({
        quote: q ?? null,
        termStart: s?.[0]?.start_date ?? null,
        todayISO: istToday(),
        alreadyReceived,
      }));
    })();
    return () => { live = false; };
  }, [open, quoteId, invoiceId, alreadyReceived]);
  const expectedAmount = split ? split.expected : quoteTotal;

  /* R-542: an add-seats quote (Manage seats → Add Seats) already put its seats on the
     EXISTING subscription, and record_payment creates no subscription for it — but its line
     carries a billing commitment, so "What this does" promised a new recurring subscription
     and the owner read it as double billing. Read the flag once when the sheet opens.
     select("*") so a database without the is_add_seats column still loads (flag = false). */
  const [isAddSeatsQuote, setIsAddSeatsQuote] = React.useState(false);
  /* R-1119: the quote's GST rate, read in the same lookup — TDS is taken on the pre-GST value. */
  const [quoteTaxRate, setQuoteTaxRate] = React.useState<number | null>(null);
  React.useEffect(() => {
    if (!open) { setIsAddSeatsQuote(false); setQuoteTaxRate(null); return; }
    let live = true;
    (async () => {
      const { data: q } = await createClient().from("quotes").select("*").eq("id", quoteId).maybeSingle();
      if (!live) return;
      const row = q as { is_add_seats?: boolean | null; tax_rate?: number | string | null } | null;
      setIsAddSeatsQuote(row?.is_add_seats === true);
      setQuoteTaxRate(row?.tax_rate == null ? null : Number(row.tax_rate));
    })();
    return () => { live = false; };
  }, [open, quoteId]);

  const remaining = Math.max(0, expectedAmount - alreadyReceived);
  const hasPriorPayments = alreadyReceived > 0;

  // Fetched once when dialog opens — pre-fills TDS section + rate + TAN
  const [customerTdsDefaults, setCustomerTdsDefaults] = React.useState<{
    tan: string | null;
    section: string;
    ratePct: number;
  }>({ tan: null, section: "194J", ratePct: 10 });

  React.useEffect(() => {
    if (!open || !customerId) return;
    (async () => {
      const supabase = createClient();
      const { data } = await supabase
        .from("customers")
        .select("tan, tds_default_section, tds_default_rate_pct")
        .eq("id", customerId)
        .maybeSingle();
      if (data) {
        setCustomerTdsDefaults({
          tan:     data.tan ?? null,
          section: data.tds_default_section ?? "194J",
          ratePct: Number(data.tds_default_rate_pct ?? 10),
        });
      }
    })();
  }, [open, customerId]);

  // Open advance credit this customer already has (from earlier overpayments).
  // Only for existing customers — a prospect quote has no customer row yet.
  const [availableCredit, setAvailableCredit] = React.useState(0);
  const [applyCredit, setApplyCredit] = React.useState(false);
  React.useEffect(() => {
    if (!open || !customerId) { setAvailableCredit(0); setApplyCredit(false); return; }
    (async () => {
      const supabase = createClient();
      const { data } = await supabase
        .from("customer_credits").select("amount").eq("customer_id", customerId).eq("status", "open");
      setAvailableCredit((data ?? []).reduce((s, r) => s + (r.amount ?? 0), 0));
    })();
  }, [open, customerId]);

  const {
    register,
    handleSubmit,
    reset,
    watch,
    setValue,
    getValues,
    clearErrors,
    trigger,
    formState: { errors, isSubmitting, isSubmitted },
  } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: {
      amount:       remaining,
      method:       DEFAULT_PAYMENT_METHOD,
      reference:    "",
      // R-025: `toISOString()` is UTC, so between 00:00 and 05:30 IST this defaulted the
      // payment to YESTERDAY — and reps here work early (AGENTS.md §6).
      receivedDate: istToday(),
      domain:       defaultDomain ?? "",
      tdsDeducted:  false,
      tdsSection:   "194J",
      tdsRatePct:   10,
      customerTan:  "",
    },
  });

  const watchedAmount = watch("amount") || 0;
  const tdsDeducted   = watch("tdsDeducted") || false;
  const tdsRatePct    = Number(watch("tdsRatePct") || 0);
  // Has the user hand-edited the bank amount? Until they do, we keep it locked
  // to (remaining − TDS) so net + TDS always settles the quote exactly.
  const [amountEdited, setAmountEdited] = React.useState(false);

  // TDS computation — preGST × rate%
  const { preGST: quotePreGST, tds: tdsAtRate } = React.useMemo(
    () => tdsDeducted ? computeTds(expectedAmount, tdsRatePct, quoteTaxRate) : { preGST: 0, tds: 0 },
    [tdsDeducted, tdsRatePct, expectedAmount, quoteTaxRate],
  );
  /* R-2045: on a part payment request the TDS the customer ACTUALLY withheld can be typed (the
     field is shown only there). Bank + that TDS covering the part pays it in full; more than rate
     × this part's taxable value is warned about below (partRequestTdsCheck), never blocked.
     A rate change, unticking TDS or closing the sheet goes back to rate × taxable. */
  const [typedPartTds, setTypedPartTds] = React.useState<number | null>(null);
  React.useEffect(() => { setTypedPartTds(null); }, [open, tdsDeducted, tdsRatePct]);
  const tdsAmount = tdsDeducted && typedPartTds !== null ? typedPartTds : tdsAtRate;

  // Advance credit applied to this payment — capped at the remaining balance
  // (can't apply more credit than is owed). Reduces the cash the customer needs.
  /* R-2023: "Use advance" — the whole advance that fits by default, or the part the person
     types (partial use). Never more than the advance nor the bill (customer-advance.ts). */
  const [typedCredit, setTypedCredit] = React.useState<number | null>(null);
  React.useEffect(() => { if (!open) setTypedCredit(null); }, [open]);
  const appliedCreditAmount  = applyCredit
    ? advanceToUse({ available: availableCredit, owed: remaining, typed: typedCredit })
    : 0;
  React.useEffect(() => {
    setValue("creditApplied", appliedCreditAmount);
    if (isSubmitted) void trigger("amount");
  }, [appliedCreditAmount, setValue, trigger, isSubmitted]);

  // When TDS is checked, "amount received" represents the BANK amount
  // (post-TDS). The amount we record_payment with is amount + TDS + any advance
  // credit applied (both already-settled money, not fresh cash this transaction).
  const settledAgainstQuote  = watchedAmount + (tdsDeducted ? tdsAmount : 0) + appliedCreditAmount;
  const newRunningTotal      = alreadyReceived + settledAgainstQuote;
  const willBePartial        = newRunningTotal < expectedAmount && newRunningTotal > 0;
  const willBeOverpaid       = newRunningTotal > expectedAmount;
  /* R-523: the ONE sentence about how the quote ends up — the TDS box used to say "fully
     satisfied" while the partial box said "₹X pending", both on screen at once. */
  const baseOutcome = paymentOutcome({ expected: expectedAmount, alreadyReceived, settled: settledAgainstQuote });
  /* R-527: on a split-billed quote the sentence is about instalments, never "fully paid". */
  const outcome = split
    ? { ...baseOutcome, sentence: splitOutcomeSentence(split, { ...baseOutcome, formatRupee: rupee, formatDate }) }
    : baseOutcome;
  /* R-523: section change sets the rate from the one table (tds-rates.ts); a hand-typed
     rate that does not fit the section is allowed but warned about. */
  const tdsSectionValue = watch("tdsSection") ?? "194J";
  const tdsRateCheck = checkTdsRate(tdsSectionValue, tdsRatePct);
  /* R-1520: a short payment whose gap is exactly a common TDS (1/2/10% of the pre-GST
     total, ±₹1) → one hint above the TDS box. Only while TDS is unticked, and not on a
     split-billed quote (its "expected" is an instalment, not the invoice the TDS is on). */
  const tdsShortfall = !tdsDeducted && !split
    ? matchTdsShortfall({
        totalInclGst:     expectedAmount,
        received:         alreadyReceived + watchedAmount + appliedCreditAmount,
        gstRatePct:       quoteTaxRate,
        preferredSection: customerTdsDefaults.section,
      })
    : null;

  /* ── R-378: "Issue GST invoice now" ─────────────────────────────────────────
     The online path invoices the moment money lands (online-invoice.server.ts); the desk
     path left the owner to press Generate GST Invoice afterwards. The quote's billing cycle
     and the buyer's place of supply are read once when the sheet opens — rules in
     lib/payments/record-payment-invoice.ts (unit-tested). */
  const [invoiceFacts, setInvoiceFacts] = React.useState<{
    billingCycle: string | null;
    buyer: BuyerPlace | null;
    /** R-1735: "No GSTIN — invoice will be B2C. Add GSTIN?" — a reminder, never a block. */
    gstinNudge: B2cNudge | null;
    /** R-2044: a part's payment request — paying it raises that part's tax invoice itself. */
    partRequest: boolean;
    /** R-2048: the part's short name ("Q2") for the toast, from the request's line. */
    partLabel: string | null;
  } | null>(null);
  React.useEffect(() => {
    if (!open || invoiceId) { setInvoiceFacts(null); return; }
    let live = true;
    (async () => {
      const supabase = createClient();
      const { data: q } = await supabase
        .from("quotes")
        .select("billing_cycle, customer_id, lead_id, prospect_state_code, prospect_country")
        .eq("id", quoteId)
        .maybeSingle();
      if (!q) return;
      /* R-2044: quotes.subscription_billing_id (migration 20261028025317) — read untyped until the
         generated types are refreshed. */
      const { data: pr } = await (supabase as unknown as SupabaseClient)
        .from("quotes").select("subscription_billing_id, line_items").eq("id", quoteId).maybeSingle();
      const prRow = pr as { subscription_billing_id?: string | null; line_items?: unknown } | null;
      const partRequest = isPartRequest(prRow);
      const partLabel = partRequest && Array.isArray(prRow?.line_items)
        ? partLabelOf((prRow.line_items[0] as { name?: string | null } | undefined)?.name)
        : null;
      /* R-447: the quote's own Place of supply counts, not only the lead's state — order in
         paymentBuyerPlace (customer with a state → quote → lead). Before issuing, the sheet
         copies the quote's state onto a customer that has none (fillCustomerStateFromQuote). */
      const { data: c } = q.customer_id
        ? await supabase.from("customers").select("state_code, gstin, country, customer_type, gst_treatment").eq("id", q.customer_id).maybeSingle()
        : { data: null };
      // record_payment copies the lead's state + GSTIN onto the customer it creates.
      const { data: l } = !q.customer_id && q.lead_id
        ? await supabase.from("leads").select("state_code, gstin").eq("id", q.lead_id).maybeSingle()
        : { data: null };
      const buyer: BuyerPlace | null = paymentBuyerPlace({ customer: c ?? null, quote: q, lead: l ?? null });
      const gstinNudge = b2cGstinNudge({
        quoteId, customerId: q.customer_id ?? null, customer: c ?? null, lead: l ?? null, prospectCountry: q.prospect_country,
      });
      if (live) setInvoiceFacts({ billingCycle: q.billing_cycle ?? null, buyer, gstinNudge, partRequest, partLabel });
    })();
    return () => { live = false; };
  }, [open, quoteId, invoiceId]);

  const invoiceOffer = invoiceFacts
    ? invoiceNowOffer({
        invoiceId,
        billingCycle: invoiceFacts.billingCycle,
        buyer: invoiceFacts.buyer,
        partRequest: invoiceFacts.partRequest,
        completesQuote: newRunningTotal >= expectedAmount,
      })
    : { offer: false, defaultOn: false, hint: null };
  const [issueInvoice, setIssueInvoice] = React.useState(false);
  const [issueTouched, setIssueTouched] = React.useState(false);
  React.useEffect(() => {
    if (!issueTouched) setIssueInvoice(invoiceOffer.defaultOn);
  }, [invoiceOffer.defaultOn, issueTouched]);
  React.useEffect(() => { if (!open) setIssueTouched(false); }, [open]);

  React.useEffect(() => {
    if (open) return;
    reset();
    setMethod(DEFAULT_PAYMENT_METHOD);
    setBankAccountId("");
    setAccountTouched(false);
    setAmountEdited(false);
    setReceiptFile(null);
  }, [open, reset]);
  /* R-1442: filled ONCE per open (see useFillOnOpen). The amount follows `remaining` through
     the amount effect below; the customer's TDS defaults through the effect after this. */
  useFillOnOpen(open, () => {
    /* R-1520: "Record TDS" opens ticked, at the suggested section + rate, method Other with
       a "TDS <section>" reference the operator can overwrite with the 26AS / challan ref.
       The amount effect below then sets the bank amount to remaining − TDS (₹0). */
    reset({
      amount:       remaining,
      method:       tdsOnly ? "other" : DEFAULT_PAYMENT_METHOD,
      /* R-407: named, so a re-opened sheet never carries the last payment's UTR. */
      reference:    tdsOnly ? `TDS ${tdsOnly.section}` : "",
      notes:        "",
      receivedDate: istToday(),      // R-025 — same UTC trap as the defaults above.
      tdsDeducted:  !!tdsOnly,
      tdsSection:   tdsOnly?.section ?? customerTdsDefaults.section,
      tdsRatePct:   tdsOnly?.ratePct ?? customerTdsDefaults.ratePct,
      customerTan:  customerTdsDefaults.tan ?? "",
      creditApplied: 0,              // R-2023: "Use advance" starts unticked on every open.
    });
    if (tdsOnly) setMethod("other");
    setAmountEdited(false);
  });
  /* The customer's TDS defaults arrive after the sheet opens — they set only the TDS fields,
     and only while TDS is not ticked (once ticked, the operator's own values stand). */
  React.useEffect(() => {
    if (!open || tdsOnly || getValues("tdsDeducted")) return;
    setValue("tdsSection", customerTdsDefaults.section);
    setValue("tdsRatePct", customerTdsDefaults.ratePct);
    setValue("customerTan", customerTdsDefaults.tan ?? "");
  }, [open, tdsOnly, customerTdsDefaults, getValues, setValue]);

  /* R-379 (j): the reset above passes no `domain`, and react-hook-form's reset(values)
     replaces ALL values — so the required Domain field opened empty even when the page
     knew the domain (Q-FBB9-27-0011: the customer's subscription carried it). Filled here,
     after that reset, and again when the default arrives late (subscriptions load after
     the quote). Never overwrites what the operator typed. */
  React.useEffect(() => {
    if (!open || !defaultDomain) return;
    if (!(getValues("domain") ?? "").trim()) setValue("domain", defaultDomain);
  }, [open, defaultDomain, getValues, setValue]);

  /* R-468 (3): no domain from the page → use the customer's own (customers.domain), so a
     repeat buyer is not asked again. Same rule: never overwrites what was typed. */
  React.useEffect(() => {
    if (!open || defaultDomain || !customerId) return;
    let live = true;
    (async () => {
      const { data } = await createClient().from("customers").select("domain").eq("id", customerId).maybeSingle();
      const d = data?.domain?.trim();
      if (live && d && !(getValues("domain") ?? "").trim()) setValue("domain", d);
    })();
    return () => { live = false; };
  }, [open, defaultDomain, customerId, getValues, setValue]);

  // Keep the bank amount locked to (remaining − TDS) until the user hand-edits
  // it, so net + TDS always settles the quote EXACTLY — no accidental ₹-few
  // over/under-shoot that used to trip a false "excess payment" warning.
  React.useEffect(() => {
    if (amountEdited) return;
    setValue("amount", Math.max(0, remaining - (tdsDeducted ? tdsAmount : 0) - appliedCreditAmount));
  }, [tdsDeducted, tdsAmount, remaining, amountEdited, appliedCreditAmount, setValue]);

  /* R-248 — the result toast's buttons. Each one NAVIGATES rather than opening a dialog
     here, because several callers unmount this sheet the moment it closes (invoice detail,
     /payments, subscriptions) and a dialog rendered from it would vanish with it.
       generate-invoice → the same useGenerateInvoice the quote page's button uses, then
                          the invoice page with its Tax Invoice dialog open (?pdf=1)
       view-invoice     → that invoice page, dialog open
       send-receipt     → the quote page with this payment's Receipt Voucher open (?receipt=) */
  const router = useRouter();
  const generateInvoice = useGenerateInvoice();
  const runToastAction = (action: PaymentToastAction, paymentId: string | null) => {
    const { kind } = action;
    if (kind === "generate-invoice") {
      generateInvoice
        .mutateAsync(quoteId)
        .then(({ invoiceId: newId }) => router.push(`${invoiceHref(newId)}?pdf=1` as never))
        .catch(() => { /* useGenerateInvoice already shows the reason */ });
    } else if (kind === "view-invoice" && action.href) {
      router.push(action.href as never);
    } else if (kind === "send-receipt" && paymentId) {
      router.push(`/quotes/${encodeURIComponent(quoteId)}?receipt=${encodeURIComponent(paymentId)}` as never);
    }
  };

  const recordPayment = useMutation({
    mutationFn: async (data: FormData) => {
      const supabase = createClient();

      // ── 1. Determine settlement amount ────────────────────────────
      // When TDS deducted, the quote is satisfied for (bank_received + tds_amount)
      // because the TDS portion is already deposited with govt against the
      // reseller's PAN — it's a receivable from govt, not from the customer.
      const tdsActive = !!data.tdsDeducted;

      /* ── 2. ONE call, ONE transaction (R-895). record_desk_payment redeems the advance
         credit, records the payment for (amount + credit actually consumed) — through
         record_payment_with_tds when TDS was deducted, so the TDS receivable commits with it
         (audit #22) — tags the receipt date + bank account (R-1118), and moves the settled
         invoice's paid_date to that date (R-015). Any failure rolls ALL of it back, credit
         included; a replay (R-374: reference already recorded) consumes no credit and leaves
         the earlier payment untouched. Before this the page redeemed credit first, as its own
         committed call, and tried to put it back by hand when the payment failed — a put-back
         R-719 refuses and a dropped connection skips, so the credit was lost. */
      const settledAmount = tdsActive ? data.amount + tdsAmount : data.amount;
      /* R-1520: ₹0 in bank passes the form only with TDS ticked; a 0% rate would still leave
         nothing to record — say so here instead of record_payment's "amount must be > 0". */
      if (settledAmount <= 0) throw new Error("Nothing to record — enter the amount received, or the TDS rate.");
      const method = data.method as "upi" | "razorpay" | "bank_transfer" | "cheque" | "cash" | "other";
      const notes  = [
        data.notes || null,
        tdsActive
          ? tdsAmount === tdsAtRate
            ? `TDS ${data.tdsSection} @ ${tdsRatePct}% = ${rupee(tdsAmount)} on pre-GST ${rupee(quotePreGST)}`
            /* R-2045: the TDS the customer actually withheld on a part request, typed. */
            : `TDS ${data.tdsSection} withheld ${rupee(tdsAmount)} (${tdsRatePct}% of pre-GST ${rupee(quotePreGST)} = ${rupee(tdsAtRate)})`
          : null,
      ].filter(Boolean).join(" · ") || null;
      const tagArgs = deskPaymentTagArgs({ receivedDate: data.receivedDate, bankAccountId });

      const deskArgs = {
        p_amount:             settledAmount,
        p_method:             method,
        p_reference:          data.reference,
        p_notes:              notes,
        p_credit_customer_id: appliedCreditAmount > 0 && customerId ? customerId : null,
        p_credit_amount:      appliedCreditAmount > 0 && customerId ? appliedCreditAmount : 0,
        p_received_on:        tagArgs.p_received_on,
        p_bank_account_id:    tagArgs.p_bank_account_id,
        ...(tdsActive
          ? {
              p_tds_amount:   tdsAmount,
              p_tds_gross:    quotePreGST,
              p_tds_net_paid: data.amount,
              p_tds_section:  data.tdsSection ?? "194J",
              p_tds_rate_pct: tdsRatePct,
              p_customer_tan: data.customerTan?.trim() || null,
              /* R-025: the FY follows the PAYMENT date the operator chose, not the wall
                 clock — a payment received on 28 March and entered on 2 April belongs to the
                 earlier FY. `istToday()` is only the fallback for an empty field. */
              p_fiscal_year:  fiscalYearFromDate(data.receivedDate || istToday()),
            }
          : {}),
      };
      /* R-1564: an instalment invoice — the same arguments, keyed by the invoice; the RPC
         finds the subscription's quote and applies the money to THIS invoice. */
      const { data: r, error } = instalmentInvoiceId
        ? await supabase.rpc("record_instalment_payment", { ...deskArgs, p_invoice_id: instalmentInvoiceId })
        : await supabase.rpc("record_desk_payment", {
            ...deskArgs,
            p_quote_id: quoteId,
            ...(tdsActive ? { p_invoice_id: invoiceId ?? null } : {}),
          });
      if (error) throw error;
      if (!r) throw new Error("The payment was not confirmed — refresh the page to see whether it was saved.");
      const inst = instalmentInvoiceId ? (r as InstalmentPaymentResult) : null;

      // Idempotent replay (same reference re-submitted / RQ retry): the payment
      // already exists and nothing new was recorded — no credit was used either.
      const isReplay = isReplayResult(r);

      /* R-374: on a replay NOTHING after this point may run. The payment_id is the EARLIER
         payment's row — stamping a domain or attaching a receipt would rewrite that payment
         with this form's values. Read what IS recorded, and stop. */
      if (isReplay) {
        const { data: prior } = r.payment_id
          ? await supabase.from("payments").select("amount, received_at").eq("id", r.payment_id).maybeSingle()
          : { data: null };
        return {
          isReplay: true as const,
          replayOf: prior ? { amount: prior.amount, receivedAt: prior.received_at } : null,
        };
      }

      /* R-829: every line keeps its own domain now; the one case record_payment cannot
         save (the same plan twice on the same domain) comes back in domain_conflicts and
         is said out loud — never a silently blank "+ Add domain". */
      const domainConflict = domainConflictMessage(r);
      if (domainConflict) toast.warning(domainConflict.title, { description: domainConflict.description, duration: 12_000 });

      // ── 2c. Attach the optional payment-receipt file (best-effort) ───────
      // Uploaded AFTER the money is recorded, via the admin server route. A
      // failed upload only warns — the payment is already saved and the file
      // can be re-attached later. Skipped on replay (no new row to attach to).
      // R-248: the failure is reported as a line of the ONE result toast, not its own toast.
      let receiptUploadFailed = false;
      if (receiptFile && r.payment_id && !isReplay) {
        try {
          const fd = new FormData();
          fd.append("file", receiptFile);
          const res = await fetch(`/api/payments/${r.payment_id}/receipt`, { method: "POST", body: fd });
          if (!res.ok) {
            const j = await res.json().catch(() => ({}));
            console.error("[record-payment] receipt upload failed (payment still recorded):", j?.error);
            receiptUploadFailed = true;
          }
        } catch (e) {
          console.error("[record-payment] receipt upload error (payment still recorded):", e);
          receiptUploadFailed = true;
        }
      }

      // ── 2d. Stamp the optional domain onto the subscription (best-effort). ──
      // record_payment creates/keeps the subscription (linked by quote_id).
      // Google Workspace / M365 subscriptions need the customer's domain, so we
      // capture it optionally here and set it if one was entered and it isn't
      // already set (never overwrite). Non-money metadata — a failure only logs;
      // the domain can still be added later on the Subscriptions page. Matches 0
      // rows harmlessly for one-off / direct-invoice quotes (no subscription).
      /* R-389 (F8): ONE row, chosen by pickDomainStampTarget. Updating every null-domain
         subscription of the quote gave two rows the same domain, the unique index
         (tenant, quote, lower(domain)) refused it, and NOTHING was stamped — a Workspace +
         Support quote (Q-FBB9-27-0013) kept domain NULL through two payments. */
      /* R-407: only for a quote that makes a subscription (showDomain). */
      /* R-1730: the domain is no longer typed here (setup, not money — UI rule 7). The domain
         the page already knows (quote → its subscriptions → customer → lead, the value the
         field used to open with) is still saved exactly as before; with none known the
         result toast points to the quote's "Setting up" card, where it is entered. */
      const domainVal = showDomain ? (data.domain ?? "").trim() : "";
      /* R-407: also onto the customer and the quote's provisioning task (blank ones only),
         so a known domain is never lost when the quote made no subscription. */
      if (domainVal) await stampPaymentDomain(supabase, { quoteId, domain: domainVal });

      // ── 3. TDS receivable — now committed ATOMICALLY inside
      // record_payment_with_tds above (audit #22): either the payment AND its
      // TDS receivable both commit, or neither does. No more best-effort client
      // insert that could silently drop the government TDS credit.
      let tdsSaved = false;
      if (!isReplay && tdsActive && tdsAmount > 0) {
        tdsSaved = Boolean((r as { tds_saved?: boolean }).tds_saved);
        // Remember the customer's TDS section/rate (and TAN when typed) for next time —
        // a non-money UX convenience, safe as a best-effort client update.
        // R-523: was skipped whenever no TAN was typed, so the profile kept showing
        // "194J @ 10%" after a 194C @ 2% payment. The drawer says it will do this.
        if (customerId) {
          const tan = data.customerTan?.trim();
          await supabase
            .from("customers")
            .update({
              ...(tan ? { tan } : {}),
              tds_default_section:  data.tdsSection ?? "194J",
              tds_default_rate_pct: tdsRatePct,
            })
            .eq("id", customerId);
        }
      }

      // ── 4. Overpayment → customer credit: ab RPC ke ANDAR banta hai
      // (migration 20260901110000, audit A5). Pehle yahan client-side insert
      // tha — RPC-commit ke BAAD, sirf console.error ke sahare — network ki
      // ek hichki aur excess hamesha ke liye be-hisaab. Ab function khud
      // incremental excess ki 'open' credit likhta hai (test:
      // record_payment_overpaid_credit — atomic, incremental, replay-safe)
      // aur return me bata deta hai.
      const creditRecorded = Number(r.overpaid_credit ?? 0);

      // Re-shape into the camelCase keys the onSuccess handler already consumes
      return {
        isReplay:               false as const,
        overpaidCredit:         creditRecorded,
        newPaymentId:           r.payment_id,
        totalReceived:          r.total_received,
        expected:               r.expected,
        /* R-1564: an instalment speaks of THIS invoice — its due, paid or not — never of the
           year's quote total the RPC also reports. */
        outstanding:            inst ? Number(inst.invoice_due_after ?? 0) : r.outstanding,
        isFirstPayment:         inst ? false : r.is_first_payment,
        isFullyPaid:            inst ? Boolean(inst.invoice_paid) : r.is_fully_paid,
        convertedNow:           r.converted_now,
        subscriptionCreated:    inst ? false : r.subscription_created,
        invoicePaid:            r.invoice_paid,
        hasExistingInvoice:     inst ? true : r.has_existing_invoice,
        instalmentLines:        inst ? instalmentPaymentLines(inst) : [],
        // Renewal roll-forward — added in migration 0010
        isRenewalQuote:         r.is_renewal_quote ?? false,
        renewalRolledForward:   r.renewal_rolled_forward ?? false,
        // TDS — added in TDS Phase 2. tdsRecorded = did the row ACTUALLY save;
        // tdsAttempted = TDS was requested (so we can warn if it failed).
        tdsRecorded:            tdsSaved,
        tdsAttempted:           tdsActive && tdsAmount > 0,
        tdsAmount:              tdsActive ? tdsAmount : 0,
        // R-248 — for the one result toast's buttons + lines.
        receiptVoucherNo:       r.receipt_voucher_no ?? null,
        receiptUploadFailed,
        domainToSetUp:          showDomain && !domainVal,
      };
    },
    onSuccess: async (res) => {
      // Invalidate everything that this touches
      /* Every balance screen — payments (incl. this quote's), quotes, invoices, subscriptions,
         dues, credit, TDS, Aging (R-1589) and Payment Follow-up (R-1634, kept the old due). */
      invalidateReceivables(qc);
      qc.invalidateQueries({ queryKey: ["leads"] });
      qc.invalidateQueries({ queryKey: ["contacts", "all"] });

      /* R-374: the reference was already recorded — nothing new was saved. Say so, and keep
         the sheet open so the operator can enter the new payment's own reference. */
      if (res.isReplay) {
        const rt = replayToast(res.replayOf);
        toast.warning(rt.title, {
          description: rt.lines.join("\n"),
          duration: 12000,
          classNames: { description: "whitespace-pre-line" },
        });
        return;
      }

      /* R-407: the payment IS saved. Clear its reference at once, and close the sheet in
         `finally` — Abhishek (7 Oct) saw the sheet stay open as "Record additional payment"
         with the same UTR still filled, one click from being submitted again. Whatever the
         invoice / toast steps below do, a saved payment always ends with the sheet closed. */
      setValue("reference", "");
      try {

      /* ── ONE result toast (R-248) ──────────────────────────────────────────
         This used to fire a headline toast and then 1–4 more on staggered setTimeouts
         (reminder reset, balance pending, subscription created, excess credit, TDS,
         "no subscription"), so one payment produced a stack nobody read to the end, and
         "invoice can now be generated" had no button. Wording, lines and buttons now come
         from lib/payments/record-payment-toast.ts (unit-tested); this only renders it. */

      /* ── Why there is no subscription ──────────────────────────────────────
         Reported for any first payment that produced none, not only for a conversion.
         A one-off needs nothing and must not be dressed as a problem; a plan that
         produced nothing is a genuine fault (record_payment creates monthly + annual).

         AN ADD-SEATS QUOTE HAS NO SUBSCRIPTION TO CREATE (21 Sep 2026): the seats were
         already added to the existing subscription by /api/subscriptions/[id]/add-seats,
         and telling the operator to "add it" would create a SECOND subscription for the
         same customer. Read here rather than added as a prop: four screens open this
         dialog and only two of them hold the quote row. One select, on the only path that
         can show the note. subscriptionExpectation is the SAME rule the quote page's
         orphan warning uses, so the toast and the page cannot disagree. */
      /* R-379 (k): "nothing created on THIS call" is not "missing" — a quote activated on
         credit already got its subscription at activation (Q-FBB9-27-0011 warned falsely).
         So count the quote's subscriptions and read credit_activated_at before warning.
         select("*") because credit_activated_at is absent before the R-346 migration; a
         named column would fail the whole read there. Rule: subscriptionNoteFor(). */
      let subscriptionNote: SubscriptionNote = null;
      /* R-2048: not for a part request — it is one part of a running subscription, not a one-off. */
      if (res.isFirstPayment && !res.subscriptionCreated && !res.isRenewalQuote && !invoiceFacts?.partRequest) {
        const sb = createClient();
        const [{ data: q }, { count: subCount }] = await Promise.all([
          sb.from("quotes").select("*").eq("id", quoteId).maybeSingle(),
          sb.from("subscriptions").select("id", { count: "exact", head: true }).eq("quote_id", quoteId),
        ]);
        const qRow = q as { is_add_seats?: boolean | null; credit_activated_at?: string | null } | null;
        subscriptionNote = subscriptionNoteFor({
          isFirstPayment:      res.isFirstPayment,
          subscriptionCreated: res.subscriptionCreated,
          isRenewalQuote:      res.isRenewalQuote,
          isAddSeats:          qRow?.is_add_seats,
          creditActivatedAt:   qRow?.credit_activated_at,
          existingSubs:        subCount ?? 0,
          lines:               lineItems,
        });
      }

      /* R-378: issue the GST invoice now, through the SAME useGenerateInvoice the quote
         page's button uses (consistency pre-flight + generate_invoice). Only when the payment
         really completed the quote. A refusal is shown by the hook with generate_invoice's own
         reason, and the quote keeps its Generate GST Invoice button — nothing is lost. */
      let issuedInvoiceId: string | null = null;
      if (shouldIssueAfterPayment({
        ticked: issueInvoice,
        offered: invoiceOffer.offer,
        isFullyPaid: res.isFullyPaid,
        hasExistingInvoice: Boolean(res.hasExistingInvoice),
        isReplay: false,
      })) {
        try {
          /* R-447: generate_invoice reads the CUSTOMER's state. A customer made from a lead
             with no state gets the quote's Place of supply first (blank state only). */
          await fillCustomerStateFromQuote(createClient(), quoteId);
          issuedInvoiceId = (await generateInvoice.mutateAsync(quoteId)).invoiceId;
        } catch {
          /* useGenerateInvoice already toasted the reason. */
        }
      }

      const toastBase = paymentToast({
        outstanding:          res.outstanding,
        isFullyPaid:          res.isFullyPaid,
        convertedNow:         res.convertedNow,
        subscriptionCreated:  res.subscriptionCreated,
        invoicePaid:          res.invoicePaid,
        hasExistingInvoice:   res.hasExistingInvoice,
        isRenewalQuote:       res.isRenewalQuote,
        isUpgradeQuote:       isUpgrade,  // R-2093
        renewalRolledForward: res.renewalRolledForward,
        overpaidCredit:       res.overpaidCredit,
        tdsRecorded:          res.tdsRecorded,
        tdsAttempted:         res.tdsAttempted,
        tdsAmount:            res.tdsAmount,
        paymentId:            res.newPaymentId ?? null,
        receiptVoucherNo:     res.receiptVoucherNo,
        customerName,
        invoiceId,
        subscriptionNote,
        receiptUploadFailed:  res.receiptUploadFailed,
      });
      /* R-527: a split-billed quote's tax invoice is the INSTALMENT's, raised now through the
         billing cron's own code (POST /api/quotes/:id/raise-instalments) — Q-FBB9-27-0020 had
         a Rs 7,646 payment and 0 invoices. The toast then speaks of instalments, not of the
         year's "outstanding" the RPC reports. */
      let splitRaise: InstalmentRaiseResult | null = null;
      /* R-2044: a part's payment request — the payment raised that part's invoice; this fetches it
         (or raises it, if that step was refused) so the toast can open it. */
      if (split || invoiceFacts?.partRequest) {
        try {
          const resp = await fetch(`/api/quotes/${encodeURIComponent(quoteId)}/raise-instalments`, { method: "POST" });
          const body = (await resp.json().catch(() => null)) as (InstalmentRaiseResult & { error?: string }) | null;
          splitRaise = resp.ok && body
            ? { raised: body.raised ?? [], errors: body.errors ?? [] }
            : { raised: [], errors: [{ message: body?.error ?? `HTTP ${resp.status}.` }] };
        } catch (e) {
          splitRaise = { raised: [], errors: [{ message: e instanceof Error ? e.message : String(e) }] };
        }
        invalidateReceivables(qc);   // the instalments just raised are dues (R-1634: /collections too)
      }
      const splitToastBase = split
        ? splitPaymentToast(toastBase, {
            split,
            receivedAfter: newRunningTotal,
            raise: splitRaise,
            formatRupee: rupee,
            formatDate,
          })
        : toastBase;
      const firstRaised = splitRaise?.raised[0]?.invoice_id ?? null;
      const tBase = issuedInvoiceId
        ? withIssuedInvoice(splitToastBase, issuedInvoiceId)
        : firstRaised
        ? { ...withIssuedInvoice(splitToastBase, firstRaised), title: splitToastBase.title }
        : splitToastBase;
      /* R-1564: where this instalment payment went (this invoice, any other open instalment,
         and what waits for the next one). */
      const tLines = res.instalmentLines.length ? { ...tBase, lines: [...res.instalmentLines, ...tBase.lines] } : tBase;
      /* R-1730: the domain is set up after the payment, not in this sheet. */
      const setupLine = domainSetupLine({ domainToSetUp: res.domainToSetUp, isFullyPaid: res.isFullyPaid });
      const tAll = setupLine ? { ...tLines, lines: [...tLines.lines, setupLine] } : tLines;
      /* R-2048: a part request's toast says the part's tax invoice was raised and the subscription
         continues — never "one-time purchase" or "GST invoice can be generated now". */
      const t = invoiceFacts?.partRequest
        ? partRequestPaymentToast(tAll, {
            part: invoiceFacts.partLabel,
            invoiceId: firstRaised,
            isFullyPaid: res.isFullyPaid,
            error: splitRaise?.errors[0]?.message ?? null,
          })
        : tAll;
      const run = (action: PaymentToastAction) => () => runToastAction(action, res.newPaymentId ?? null);
      (t.tone === "warning" ? toast.warning : toast.success)(t.title, {
        description: t.lines.length ? t.lines.join("\n") : undefined,
        duration: t.tone === "warning" || t.primary ? 12000 : 6000,
        action: t.primary ? { label: t.primary.label, onClick: run(t.primary) } : undefined,
        cancel: t.secondary ? { label: t.secondary.label, onClick: run(t.secondary) } : undefined,
        classNames: t.lines.length ? { description: "whitespace-pre-line" } : undefined,
      });
      } catch (e) {
        /* The payment is saved — never let a toast / invoice step leave the sheet open. */
        console.error("[record-payment] after-save step failed (payment is recorded):", e);
        toast.success(`Payment recorded for ${customerName}`);
      } finally {
        /* After the toasts, before the sheet closes. Handed the RPC's own result so a
           caller cannot re-derive "was this fully paid" and get a different answer. */
        onRecorded?.({
          isFullyPaid: res.isFullyPaid,
          subscriptionCreated: res.subscriptionCreated,
          isFirstPayment: res.isFirstPayment,
        });
        onOpenChange(false);
      }
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const [reportBugOpen, setReportBugOpen] = React.useState(false);
  const [drawerWidth, setDrawerWidth] = React.useState<number>(520);
  const [isDragging, setIsDragging] = React.useState(false);

  // Load saved width from localStorage if available
  React.useEffect(() => {
    const saved = localStorage.getItem("resellersos_payment_drawer_width_v3");
    if (saved) {
      const parsed = parseInt(saved, 10);
      if (!isNaN(parsed) && parsed >= 460 && parsed <= 1400) {
        setDrawerWidth(parsed);
      }
    } else {
      setDrawerWidth(520);
    }
  }, []);

  const handleResizeStart = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
    const startX = e.clientX;
    const startWidth = drawerWidth;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const dx = startX - moveEvent.clientX; // drag left -> dx > 0 -> width increases!
      const newWidth = Math.max(460, Math.min(window.innerWidth - 40, startWidth + dx));
      setDrawerWidth(newWidth);
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
      localStorage.setItem("resellersos_payment_drawer_width_v3", drawerWidth.toString());
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
  };

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          side="right"
          style={{ width: `${drawerWidth}px`, maxWidth: "96vw" }}
          className="w-full sm:max-w-none p-0 flex flex-col bg-paper text-ink shadow-2xl border-l border-hairline overflow-visible z-[50]"
        >
          {/* ↔️ PROMINENT VISIBLE LEFT EDGE DRAG HANDLE */}
          <div
            onMouseDown={handleResizeStart}
            title="↔️ Click and drag left/right to stretch or shrink form panel"
            className={`absolute left-0 top-0 bottom-0 w-4 -ml-2 cursor-ew-resize hover:bg-rose-500/20 bg-transparent z-[100] flex items-center justify-center group select-none ${
              isDragging ? "bg-rose-500/30" : ""
            }`}
          >
            <div className="w-1.5 h-24 bg-rose-500 hover:bg-rose-600 rounded-full shadow-md group-hover:scale-125 transition-all flex items-center justify-center">
              <div className="w-0.5 h-6 bg-white/80 rounded-full" />
            </div>
          </div>

          <SheetHeader className="pr-12 pt-4 px-6 pb-3 border-b border-hairline bg-paper-2/40">
            <div className="flex items-center justify-between gap-3">
              <SheetTitle>
                {hasPriorPayments ? "Record additional payment" : "Record payment received"}
              </SheetTitle>

              {/* 🐛 Top Header Report Bug Button inside Slider Panel */}
              <button
                type="button"
                onClick={() => setReportBugOpen(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold text-rose-600 bg-rose-50 hover:bg-rose-100 border border-rose-200 rounded-full shadow-2xs transition-all hover:scale-105"
                title="Report Bug / Issue on this Record Payment drawer"
              >
                <Icon name="bug" size={14} />
                <span>Report Bug</span>
              </button>
            </div>

            <SheetDescription className="mt-1">
              Log a payment against quote <span className="font-mono font-semibold">{quoteId}</span> from <b>{customerName}</b>.
              {hasPriorPayments
                ? " Multiple payments are supported (installments / partial)."
                : " You can record more payments later if it's paid in installments."}
            </SheetDescription>
          </SheetHeader>

        <form
          /**
           * The second argument is the point. This sheet is TALL and scrolls, and its
           * first required field (the UTR / transaction reference) sits near the top
           * while Confirm payment sits at the bottom. Submitting with it empty put a
           * red message next to a field that was off-screen and did nothing else — so
           * from the operator's seat the button simply did not work.
           *
           * Reported 9 Sep 2026: "not able to record payment", after four attempts that
           * each left an unpaid quote behind. record_payment was never called once —
           * verified against the database, no payment rows existed — so nothing had
           * failed. The form was refusing, silently, above the fold.
           *
           * §24: say what is wrong and take them to it.
           */
          onSubmit={handleSubmit(
            /* R-248: cash needs no reference. A blank one is filled ONCE here (not inside
               mutationFn) so a react-query retry of this submit sends the same value and
               stays an idempotent replay; see cashReference() for why it is not just "Cash". */
            /* R-1444: any method may be left blank now — same fill, "<Method> <date> <time>". */
            (data) => recordPayment.mutate(
              !data.reference.trim()
                ? { ...data, reference: blankReference(data.method, data.receivedDate) }
                : data,
            ),
            (formErrors) => {
              const order: Array<keyof FormData> = ["amount", "method", "reference", "receivedDate"];
              const firstKey = order.find((k) => formErrors[k]) ?? (Object.keys(formErrors)[0] as keyof FormData | undefined);
              if (!firstKey) return;
              const message = String(formErrors[firstKey]?.message ?? "Check this field");
              toast.error("Payment not saved — one field needs fixing", { description: message });
              /* Scroll it into view and focus it, so the message is where they are looking. */
              const el = document.getElementById(`rp_${String(firstKey)}`)
                ?? document.querySelector<HTMLElement>(`[name="${String(firstKey)}"]`);
              el?.scrollIntoView({ block: "center", behavior: "smooth" });
              (el as HTMLInputElement | null)?.focus?.();
            },
          )}
          className="flex flex-col flex-1 min-h-0 min-w-0 w-full"
          noValidate
        >
          <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-4">
          {/* Prospect → Customer activation notice — fires on FIRST payment now (advance ok) */}
          {isProspect && !hasPriorPayments && (
            <div className="rounded-md bg-amber-soft border border-amber/40 px-3 py-2.5 text-xs flex items-start gap-2">
              <Icon name="info" size={14} className="text-amber-ink flex-shrink-0 mt-0.5" />
              <div className="text-amber-ink">
                <b>First payment — service activation.</b> Confirming will automatically:
                <ul className="list-disc list-inside mt-1 space-y-0.5">
                  <li>Create a Customer record for <b>{customerName}</b></li>
                  <li>Move the lead to <b>Won</b></li>
                  {/* R-407: promised only when the quote's lines make one — a one-time quote
                      creates no subscription, and saying it would is a false promise. */}
                  {makesSubscription === true && <li>Start the subscription from today</li>}
                  {makesSubscription === null && <li>Start the quote&apos;s subscription from today, if it has one</li>}
                  <li>Track any outstanding balance separately</li>
                </ul>
                {/* R-523: what stays due is said once, in the outcome box below. */}
              </div>
            </div>
          )}

          {/* Payment summary — already paid + this payment + remaining */}
          <div className="bg-paper-2 rounded-md p-3 text-sm space-y-1.5">
            {split ? (
              /* R-527: the year is shown for reference; what is expected is the instalments
                 due so far — the same per-instalment figure the customer page collects. */
              <>
                <div className="flex justify-between items-baseline">
                  <span className="text-ink-3">Year, {split.scheduleLabel}</span>
                  <span className="tabular-nums text-ink-3">
                    {split.plan.lines.every((l) => l.gross === split.plan.lines[0].gross)
                      ? `${split.plan.count} × ${rupee(split.plan.lines[0].gross)} = `
                      : `${split.plan.count} instalments · `}
                    {rupee(split.plan.instalmentsGross)}
                  </span>
                </div>
                <div className="flex justify-between items-baseline">
                  <span className="text-ink-3">Due now · {split.dueLabel}</span>
                  <span className="font-medium tabular-nums">{rupee(expectedAmount)}</span>
                </div>
              </>
            ) : (
              <div className="flex justify-between items-baseline">
                <span className="text-ink-3">Quote total</span>
                <span className="font-medium tabular-nums">{rupee(expectedAmount)}</span>
              </div>
            )}
            {hasPriorPayments && (
              <div className="flex justify-between items-baseline">
                <span className="text-ink-3">Already received</span>
                <span className="tabular-nums text-emerald">−{rupee(alreadyReceived)}</span>
              </div>
            )}
            <div className="flex justify-between items-baseline pt-1.5 border-t border-hairline">
              <span className="text-ink-3">{hasPriorPayments ? "Remaining" : "Expected this payment"}</span>
              <span className="font-serif text-lg tabular-nums text-amber-ink">{rupee(remaining)}</span>
            </div>
          </div>

          {/* Advance credit — this customer paid ahead (R-1863 advance / overpayment); use it here.
              R-2023: "Use advance", partial allowed — the ONE way an advance is used. */}
          {availableCredit > 0 && customerId && (
            <UseAdvanceBox
              available={availableCredit}
              checked={applyCredit}
              applied={appliedCreditAmount}
              onCheckedChange={(v) => { setApplyCredit(v); setTypedCredit(null); setAmountEdited(false); }}
              onAmountChange={(n) => { setTypedCredit(n); setAmountEdited(false); }}
            />
          )}

          {/* Warning for over-payment */}
          {willBeOverpaid && (
            <div className="rounded-md bg-rose-soft border border-rose/30 px-3 py-2 text-xs text-rose-ink flex items-start gap-2">
              <Icon name="alert" size={13} className="flex-shrink-0 mt-0.5" />
              <span>
                Amount exceeds remaining ({rupee(remaining)}). You're recording an excess payment —
                refund or adjust if this is a mistake.
              </span>
            </div>
          )}

          {/* Partial-payment status preview */}
          {willBePartial && outcome.kind === "partial" && (
            <div data-testid="payment-outcome" className="rounded-md bg-indigo-50 border border-indigo/30 px-3 py-2 text-xs text-indigo flex items-start gap-2">
              <Icon name="info" size={13} className="flex-shrink-0 mt-0.5" />
              <span>
                This payment brings total settled to <b>{rupee(newRunningTotal)}</b>.{" "}
                <b>{outcome.sentence}</b>
              </span>
            </div>
          )}

          {/* "whole rupees" said in the label rather than left to be discovered at submit.
              This app stores money as integers (CLAUDE.md §13); a typed 1500.50 was
              previously rejected by the zod .int() with a generic message and no clue
              which field or why. */}
          <FormField label={tdsDeducted ? "Amount received in bank (₹ — whole rupees)" : PAYMENT_FIELD_LABELS.amount} required htmlFor="amount">
            <Input
              id="amount"
              type="number"
              min={tdsDeducted ? 0 : 1}
              prefix="₹"
              error={errors.amount?.message}
              helper={
                tdsDeducted
                  ? `Customer withheld ${rupee(tdsAmount)} TDS, so you should receive ${rupee(Math.max(0, remaining - tdsAmount))} in bank. Net + TDS = ${rupee(watchedAmount + tdsAmount)} settles against the quote.`
                  : hasPriorPayments
                    ? `Defaults to remaining ${rupee(remaining)}. Edit if partial.`
                    : `Defaults to full ${rupee(expectedAmount)}. Edit if partial.`
              }
              {...register("amount", { valueAsNumber: true, onChange: () => setAmountEdited(true) })}
            />
            {/* Reports a decimal BEFORE submit, and says what it would be saved as —
                rounding somebody's money without telling them is not a kindness. */}
            {/* R-2101: only for a 0 the operator TYPED. After Confirm the payments refresh,
                `remaining` drops to ₹0 and the amount effect below sets the field to 0 while the
                sheet closes — the red "more than ₹0" flashed on a payment that had just saved.
                A 0 never typed is still refused on submit (schema refine above). */}
            <FieldPill check={amountEdited && watch("amount") === 0 && !tdsDeducted
              ? { tone: "error", message: "Amount must be more than ₹0." }
              : checkMoney(Number.isFinite(watchedAmount) ? String(watchedAmount) : "")} />
          </FormField>

          {/* R-1730: no "Customer domain" here any more — a setup field, not money (UI rule 7). It
              is entered after the payment on the quote's "Setting up" card (provisioning-card);
              a domain the page already knows is still saved after the payment (see 2d). */}

          {/* ── How it was paid, and which of YOUR accounts received it (R-404) ──
              Was one list of hard-coded rows with our own company name shown to every company,
              tagging payments with made-up ids the uuid column refused. Now: a plain method
              list, and this company's own bank / cash accounts. */}
          <FormField label={PAYMENT_FIELD_LABELS.method} required htmlFor="paymentMethod">
            <Select
              value={method}
              onValueChange={(val) => {
                const m = val as PaymentMethod;
                setMethod(m);
                /* R-819: re-check the reference with THIS method's rule; drop the old one's error. */
                void applyPaymentMethod({ setValue, clearErrors, trigger, getValues }, m, isSubmitted || !!errors.reference);
              }}
            >
              <SelectTrigger id="paymentMethod">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PAYMENT_METHODS.map((m) => (
                  <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <input type="hidden" {...register("method")} value={method} />
          </FormField>

          <FormField label={PAYMENT_FIELD_LABELS.receivedIn} htmlFor="depositAccount">
            <ReceivedInField
              id="depositAccount"
              accounts={receiveAccounts}
              loading={bankAccountsLoading}
              value={bankAccountId}
              onChange={(id) => { setAccountTouched(true); setBankAccountId(id); }}
            />
          </FormField>

          {/* Received on */}
          <FormField label={PAYMENT_FIELD_LABELS.receivedOn} required htmlFor="receivedDate">
            <Input
              id="receivedDate"
              type="date"
              error={errors.receivedDate?.message}
              {...register("receivedDate")}
            />
          </FormField>

          {/* Transaction Reference Number — Dynamic prompts per payment mode */}
          <FormField
            label={referenceLabel(method)}
            htmlFor="reference"
          >
            <Input
              id="reference"
              placeholder={referencePlaceholder(method)}
              error={errors.reference?.message}
              {...register("reference")}
            />
            <p className="text-2xs text-ink-3 mt-1">
              {referenceHint(method)}
            </p>
          </FormField>

          {/* ── TDS section ─────────────────────────────────────────
              B2B customers (Pvt Ltd, LLPs, larger firms) deduct TDS
              before paying. Check the box → fields appear → on submit
              the TDS portion is logged as a receivable from govt. */}
          <TdsShortfallHint match={tdsShortfall} onApply={() => tdsShortfall && applyTdsSuggestion({ setValue }, tdsShortfall)} />
          {tdsOnly && tdsDeducted && (
            <div data-testid="tds-only-note" className="rounded-md border border-hairline bg-paper-2/60 px-3 py-2 text-xs text-ink-2">
              Recording TDS only — ₹0 to the bank. This {rupee(tdsAmount)} goes to TDS Receivable and
              clears the invoice balance. You can enter the 26AS / challan number in Reference.
            </div>
          )}
          <div className="rounded-md border border-hairline px-3 py-2.5 bg-paper-2/30">
            <label className="flex items-start gap-2 cursor-pointer text-sm">
              <input
                type="checkbox"
                className="mt-0.5"
                {...register("tdsDeducted")}
              />
              <div className="flex-1">
                <div className="font-medium text-ink">Customer deducted TDS</div>
                <div className="text-2xs text-ink-3 mt-0.5">
                  Tick this when a B2B customer paid you LESS than the quote total
                  because they withheld TDS (typically 10% u/s 194J).
                </div>
              </div>
            </label>

            {tdsDeducted && (
              <div className="mt-3 space-y-3">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <FormField label="Section" required htmlFor="tdsSection">
                    <Select
                      value={tdsSectionValue}
                      onValueChange={(v) => {
                        setValue("tdsSection", v);
                        // R-523: 194J → 194C left the rate at 10 (₹12,960 instead of ₹2,592).
                        const def = tdsDefaultRatePct(v);
                        if (def !== null) setValue("tdsRatePct", def, { shouldValidate: true });
                      }}
                    >
                      <SelectTrigger id="tdsSection">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {TDS_SECTIONS.map((s) => (
                          <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </FormField>
                  <FormField label="Rate (%)" required htmlFor="tdsRatePct">
                    <Input
                      id="tdsRatePct"
                      type="number"
                      step={0.01}
                      min={0}
                      max={100}
                      {...register("tdsRatePct", { valueAsNumber: true })}
                    />
                  </FormField>
                </div>
                {tdsRateCheck.message && (
                  <p
                    role="status"
                    data-testid="tds-rate-warning"
                    className={tdsRateCheck.knownVariant
                      ? "flex items-start gap-1.5 text-2xs text-amber-ink"
                      : "flex items-start gap-1.5 rounded-md bg-rose-soft border border-rose/30 px-2 py-1.5 text-2xs text-rose-ink"}
                  >
                    <Icon name="alert" size={12} className="flex-shrink-0 mt-0.5" />
                    <span>
                      {tdsRateCheck.message}{" "}
                      {tdsRateCheck.defaultPct !== null && (
                        <button
                          type="button"
                          className="underline font-medium"
                          onClick={() => setValue("tdsRatePct", tdsRateCheck.defaultPct ?? 0, { shouldValidate: true })}
                        >
                          Use {tdsRateCheck.defaultPct}%
                        </button>
                      )}
                    </span>
                  </p>
                )}

                {/* R-2045: a part payment request — the TDS the customer actually withheld, and
                    a warning when it is more than rate × THIS part's taxable value. */}
                {invoiceFacts?.partRequest && (() => {
                  const check = partRequestTdsCheck({ taxable: quotePreGST, ratePct: tdsRatePct, tds: tdsAmount });
                  return (
                    <FormField label="TDS deducted by the customer (₹)" htmlFor="partTdsAmount">
                      <Input
                        id="partTdsAmount"
                        type="number"
                        min={0}
                        prefix="₹"
                        value={Number.isFinite(tdsAmount) ? tdsAmount : 0}
                        helper={`${tdsRatePct}% of this part's taxable value ${rupee(quotePreGST)} is ${rupee(check.expected)}. Change it if the customer withheld a different amount.`}
                        onChange={(e) => {
                          const n = Math.max(0, Math.round(Number(e.target.value) || 0));
                          setTypedPartTds(n);
                        }}
                      />
                      {check.message && (
                        <p
                          role="status"
                          data-testid="part-tds-warning"
                          className="mt-1.5 flex items-start gap-1.5 rounded-md bg-amber-soft border border-amber/30 px-2 py-1.5 text-2xs text-amber-ink"
                        >
                          <Icon name="alert" size={12} className="flex-shrink-0 mt-0.5" />
                          <span>{check.message}</span>
                        </p>
                      )}
                    </FormField>
                  );
                })()}

                <FormField label="Customer TAN" htmlFor="customerTan">
                  <Input
                    id="customerTan"
                    placeholder="MUMS12345A (Tax Account Number)"
                    {...register("customerTan")}
                  />
                  <p className="text-3xs text-ink-3 mt-1">
                    10-character TAN of the customer (different from GSTIN). Required to verify Form 26AS deposit.
                    Saved to customer profile for future invoices.
                  </p>
                </FormField>

                {/* Live computation breakdown */}
                <div className="bg-paper rounded-md p-3 text-xs space-y-1.5">
                  <div className="text-3xs uppercase tracking-wider text-ink-3 font-semibold mb-1">
                    TDS computation
                  </div>
                  <div className="flex justify-between">
                    <span className="text-ink-3">{split ? "Due now (incl 18% GST)" : "Quote total (incl 18% GST)"}</span>
                    <span className="font-mono">{rupee(expectedAmount)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-ink-3">Pre-GST taxable value</span>
                    <span className="font-mono">{rupee(quotePreGST)}</span>
                  </div>
                  <div className="flex justify-between text-rose">
                    <span>TDS @ {tdsRatePct}% (deposited to govt)</span>
                    <span className="font-mono">−{rupee(tdsAmount)}</span>
                  </div>
                  <div className="flex justify-between pt-1.5 border-t border-hairline">
                    <span className="text-ink-3">Net to your bank</span>
                    <span className="font-mono font-semibold text-emerald">{rupee(Math.max(0, remaining - tdsAmount - appliedCreditAmount))}</span>
                  </div>
                  <div className="text-3xs text-ink-3 mt-2 leading-relaxed">
                    Adjust &quot;Amount received&quot; above to match what actually hit your bank.
                    {" "}{rupee(tdsAmount)} TDS appears as a receivable in <a href="/accounting/tds-receivable" className="underline">/accounting/tds-receivable</a>.
                    {customerId && (
                      <> Saving also sets this customer&apos;s TDS profile to <b>{tdsSectionValue} @ {tdsRatePct}%</b>.</>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>

          <FormField label={PAYMENT_FIELD_LABELS.notes} htmlFor="notes">
            <Textarea
              id="notes"
              placeholder="Any additional details about this payment…"
              rows={2}
              {...register("notes")}
            />
          </FormField>

          {/* Optional proof-of-payment attachment (screenshot / PDF). */}
          <FormField label="Payment receipt (optional)" htmlFor="receipt">
            {receiptFile ? (
              <div className="flex items-center justify-between gap-2 rounded-md border border-hairline bg-paper-2/40 px-3 py-2 text-sm">
                <span className="flex items-center gap-2 min-w-0">
                  <Icon name="file" size={14} className="shrink-0 text-ink-3" />
                  <span className="truncate text-ink">{receiptFile.name}</span>
                  <span className="shrink-0 text-2xs text-ink-3">
                    {(receiptFile.size / 1024).toFixed(0)} KB
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => setReceiptFile(null)}
                  className="shrink-0 text-ink-3 hover:text-rose"
                  aria-label="Remove attachment"
                >
                  <Icon name="x" size={15} />
                </button>
              </div>
            ) : (
              <label
                htmlFor="receipt"
                className="flex items-center gap-2 rounded-md border border-dashed border-hairline px-3 py-2 text-sm text-ink-3 cursor-pointer hover:border-amber hover:text-ink transition-colors"
              >
                <Icon name="upload" size={14} />
                Attach a screenshot or PDF
              </label>
            )}
            <input
              id="receipt"
              type="file"
              accept="image/jpeg,image/png,image/webp,application/pdf"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0] ?? null;
                if (f && f.size > 20 * 1024 * 1024) {
                  toast.error("File must be under 20 MB");
                  return;
                }
                setReceiptFile(f);
              }}
            />
            <p className="mt-1 text-2xs text-ink-3">JPG / PNG / WEBP / PDF · up to 20 MB · attached after the payment is saved.</p>
          </FormField>

          {(outcome.kind === "full" || outcome.kind === "over") && (
            <div data-testid="payment-outcome" className="bg-emerald-soft border border-emerald/20 rounded-md p-3 text-xs text-emerald flex gap-2 items-start">
              <Icon name="info" size={14} className="flex-shrink-0 mt-0.5" />
              <span>
                {instalmentInvoiceId ? (
                  /* R-1564: the money is applied to THIS instalment; any extra waits for the next. */
                  <>
                    Instalment invoice <b className="font-mono">{instalmentInvoiceId}</b> will be marked <b>paid</b>.
                    {outcome.kind === "over" ? " The extra goes to this subscription's next instalment invoice." : null}
                  </>
                ) : invoiceId ? (
                  <>
                    Invoice <b className="font-mono">{invoiceId}</b> will be marked <b>paid</b>. No new receipt voucher — post-invoice payment.
                  </>
                ) : (
                  <>
                    <b>{outcome.sentence}</b>{" "}
                    {split
                      ? null
                      : invoiceOffer.offer && issueInvoice
                      ? "The GST invoice is issued right after the payment is saved."
                      : "You can then generate the GST invoice from the quote detail page."}
                  </>
                )}
              </span>
            </div>
          )}

          {/* R-378: issue the GST invoice with the payment, as the online checkout does. */}
          {invoiceOffer.offer && (
            <div className="rounded-md border border-hairline px-3 py-2.5 bg-paper-2/30">
              <label className="flex items-start gap-2 cursor-pointer text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={issueInvoice}
                  onChange={(e) => { setIssueInvoice(e.target.checked); setIssueTouched(true); }}
                />
                <div className="flex-1">
                  <div className="font-medium text-ink">Issue GST invoice now</div>
                  <div className="text-2xs text-ink-3 mt-0.5">
                    {invoiceOffer.hint ?? "Raised as soon as the payment is saved, with this payment adjusted as an advance."}
                  </div>
                </div>
              </label>
              {invoiceFacts?.gstinNudge && (
                <p className="mt-2 text-2xs text-amber-ink" data-testid="b2c-gstin-nudge">
                  {invoiceFacts.gstinNudge.text}{" "}
                  <Link href={invoiceFacts.gstinNudge.href as never} className="underline underline-offset-2 font-medium">
                    {invoiceFacts.gstinNudge.label}?
                  </Link>
                </p>
              )}
            </div>
          )}

          {/* ── What confirming actually sets in motion ────────────────────────
              This sheet had a title and nothing else, while record_payment is the
              widest-reaching write in the app — it can create a customer, convert the
              lead, create a subscription, roll a renewal, and allocate a GST receipt
              voucher. That last one no screen has ever mentioned.

              Wording and every rule live in lib/payments/record-consequences.ts,
              unit-tested there. This only places it above the button. */}
          {watchedAmount > 0 && (
            <div className="rounded-md border border-hairline/60 bg-paper-2 p-3">
              <div className="text-2xs uppercase tracking-wider text-ink-3 font-semibold mb-2">
                What this does
              </div>
              <ConsequenceList
                items={recordPaymentConsequences({
                  payment: {
                    quoteId,
                    customerName,
                    amount: Number(watchedAmount) || 0,
                    quoteAmount: expectedAmount,
                    priorReceived: alreadyReceived,
                    createsCustomer: isProspect,
                    /* Faithful to what record_payment actually keys off: a subscription is
                       created only when a line carries a billing commitment. Without
                       lineItems this is false, so the sheet says "no subscription" rather
                       than promising one it cannot confirm. */
                    createsSubscription: (lineItems ?? []).some(
                      (l) => typeof l?.commitment === "string" && l.commitment.trim() !== "",
                    ),
                    planLabel: (lineItems ?? [])[0]?.name ?? null,
                    /* R-2101: one subscription per commitment line — name them all, not the first. */
                    planLabels: (lineItems ?? [])
                      .filter((l) => typeof l?.commitment === "string" && l.commitment.trim() !== "")
                      .map((l) => l?.name ?? "")
                      .filter((n): n is string => typeof n === "string" && n.trim() !== ""),
                    renewsSubscription: isRenewal,
                    upgradesPlan: isUpgrade,
                    addsSeats: isAddSeatsQuote,
                  },
                  /* Null once an invoice already exists — a post-invoice payment issues no
                     new receipt voucher, and claiming a number would be wrong. */
                  /* R-1564: an instalment's payment is recorded on its subscription's quote,
                     which has no invoice of its own — record_payment does issue one. */
                  receiptSeries: invoiceId && !instalmentInvoiceId ? null : (series?.receiptVoucher ?? null),
                  /* R-1680: say "No receipt voucher" — never "Issues one" beside the post-invoice note. */
                  afterInvoice: !!invoiceId && !instalmentInvoiceId,
                })}
              />
            </div>
          )}

          </div>  {/* close scrollable form body */}

          <SheetFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              loading={isSubmitting || recordPayment.isPending}
              icon="check"
            >
              {PAYMENT_FIELD_LABELS.submit}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
    <FeedbackDialog open={reportBugOpen} onOpenChange={setReportBugOpen} />
  </>
  );
}
