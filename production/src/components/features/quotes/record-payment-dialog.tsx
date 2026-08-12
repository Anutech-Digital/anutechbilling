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
import { rupee, bankLabel } from "@/lib/utils";
import { fiscalYearFromDate, TDS_SECTIONS } from "@/lib/queries/tds-receivable";
import { useBankAccounts } from "@/lib/queries/bank";

const METHODS = [
  { value: "upi",           label: "UPI (Google Pay / PhonePe / Paytm)" },
  { value: "razorpay",      label: "Razorpay (online)" },
  { value: "bank_transfer", label: "Bank transfer (NEFT/RTGS/IMPS)" },
  { value: "cheque",        label: "Cheque" },
  { value: "cash",          label: "Cash" },
  { value: "other",         label: "Other" },
] as const;

const schema = z.object({
  amount:       z.coerce.number().int().min(1, "Amount received required"),
  method:       z.string().min(1, "Method required"),
  reference:    z.string().min(1, "Transaction reference required"),
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
  /** Pre-fill the domain field (e.g. from the customer/lead's known domain). */
  defaultDomain?: string | null;
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
}: RecordPaymentDialogProps) {
  const qc = useQueryClient();
  const [method, setMethod] = React.useState("upi");
  const [bankAccountId, setBankAccountId] = React.useState<string>("");
  // Optional proof-of-payment file (screenshot / PDF). Uploaded best-effort
  // AFTER record_payment succeeds, so it never blocks the money.
  const [receiptFile, setReceiptFile] = React.useState<File | null>(null);
  const { data: bankAccounts } = useBankAccounts();

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
    formState: { errors, isSubmitting },
  } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: {
      amount:      remaining,
      method:      "upi",
      domain:      defaultDomain ?? "",
      tdsDeducted: false,
      tdsSection:  "194J",
      tdsRatePct:  10,
      customerTan: "",
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

  React.useEffect(() => {
    if (!open) {
      reset();
      setMethod("upi");
      setBankAccountId("");
      setAmountEdited(false);
      setReceiptFile(null);
    } else {
      reset({
        amount:      remaining,
        method:      "upi",
        tdsDeducted: false,
        tdsSection:  customerTdsDefaults.section,
        tdsRatePct:  customerTdsDefaults.ratePct,
        customerTan: customerTdsDefaults.tan ?? "",
      });
      setAmountEdited(false);
    }
  }, [open, reset, remaining, customerTdsDefaults]);

  // Keep the bank amount locked to (remaining − TDS) until the user hand-edits
  // it, so net + TDS always settles the quote EXACTLY — no accidental ₹-few
  // over/under-shoot that used to trip a false "excess payment" warning.
  React.useEffect(() => {
    if (amountEdited) return;
    setValue("amount", Math.max(0, remaining - (tdsDeducted ? tdsAmount : 0) - appliedCreditAmount));
  }, [tdsDeducted, tdsAmount, remaining, amountEdited, appliedCreditAmount, setValue]);

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
          ? `TDS ${data.tdsSection} @ ${tdsRatePct}% = ₹${tdsAmount.toLocaleString("en-IN")} on pre-GST ₹${quotePreGST.toLocaleString("en-IN")}`
          : null,
        appliedCredit > 0 ? `Advance credit applied ₹${appliedCredit.toLocaleString("en-IN")}` : null,
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
            p_fiscal_year:  fiscalYearFromDate(new Date().toISOString().slice(0, 10)),
          })
        : await supabase.rpc("record_payment", {
            p_quote_id:  quoteId,
            p_amount:    settledAmount,
            p_method:    method,
            p_reference: data.reference,
            p_notes:     notes,
          });
      if (error) {
        // Compensation: record_payment failed AFTER advance credit was redeemed
        // above → put the credit back so the customer never silently loses it.
        // (The proper long-term fix is folding redemption into record_payment's
        // transaction; this saga keeps it safe without touching the money RPC.)
        if (appliedCredit > 0 && customerId) {
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
                note:            `Restored — payment failed after ₹${appliedCredit} credit was applied to quote ${quoteId}`,
                status:          "open",
              });
            }
          } catch (compErr) {
            console.error("[record-payment] credit compensation failed — advance credit may be lost, restore manually:", compErr);
          }
        }
        throw error;
      }
      if (!r) throw new Error("record_payment returned no result");

      // Idempotent replay (same reference re-submitted / RQ retry): the payment
      // already exists and record_payment did NOT insert a new row. Skip the
      // best-effort TDS + overpayment-credit inserts below so they don't
      // double-fire (which would duplicate a customer credit or a TDS row).
      const isReplay = Boolean(r.already_recorded || r.idempotent_replay);

      // ── 2b. Tag which bank account received this money (best-effort) ──────
      // Additive to the RPC — a reporting/reconciliation aid, NOT a balance
      // mover. If it fails the payment is still recorded; the operator can set
      // it later from the payment's Edit sheet.
      if (bankAccountId && r.payment_id) {
        const { error: bankErr } = await supabase
          .from("payments")
          .update({ bank_account_id: bankAccountId })
          .eq("id", r.payment_id);
        if (bankErr) console.error("[record-payment] bank_account tag failed (payment still recorded):", bankErr);
      }

      // ── 2c. Attach the optional payment-receipt file (best-effort) ───────
      // Uploaded AFTER the money is recorded, via the admin server route. A
      // failed upload only warns — the payment is already saved and the file
      // can be re-attached later. Skipped on replay (no new row to attach to).
      if (receiptFile && r.payment_id && !isReplay) {
        try {
          const fd = new FormData();
          fd.append("file", receiptFile);
          const res = await fetch(`/api/payments/${r.payment_id}/receipt`, { method: "POST", body: fd });
          if (!res.ok) {
            const j = await res.json().catch(() => ({}));
            console.error("[record-payment] receipt upload failed (payment still recorded):", j?.error);
            toast.warning("Payment saved — the receipt didn't attach. You can add it later from the payment.");
          }
        } catch (e) {
          console.error("[record-payment] receipt upload error (payment still recorded):", e);
          toast.warning("Payment saved — the receipt didn't attach. You can add it later from the payment.");
        }
      }

      // ── 2d. Stamp the optional domain onto the subscription (best-effort). ──
      // record_payment creates/keeps the subscription(s) (linked by quote_id).
      // Google Workspace / M365 / Zoho subscriptions need the customer's domain,
      // so we capture it optionally here and set it if one was entered and it
      // isn't already set (never overwrite). Non-money metadata — a failure
      // only logs; the domain can still be added later on the Subscriptions
      // page. Matches 0 rows harmlessly for one-off / direct-invoice quotes.
      //
      // A quote can now hold MULTIPLE subscriptions (support/hosting/etc.
      // alongside Workspace/M365/Zoho — record_payment 0172 fans out one
      // subscription per line item). A blind "any subscription on this quote
      // with no domain yet" update would risk stamping a Workspace domain
      // onto an unrelated hosting/support subscription, and if 2+ rows
      // qualified in one UPDATE, the same-quote-domain uniqueness rule would
      // reject the write outright. So: look up the single domain-relevant
      // (Workspace/M365/Zoho) subscription first, then update it by id.
      const domainVal = data.domain?.trim();
      if (domainVal) {
        const { data: domainSub, error: findErr } = await supabase
          .from("subscriptions")
          .select("id")
          .eq("quote_id", quoteId)
          .in("vendor", ["google", "microsoft", "zoho"])
          .is("domain", null)
          .limit(1)
          .maybeSingle();
        if (findErr) {
          console.error("[record-payment] domain stamp lookup failed (payment still recorded):", findErr);
        } else if (domainSub) {
          const { error: domErr } = await supabase
            .from("subscriptions")
            .update({ domain: domainVal })
            .eq("id", domainSub.id);
          if (domErr) console.error("[record-payment] domain stamp failed (payment still recorded):", domErr);
        }
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

      // ── 4. Overpayment → customer advance credit (best-effort, like TDS row).
      // The RPC floors outstanding at 0, so any excess would otherwise vanish.
      // Record only the INCREMENTAL excess this payment caused (so multiple
      // installments don't double-count) as an 'open' credit for the customer.
      const priorReceived = (r.total_received ?? 0) - settledAmount;
      const priorOverpaid = Math.max(0, priorReceived - (r.expected ?? 0));
      const overpaidNow   = Math.max(0, (r.total_received ?? 0) - (r.expected ?? 0));
      const creditAmount  = Math.max(0, overpaidNow - priorOverpaid);
      let creditRecorded  = 0;
      if (!isReplay && creditAmount > 0 && r.customer_id) {
        const { data: authData2 } = await supabase.auth.getUser();
        if (authData2?.user) {
          const { data: me2 } = await supabase
            .from("users").select("tenant_id").eq("id", authData2.user.id).maybeSingle();
          if (me2) {
            const credErr = (await supabase.from("customer_credits").insert({
              tenant_id:         me2.tenant_id,
              customer_id:       r.customer_id,
              amount:            creditAmount,
              source:            "overpayment",
              source_payment_id: r.payment_id,
              source_quote_id:   quoteId,
              note:              `Excess over quote ${quoteId}`,
              status:            "open",
            })).error;
            if (credErr) console.error("[record-payment] customer credit insert failed (payment still recorded):", credErr);
            else creditRecorded = creditAmount;
          }
        }
      }

      // Re-shape into the camelCase keys the onSuccess handler already consumes
      return {
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
      };
    },
    onSuccess: (res) => {
      // Best-effort instant nudge — if this payment created/changed a support
      // subscription, don't make the customer wait for the next scheduled
      // flush. Silent on failure: the scheduled flush is the real safety net.
      fetch("/api/internal/support-sync-nudge", { method: "POST" }).catch(() => {});

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

      if (res.renewalRolledForward) {
        // Renewal quote fully paid — subscription rolled forward 1 year
        toast.success("Renewal payment received · subscription rolled forward 1 year 🎉", { duration: 6000 });
        setTimeout(() => toast.info("Reminder cadence reset · next cycle starts T-15 of new renewal date", { duration: 6000 }), 800);
      } else if (res.isRenewalQuote && !res.isFullyPaid) {
        // Partial payment against a renewal quote — sub NOT rolled forward yet
        toast.success(`Partial renewal payment recorded · ₹${res.outstanding.toLocaleString("en-IN")} still due to renew`, { duration: 6000 });
      } else if (res.convertedNow) {
        // First payment on prospect — customer created. Only claim the
        // subscription was activated if the RPC actually created one (it skips
        // creation when the quote has no billing commitment) — never fake it.
        const subPart = res.subscriptionCreated ? " + subscription activated" : "";
        if (res.isFullyPaid) {
          toast.success(`Paid in full · Customer created${subPart} 🎉`, { duration: 5000 });
        } else {
          toast.success(`Advance received · Customer created${subPart}`, { duration: 5000 });
          setTimeout(() => toast.info(`₹${res.outstanding.toLocaleString("en-IN")} outstanding — balance pending`, { duration: 6000 }), 600);
        }
        if (res.subscriptionCreated) {
          setTimeout(() => toast.success("Subscription created · renewal in 1 year", { duration: 5000 }), 1200);
        } else {
          // Money is in + customer created, but no subscription — surface it so
          // the paid customer doesn't silently miss the renewal cycle.
          setTimeout(() => toast.warning("No subscription created — check the quote's billing commitment, then add the subscription manually", { duration: 7000 }), 1200);
        }
      } else if (res.invoicePaid) {
        // Post-invoice balance payment that fully cleared the invoice
        toast.success("Balance received · invoice marked paid 🎉", { duration: 5000 });
      } else if (res.hasExistingInvoice) {
        // Post-invoice payment but invoice still has balance
        toast.success(
          `Payment recorded against invoice · ₹${res.outstanding.toLocaleString("en-IN")} still pending`,
          { duration: 5000 },
        );
      } else if (res.isFullyPaid) {
        toast.success("Final payment received · invoice can now be generated", { duration: 5000 });
      } else {
        toast.success(
          `Payment recorded · ₹${res.outstanding.toLocaleString("en-IN")} still pending`,
          { duration: 5000 },
        );
      }
      // Overpayment acknowledgement — money was received above the quote and
      // saved as an advance credit (not lost).
      if (res.overpaidCredit > 0) {
        setTimeout(() => {
          toast.info(
            `₹${res.overpaidCredit.toLocaleString("en-IN")} received in excess — saved as an advance credit for ${customerName}. Adjust it against their next bill.`,
            { duration: 8000 },
          );
        }, 900);
      }
      // TDS receivable acknowledgement — only when the row ACTUALLY saved.
      if (res.tdsRecorded && res.tdsAmount > 0) {
        setTimeout(() => {
          toast.info(
            `TDS receivable ₹${res.tdsAmount.toLocaleString("en-IN")} logged · chase Form 16A from ${customerName}`,
            { duration: 6000 },
          );
        }, 700);
      } else if (res.tdsAttempted) {
        // TDS was requested but the row failed to save — tell the truth so the
        // owner adds it manually and doesn't lose the credit at ITR time.
        setTimeout(() => {
          toast.warning(
            `Payment saved, but the TDS receivable row failed — add it manually so you don't lose the ₹${res.tdsAmount.toLocaleString("en-IN")} credit`,
            { duration: 8000 },
          );
        }, 700);
      }
      onOpenChange(false);
    },
    onError: (err) => toast.error((err as Error).message),
  });

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-[480px] md:max-w-[560px] p-0 flex flex-col overflow-x-hidden"
      >
        <SheetHeader>
          <SheetTitle>
            {hasPriorPayments ? "Record additional payment" : "Record payment received"}
          </SheetTitle>
          <SheetDescription>
            Log a payment against quote <span className="font-mono font-semibold">{quoteId}</span> from <b>{customerName}</b>.
            {hasPriorPayments
              ? " Multiple payments are supported (installments / partial)."
              : " You can record more payments later if it's paid in installments."}
          </SheetDescription>
        </SheetHeader>

        <form
          onSubmit={handleSubmit((data) => recordPayment.mutate(data))}
          className="flex flex-col flex-1 min-h-0 min-w-0 w-full"
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
                  <li>Start the 1-year subscription with today's date</li>
                  <li>Track any outstanding balance separately</li>
                </ul>
                {newRunningTotal < expectedAmount && (
                  <p className="mt-1.5">
                    <b>Service activates with ₹{(expectedAmount - newRunningTotal).toLocaleString("en-IN")} outstanding</b> —
                    you'll continue to see this in the subscription card until paid.
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
            <div className="rounded-md bg-rose-soft border border-rose/30 px-3 py-2 text-xs text-rose flex items-start gap-2">
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

          <FormField label={tdsDeducted ? "Amount received in bank (₹)" : "Amount received (₹)"} required htmlFor="amount">
            <Input
              id="amount"
              type="number"
              min={1}
              prefix="₹"
              error={errors.amount?.message}
              helper={
                tdsDeducted
                  ? `Customer withheld ₹${tdsAmount.toLocaleString("en-IN")} TDS, so you should receive ₹${Math.max(0, remaining - tdsAmount).toLocaleString("en-IN")} in bank. Net + TDS = ₹${(watchedAmount + tdsAmount).toLocaleString("en-IN")} settles against the quote.`
                  : hasPriorPayments
                    ? `Defaults to remaining ${rupee(remaining)}. Edit if partial.`
                    : `Defaults to full ${rupee(expectedAmount)}. Edit if partial.`
              }
              {...register("amount", { valueAsNumber: true, onChange: () => setAmountEdited(true) })}
            />
          </FormField>

          <FormField label="Payment method" required htmlFor="method">
            <Select
              value={method}
              onValueChange={(v) => {
                setMethod(v);
                (register("method") as any).onChange({ target: { value: v, name: "method" } });
              }}
            >
              <SelectTrigger id="method">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {METHODS.map((m) => (
                  <SelectItem key={m.value} value={m.value}>
                    {m.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <input type="hidden" {...register("method")} value={method} />
          </FormField>

          {(bankAccounts?.length ?? 0) > 0 && (
            <FormField label="Received in (bank account)" htmlFor="bankAccount">
              <Select value={bankAccountId || "none"} onValueChange={(v) => setBankAccountId(v === "none" ? "" : v)}>
                <SelectTrigger id="bankAccount">
                  <SelectValue placeholder="Not linked" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Not linked</SelectItem>
                  {(bankAccounts ?? []).map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.name} · {bankLabel(a.bank_name, a.account_number_last4)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[11px] text-ink-3 mt-1">
                Tags which account got the money (for reports + easier reconciliation).
                Balance still comes from your bank statement, not this.
              </p>
            </FormField>
          )}

          <FormField label="Transaction reference" required htmlFor="reference">
            <Input
              id="reference"
              placeholder={
                method === "upi" ? "UPI Ref ID (e.g., 4xxxxxxxxxxx)" :
                method === "razorpay" ? "pay_xxxxxxxxxxxxxx" :
                method === "bank_transfer" ? "UTR / Bank reference" :
                method === "cheque" ? "Cheque number" :
                "Reference number"
              }
              error={errors.reference?.message}
              {...register("reference")}
            />
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
                <div className="text-[11px] text-ink-3 mt-0.5">
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
                  <p className="text-[10px] text-ink-3 mt-1">
                    10-character TAN of the customer (different from GSTIN). Required to verify Form 26AS deposit.
                    Saved to customer profile for future invoices.
                  </p>
                </FormField>

                {/* Live computation breakdown */}
                <div className="bg-paper rounded-md p-3 text-xs space-y-1.5">
                  <div className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold mb-1">
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
                  <div className="text-[10px] text-ink-3 mt-2 leading-relaxed">
                    Adjust &quot;Amount received&quot; above to match what actually hit your bank.
                    The quote will be marked fully satisfied — ₹{tdsAmount.toLocaleString("en-IN")} TDS appears as a receivable in <a href="/accounting/tds-receivable" className="underline">/accounting/tds-receivable</a>.
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

          {/* Domain — optional. Google Workspace / M365 subscriptions are keyed
              to the customer's domain; capture it here so the subscription is
              ready to provision. Purely optional — leave blank if not known yet. */}
          {askDomain && (
            <FormField label="Customer domain (optional)" htmlFor="domain">
              <Input
                id="domain"
                placeholder="acme.in — needed for Google Workspace / M365 provisioning"
                {...register("domain")}
              />
            </FormField>
          )}

          {/* Optional proof-of-payment attachment (screenshot / PDF). */}
          <FormField label="Payment receipt (optional)" htmlFor="receipt">
            {receiptFile ? (
              <div className="flex items-center justify-between gap-2 rounded-md border border-hairline bg-paper-2/40 px-3 py-2 text-sm">
                <span className="flex items-center gap-2 min-w-0">
                  <Icon name="file" size={14} className="shrink-0 text-ink-3" />
                  <span className="truncate text-ink">{receiptFile.name}</span>
                  <span className="shrink-0 text-[11px] text-ink-3">
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
            <p className="mt-1 text-[11px] text-ink-3">JPG / PNG / WEBP / PDF · up to 20 MB · attached after the payment is saved.</p>
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
                    Quote will be marked <b>fully paid</b>. You can then generate the GST invoice from the quote detail page.
                  </>
                )}
              </span>
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
  );
}
