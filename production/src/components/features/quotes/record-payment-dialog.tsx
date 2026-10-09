/**
 * RecordPaymentDialog — log a received payment against a quote.
 *
 * Triggered from quote detail when payment_status = 'awaiting'.
 * Marks payment_status = 'received', stores method + reference + amount.
 */
"use client";

import * as React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { isSubscriptionLine, type QuoteLine } from "@/lib/subscriptions/orphan-quote";
import { useBankAccounts } from "@/lib/queries/bank";
import {
  PAYMENT_METHODS,
  defaultDepositAccountId,
  depositAccountLabel,
  depositAccounts,
  type PaymentMethod,
} from "@/lib/payments/deposit-accounts";
import { fillCustomerStateFromQuote, saveDomainAfterPayment } from "@/lib/payments/after-payment-fill";
import { FeedbackDialog } from "@/components/shared/feedback-dialog";
import { ConsequenceList } from "@/components/shared/consequence-list";
import { recordPaymentConsequences } from "@/lib/payments/record-consequences";
import { useDocumentSeries, useGenerateInvoice } from "@/lib/queries/invoices";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { invoiceHref } from "@/app/(app)/invoices/invoice-href";
import { paymentToast, cashReference, subscriptionNoteFor, type PaymentToastAction, type SubscriptionNote } from "@/lib/payments/record-payment-toast";
import {
  invoiceNowOffer,
  paymentBuyerPlace,
  shouldIssueAfterPayment,
  withIssuedInvoice,
  type BuyerPlace,
} from "@/lib/payments/record-payment-invoice";

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
import { rupee } from "@/lib/utils";
import { fiscalYearFromDate, TDS_SECTIONS } from "@/lib/queries/tds-receivable";
import { istToday } from "@/lib/dates/ist";
import { pickDomainStampTarget } from "@/lib/quotes/payment-domain";
import { isReplayResult, paymentTagPatch, replayToast } from "@/lib/payments/record-payment-replay";

const schema = z.object({
  /* R-449: ₹0 used to stop the form with no message — the browser's own min=1 check
     fired silently. The form is noValidate now and this says it. */
  amount:       z.coerce.number({ invalid_type_error: "Enter the amount received." }).int("Whole rupees only — no paise.").min(1, "Amount must be more than ₹0."),
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
}).superRefine((d, ctx) => {
  // Reference sanity — block junk like "dfg" / "asfdgdfgsdfgds". A real UTR /
  // txn id / cheque number always has digits; cash/other can be looser.
  const ref = d.reference.trim();
  const digital = d.method !== "cash" && d.method !== "other";
  if (d.method === "cash") return;
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

/** Compute TDS amount = pre-GST gross × rate%. */
function computeTds(quoteAmountInclGst: number, ratePct: number): { preGST: number; tds: number } {
  // GST is 18% built into the invoice amount → pre-GST = amount × 100/118
  const preGST = Math.round(quoteAmountInclGst * 100 / 118);
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
  /** Customer FK — used to fetch saved TAN + default TDS section/rate so the TDS section
   *  pre-fills correctly. Null for prospect quotes (no customer row yet). */
  customerId?: string | null;
  /** Show the optional Domain field (subscription quotes only — Google Workspace /
   *  M365 need the customer domain). Hidden for one-off / direct invoices. */
  askDomain?: boolean;
  /** R-453: a renewal quote — the sheet says the existing subscription is renewed. */
  isRenewal?: boolean;
  /** Pre-fill the domain field (e.g. from the customer/lead's known domain). */
  defaultDomain?: string | null;
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
  expectedAmount,
  alreadyReceived = 0,
  isProspect = false,
  invoiceId = null,
  customerId = null,
  askDomain = false,
  defaultDomain = null,
  isRenewal = false,
  lineItems,
  onRecorded,
}: RecordPaymentDialogProps) {
  const qc = useQueryClient();
  /* The receipt-voucher counter, so the sheet can name the number it will consume. */
  const { data: series } = useDocumentSeries();
  const [method, setMethod] = React.useState<PaymentMethod>("upi");
  const [bankAccountId, setBankAccountId] = React.useState<string>("");
  /* R-404: "Received in" lists THIS company's own bank / cash accounts (RLS-scoped), never a
     hard-coded row carrying our own company name. One matching account is pre-picked; several → the
     operator picks; none → a link to add one. Rules: lib/payments/deposit-accounts.ts. */
  const { data: allBankAccounts, isLoading: bankAccountsLoading } = useBankAccounts();
  const receiveAccounts = React.useMemo(() => depositAccounts(allBankAccounts), [allBankAccounts]);
  const [accountTouched, setAccountTouched] = React.useState(false);
  React.useEffect(() => {
    if (!open || accountTouched) return;
    setBankAccountId(defaultDepositAccountId(receiveAccounts, method));
  }, [open, accountTouched, receiveAccounts, method]);

  /* R-407: does this quote make a subscription? true / false from its lines (the same rule
     record_payment uses); null when the caller did not pass the lines. The domain field and
     the "start the subscription" promise follow it, so a one-time quote promises nothing. */
  const makesSubscription: boolean | null = lineItems ? lineItems.some((l) => isSubscriptionLine(l)) : null;
  const showDomain = askDomain && makesSubscription !== false;
  // Optional proof-of-payment file (screenshot / PDF). Uploaded best-effort
  // AFTER record_payment succeeds, so it never blocks the money.
  const [receiptFile, setReceiptFile] = React.useState<File | null>(null);

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
    formState: { errors, isSubmitting },
  } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: {
      amount:       remaining,
      method:       "upi",
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
  const { preGST: quotePreGST, tds: tdsAmount } = React.useMemo(
    () => tdsDeducted ? computeTds(expectedAmount, tdsRatePct) : { preGST: 0, tds: 0 },
    [tdsDeducted, tdsRatePct, expectedAmount],
  );

  // Advance credit applied to this payment — capped at the remaining balance
  // (can't apply more credit than is owed). Reduces the cash the customer needs.
  const appliedCreditAmount  = applyCredit ? Math.min(availableCredit, remaining) : 0;

  // When TDS is checked, "amount received" represents the BANK amount
  // (post-TDS). The amount we record_payment with is amount + TDS + any advance
  // credit applied (both already-settled money, not fresh cash this transaction).
  const settledAgainstQuote  = watchedAmount + (tdsDeducted ? tdsAmount : 0) + appliedCreditAmount;
  const newRunningTotal      = alreadyReceived + settledAgainstQuote;
  const willBePartial        = newRunningTotal < expectedAmount && newRunningTotal > 0;
  const willBeOverpaid       = newRunningTotal > expectedAmount;

  /* ── R-378: "Issue GST invoice now" ─────────────────────────────────────────
     The online path invoices the moment money lands (online-invoice.server.ts); the desk
     path left the owner to press Generate GST Invoice afterwards. The quote's billing cycle
     and the buyer's place of supply are read once when the sheet opens — rules in
     lib/payments/record-payment-invoice.ts (unit-tested). */
  const [invoiceFacts, setInvoiceFacts] = React.useState<{
    billingCycle: string | null;
    buyer: BuyerPlace | null;
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
      /* R-447: the quote's own Place of supply counts, not only the lead's state — order in
         paymentBuyerPlace (customer with a state → quote → lead). Before issuing, the sheet
         copies the quote's state onto a customer that has none (fillCustomerStateFromQuote). */
      const { data: c } = q.customer_id
        ? await supabase.from("customers").select("state_code, gstin, country").eq("id", q.customer_id).maybeSingle()
        : { data: null };
      // record_payment copies the lead's state + GSTIN onto the customer it creates.
      const { data: l } = !q.customer_id && q.lead_id
        ? await supabase.from("leads").select("state_code, gstin").eq("id", q.lead_id).maybeSingle()
        : { data: null };
      const buyer: BuyerPlace | null = paymentBuyerPlace({ customer: c ?? null, quote: q, lead: l ?? null });
      if (live) setInvoiceFacts({ billingCycle: q.billing_cycle ?? null, buyer });
    })();
    return () => { live = false; };
  }, [open, quoteId, invoiceId]);

  const invoiceOffer = invoiceFacts
    ? invoiceNowOffer({
        invoiceId,
        billingCycle: invoiceFacts.billingCycle,
        buyer: invoiceFacts.buyer,
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
    if (!open) {
      reset();
      setMethod("upi");
      setBankAccountId("");
      setAccountTouched(false);
      setAmountEdited(false);
      setReceiptFile(null);
    } else {
      reset({
        amount:       remaining,
        method:       "upi",
        /* R-407: named, so a re-opened sheet never carries the last payment's UTR. */
        reference:    "",
        notes:        "",
        receivedDate: istToday(),      // R-025 — same UTC trap as the defaults above.
        tdsDeducted:  false,
        tdsSection:   customerTdsDefaults.section,
        tdsRatePct:   customerTdsDefaults.ratePct,
        customerTan:  customerTdsDefaults.tan ?? "",
      });
      setAmountEdited(false);
    }
  }, [open, reset, remaining, customerTdsDefaults]);

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

      // Redeem advance credit FIRST (atomic + row-locked) so it can never be
      // double-spent if the payment insert below fails. Use the amount the RPC
      // actually consumed, not the requested amount.
      let appliedCredit = 0;
      if (appliedCreditAmount > 0 && customerId) {
        const { data: consumed, error: rErr } = await supabase.rpc("redeem_customer_credits", {
          p_customer_id: customerId,
          p_amount:      appliedCreditAmount,
          p_note:        `Applied to quote ${quoteId}`,
        });
        if (rErr) throw new Error(rErr.message);
        appliedCredit = consumed ?? 0;
      }

      const settledAmount = (tdsActive ? data.amount + tdsAmount : data.amount) + appliedCredit;

      // ── 2. Single atomic RPC — replaces 7-9 chained client mutations.
      // When TDS is deducted, call record_payment_with_tds so the TDS receivable
      // row commits in the SAME transaction (audit #22). Otherwise the plain
      // record_payment path is completely unchanged.
      const method = data.method as "upi" | "razorpay" | "bank_transfer" | "cheque" | "cash" | "other";
      const notes  = [
        data.notes || null,
        tdsActive
          ? `TDS ${data.tdsSection} @ ${tdsRatePct}% = ${rupee(tdsAmount)} on pre-GST ${rupee(quotePreGST)}`
          : null,
        appliedCredit > 0 ? `Advance credit applied ${rupee(appliedCredit)}` : null,
      ].filter(Boolean).join(" · ") || null;

      const { data: r, error } = tdsActive
        ? await supabase.rpc("record_payment_with_tds", {
            p_quote_id:     quoteId,
            p_amount:       settledAmount,
            p_method:       method,
            p_reference:    data.reference,
            p_notes:        notes,
            p_tds_amount:   tdsAmount,
            p_tds_gross:    quotePreGST,
            p_tds_net_paid: data.amount,
            p_tds_section:  data.tdsSection ?? "194J",
            p_tds_rate_pct: tdsRatePct,
            p_customer_tan: data.customerTan?.trim() || null,
            p_invoice_id:   invoiceId ?? null,
            /* R-025, and the expensive one. This read the WALL CLOCK in UTC, so a
               payment recorded at 01:00 IST on 1 April was stamped with 31 March —
               the previous financial year — and the TDS certificate for it then never
               matches the customer's 26AS.

               Two things were wrong and only one of them was the timezone: it also
               ignored the date the operator actually chose. A payment received on
               28 March and entered on 2 April belongs to FY 2025-26, whatever today
               is. The FY follows the PAYMENT date; `istToday()` is only the fallback
               for the impossible case of an empty field. */
            p_fiscal_year:  fiscalYearFromDate(data.receivedDate || istToday()),
          })
        : await supabase.rpc("record_payment", {
            p_quote_id:  quoteId,
            p_amount:    settledAmount,
            p_method:    method,
            p_reference: data.reference,
            p_notes:     notes,
          });
      /* Put redeemed advance credit back. Credit is redeemed BEFORE record_payment, so
         when nothing is recorded — the RPC failed, or (R-374) the reference was already
         recorded — the customer must not silently lose it. */
      const restoreAppliedCredit = async (why: string) => {
        if (appliedCredit <= 0 || !customerId) return;
        try {
          const { data: authC } = await supabase.auth.getUser();
          const meC = authC?.user
            ? (await supabase.from("users").select("tenant_id").eq("id", authC.user.id).maybeSingle()).data
            : null;
          if (meC) {
            await supabase.from("customer_credits").insert({
              tenant_id:       meC.tenant_id,
              customer_id:     customerId,
              amount:          appliedCredit,
              source:          "overpayment",
              source_quote_id: quoteId,
              note:            `Restored — ${why} after ₹${appliedCredit} credit was applied to quote ${quoteId}`,
              status:          "open",
            });
          }
        } catch (compErr) {
          console.error("[record-payment] credit compensation failed — advance credit may be lost, restore manually:", compErr);
        }
      };

      if (error) {
        // Compensation: record_payment failed AFTER advance credit was redeemed
        // above → put the credit back so the customer never silently loses it.
        // (The proper long-term fix is folding redemption into record_payment's
        // transaction; this saga keeps it safe without touching the money RPC.)
        await restoreAppliedCredit("payment failed");
        throw error;
      }
      if (!r) throw new Error("record_payment returned no result");

      // Idempotent replay (same reference re-submitted / RQ retry): the payment
      // already exists and record_payment did NOT insert a new row.
      const isReplay = isReplayResult(r);

      /* R-374: on a replay NOTHING after this point may run. The payment_id is the EARLIER
         payment's row — patching its date/bank account, stamping a domain, moving an
         invoice's paid_date or attaching a receipt would all rewrite that payment with this
         form's values, and the old "Payment recorded" toast hid that the new amount was
         never saved (a cheque number reused for a second instalment). Give back any credit
         redeemed for this submit, read what IS recorded, and stop. */
      if (isReplay) {
        await restoreAppliedCredit("payment reference already recorded");
        const { data: prior } = r.payment_id
          ? await supabase.from("payments").select("amount, received_at").eq("id", r.payment_id).maybeSingle()
          : { data: null };
        return {
          isReplay: true as const,
          replayOf: prior ? { amount: prior.amount, receivedAt: prior.received_at } : null,
        };
      }

      // ── 2b. Tag date + bank account that received this money ──────
      const tagPatch = paymentTagPatch({ isReplay, receivedDate: data.receivedDate, bankAccountId });
      if (r.payment_id && tagPatch) {
        const { error: bankErr } = await supabase
          .from("payments")
          .update(tagPatch)
          .eq("id", r.payment_id);
        if (bankErr) console.error("[record-payment] date/bank tag failed (payment still recorded):", bankErr);
      }

      /* R-015. `record_payment` stamps `invoices.paid_date` with the day it SETTLED,
         because it has no received-date parameter to read — the date the operator
         actually chose only arrives here, a moment later. When this payment is the one
         that closed the invoice, move paid_date onto that date so the invoice agrees
         with the receipt behind it.

         Best-effort and last, like the writes above: the money is already recorded and
         the invoice is already marked paid, so a failure here is a wrong DATE on a
         correct invoice — worth logging loudly, not worth failing the payment over.
         `paid_date` is deliberately mutable on an issued invoice (the freeze trigger
         lists it as lifecycle rather than a Rule 46 particular), so this is allowed. */
      if (r.invoice_paid && invoiceId && data.receivedDate) {
        const { error: dateErr } = await supabase
          .from("invoices")
          .update({ paid_date: data.receivedDate })
          .eq("id", invoiceId);
        if (dateErr) console.error("[record-payment] invoice paid_date not moved to the receipt date:", dateErr);
      }

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
      /* R-407: only when the field was shown — a hidden field's pre-filled default is not
         something the operator entered. */
      const domainVal = showDomain ? data.domain?.trim() : "";
      if (domainVal) {
        const { data: quoteSubs, error: subsErr } = await supabase
          .from("subscriptions")
          .select("id, vendor, domain")
          .eq("quote_id", quoteId)
          .order("created_at", { ascending: true });
        if (subsErr) console.error("[record-payment] could not read the quote's subscriptions for the domain:", subsErr);
        const targetId = subsErr ? null : pickDomainStampTarget(quoteSubs ?? [], domainVal);
        if (targetId) {
          const { error: domErr } = await supabase
            .from("subscriptions")
            .update({ domain: domainVal })
            .eq("id", targetId)
            .is("domain", null);
          if (domErr) console.error("[record-payment] domain stamp failed (payment still recorded):", domErr);
        }
        /* R-407: also onto the customer and the quote's provisioning task (blank ones only),
           so a typed domain is never lost when the quote made no subscription. */
        await saveDomainAfterPayment(supabase, { quoteId, domain: domainVal });
      }

      // ── 3. TDS receivable — now committed ATOMICALLY inside
      // record_payment_with_tds above (audit #22): either the payment AND its
      // TDS receivable both commit, or neither does. No more best-effort client
      // insert that could silently drop the government TDS credit.
      let tdsSaved = false;
      if (!isReplay && tdsActive && tdsAmount > 0) {
        tdsSaved = Boolean((r as { tds_saved?: boolean }).tds_saved);
        // Remember the customer's TAN + TDS defaults for next time — a non-money
        // UX convenience, safe to keep as a best-effort client update.
        if (customerId && data.customerTan?.trim()) {
          await supabase
            .from("customers")
            .update({
              tan:                  data.customerTan.trim(),
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
        outstanding:            r.outstanding,
        isFirstPayment:         r.is_first_payment,
        isFullyPaid:            r.is_fully_paid,
        convertedNow:           r.converted_now,
        subscriptionCreated:    r.subscription_created,
        invoicePaid:            r.invoice_paid,
        hasExistingInvoice:     r.has_existing_invoice,
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
      };
    },
    onSuccess: async (res) => {
      // Invalidate everything that this touches
      qc.invalidateQueries({ queryKey: ["quotes"] });
      qc.invalidateQueries({ queryKey: ["quotes", quoteId] });
      qc.invalidateQueries({ queryKey: ["payments"] });
      qc.invalidateQueries({ queryKey: ["payments", "by-quote", quoteId] });
      qc.invalidateQueries({ queryKey: ["leads"] });
      qc.invalidateQueries({ queryKey: ["customers"] });
      qc.invalidateQueries({ queryKey: ["contacts", "all"] });
      qc.invalidateQueries({ queryKey: ["subscriptions"] });
      qc.invalidateQueries({ queryKey: ["invoices"] });
      qc.invalidateQueries({ queryKey: ["outstanding-receivables"] });
      qc.invalidateQueries({ queryKey: ["nav-badges"] });
      qc.invalidateQueries({ queryKey: ["tds_receivable"] });
      qc.invalidateQueries({ queryKey: ["customer_credits"] });

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
      if (res.isFirstPayment && !res.subscriptionCreated && !res.isRenewalQuote) {
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
      const t = issuedInvoiceId
        ? withIssuedInvoice(toastBase, issuedInvoiceId)
        : toastBase;
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
            (data) => recordPayment.mutate(
              data.method === "cash" && !data.reference.trim()
                ? { ...data, reference: cashReference(data.receivedDate) }
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
          {/* Customer domain — R-407 / R-444 (1): shown only when the quote makes a subscription,
              and optional (no "*"): Confirm never blocked on it, so the star was a false promise.
              Saved to the subscription, the customer and the provisioning task (blanks only). */}
          {showDomain && (
            <div className="rounded-xl border border-primary/30 bg-primary-soft/30 p-3 space-y-1.5 shadow-xs">
              <FormField label="Customer domain (optional)" htmlFor="domain">
                <Input
                  id="domain"
                  placeholder="e.g. acme.com"
                  className="font-mono text-sm font-semibold bg-paper"
                  {...register("domain")}
                />
              </FormField>
              <p className="text-2xs text-ink-3">
                Needed to set up Google Workspace / Microsoft 365. You can add it later on Subscriptions.
              </p>
            </div>
          )}

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
                {newRunningTotal < expectedAmount && (
                  <p className="mt-1.5">
                    <b>{rupee(expectedAmount - newRunningTotal)} will still be due</b> — it stays on
                    this quote until paid.
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Payment summary — already paid + this payment + remaining */}
          <div className="bg-paper-2 rounded-md p-3 text-sm space-y-1.5">
            <div className="flex justify-between items-baseline">
              <span className="text-ink-3">Quote total</span>
              <span className="font-medium tabular-nums">{rupee(expectedAmount)}</span>
            </div>
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

          {/* Advance credit — this customer overpaid before; adjust it here */}
          {availableCredit > 0 && customerId && (
            <div className="rounded-md border border-emerald/30 bg-emerald-soft/40 px-3 py-2.5 text-xs">
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={applyCredit}
                  onChange={(e) => { setApplyCredit(e.target.checked); setAmountEdited(false); }}
                />
                <div className="flex-1">
                  <div className="font-medium text-ink">Apply advance credit — {rupee(availableCredit)} available</div>
                  <div className="text-ink-3 mt-0.5">
                    {applyCredit
                      ? `${rupee(appliedCreditAmount)} adjusted against this quote — the customer pays that much less in cash.`
                      : "This customer overpaid earlier. Tick to adjust it against this bill."}
                  </div>
                </div>
              </label>
            </div>
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
          {willBePartial && (
            <div className="rounded-md bg-indigo-50 border border-indigo/30 px-3 py-2 text-xs text-indigo flex items-start gap-2">
              <Icon name="info" size={13} className="flex-shrink-0 mt-0.5" />
              <span>
                This payment of <b>{rupee(watchedAmount)}</b> brings total received to <b>{rupee(newRunningTotal)}</b>.
                Quote will remain <b>partial</b> ({rupee(expectedAmount - newRunningTotal)} pending).
              </span>
            </div>
          )}

          {/* "whole rupees" said in the label rather than left to be discovered at submit.
              This app stores money as integers (CLAUDE.md §13); a typed 1500.50 was
              previously rejected by the zod .int() with a generic message and no clue
              which field or why. */}
          <FormField label={tdsDeducted ? "Amount received in bank (₹ — whole rupees)" : "Amount received (₹ — whole rupees)"} required htmlFor="amount">
            <Input
              id="amount"
              type="number"
              min={1}
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
            <FieldPill check={watch("amount") === 0
              ? { tone: "error", message: "Amount must be more than ₹0." }
              : checkMoney(Number.isFinite(watchedAmount) ? String(watchedAmount) : "")} />
          </FormField>

          {/* ── How it was paid, and which of YOUR accounts received it (R-404) ──
              Was one list of hard-coded rows with our own company name shown to every company,
              tagging payments with made-up ids the uuid column refused. Now: a plain method
              list, and this company's own bank / cash accounts. */}
          <FormField label="Payment method" required htmlFor="paymentMethod">
            <Select
              value={method}
              onValueChange={(val) => {
                const m = val as PaymentMethod;
                setMethod(m);
                setValue("method", m);
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

          <FormField label="Received in" htmlFor="depositAccount">
            {receiveAccounts.length > 0 ? (
              <>
                <Select
                  value={bankAccountId || "none"}
                  onValueChange={(val) => {
                    setAccountTouched(true);
                    setBankAccountId(val === "none" ? "" : val);
                  }}
                >
                  <SelectTrigger id="depositAccount">
                    <SelectValue placeholder="Choose the account" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Not sure yet</SelectItem>
                    {receiveAccounts.map((a) => (
                      <SelectItem key={a.id} value={a.id}>{depositAccountLabel(a)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-2xs text-ink-3 mt-1">
                  Your account that got this money. Helps match it with the bank statement.
                </p>
              </>
            ) : (
              <p id="depositAccount" className="text-xs text-ink-3">
                {bankAccountsLoading ? "Loading your accounts…" : (
                  <>
                    No bank account added yet.{" "}
                    <Link href="/accounting/banking" className="underline text-ink">Add a bank account</Link>{" "}
                    to tag where money lands. The payment saves without it.
                  </>
                )}
              </p>
            )}
          </FormField>

          {/* Payment Received Date */}
          <FormField label="Payment Received Date" required htmlFor="receivedDate">
            <Input
              id="receivedDate"
              type="date"
              error={errors.receivedDate?.message}
              {...register("receivedDate")}
            />
          </FormField>

          {/* Transaction Reference Number — Dynamic prompts per payment mode */}
          <FormField
            label={
              method === "upi" ? "UPI Transaction Ref ID (12 digits)" :
              method === "razorpay" ? "Razorpay Payment ID" :
              method === "bank_transfer" ? "Bank UTR / Transaction Ref No." :
              method === "cheque" ? "Cheque No. & Issuing Bank" :
              method === "cash" ? "Cash Voucher / Receipt Ref (Optional)" :
              "Transaction Reference"
            }
            required={method !== "cash"}
            htmlFor="reference"
          >
            <Input
              id="reference"
              placeholder={
                method === "upi" ? "e.g. 402312345678 (12-digit UTR)" :
                method === "razorpay" ? "e.g. pay_P1a2B3c4D5e6F7" :
                method === "bank_transfer" ? "e.g. N281241234567890" :
                method === "cheque" ? "e.g. Cheque #004521 - SBI Bank" :
                "e.g. Cash Receipt #CR-102"
              }
              error={errors.reference?.message}
              {...register("reference")}
            />
            <p className="text-2xs text-ink-3 mt-1">
              {
                method === "upi" ? "12-digit UTR/UPI reference from GPay, PhonePe, Paytm or your bank QR." :
                method === "razorpay" ? "Unique Razorpay payment ID starting with pay_." :
                method === "bank_transfer" ? "Bank UTR or NEFT/RTGS reference number from bank statement." :
                method === "cheque" ? "Enter 6-digit cheque number and customer's bank name for clearing." :
                method === "cash" ? "Optional. Leave blank and it is saved as Cash + date and time." : "Optional internal cash voucher or receipt reference."
              }
            </p>
          </FormField>

          {/* ── TDS section ─────────────────────────────────────────
              B2B customers (Pvt Ltd, LLPs, larger firms) deduct TDS
              before paying. Check the box → fields appear → on submit
              the TDS portion is logged as a receivable from govt. */}
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
                      value={watch("tdsSection") ?? "194J"}
                      onValueChange={(v) => setValue("tdsSection", v)}
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
                    <span className="text-ink-3">Quote total (incl 18% GST)</span>
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
                    <span className="font-mono font-semibold text-emerald">{rupee(expectedAmount - tdsAmount)}</span>
                  </div>
                  <div className="text-3xs text-ink-3 mt-2 leading-relaxed">
                    Adjust &quot;Amount received&quot; above to match what actually hit your bank.
                    The quote will be marked fully satisfied — {rupee(tdsAmount)} TDS appears as a receivable in <a href="/accounting/tds-receivable" className="underline">/accounting/tds-receivable</a>.
                  </div>
                </div>
              </div>
            )}
          </div>

          <FormField label="Notes (optional)" htmlFor="notes">
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

          {newRunningTotal >= expectedAmount && (
            <div className="bg-emerald-soft border border-emerald/20 rounded-md p-3 text-xs text-emerald flex gap-2 items-start">
              <Icon name="info" size={14} className="flex-shrink-0 mt-0.5" />
              <span>
                {invoiceId ? (
                  <>
                    Invoice <b className="font-mono">{invoiceId}</b> will be marked <b>paid</b>. No new receipt voucher — post-invoice payment.
                  </>
                ) : (
                  <>
                    Quote will be marked <b>fully paid</b>.{" "}
                    {invoiceOffer.offer && issueInvoice
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
                    renewsSubscription: isRenewal,
                  },
                  /* Null once an invoice already exists — a post-invoice payment issues no
                     new receipt voucher, and claiming a number would be wrong. */
                  receiptSeries: invoiceId ? null : (series?.receiptVoucher ?? null),
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
              Confirm payment
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
    <FeedbackDialog open={reportBugOpen} onOpenChange={setReportBugOpen} />
  </>
  );
}
