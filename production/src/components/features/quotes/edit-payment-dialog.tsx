/**
 * EditPaymentDialog — correct a recorded payment's SAFE fields.
 *
 * Editable: method, transaction reference, received date, notes.
 * LOCKED:   amount (shown read-only for context).
 *
 * Why amount is locked: recording a payment issues a GST receipt voucher and
 * drives subscription + invoice state. Under GST you can't silently change an
 * issued voucher's value — an amount mistake must be reversed (refund voucher)
 * and re-recorded, not edited. This dialog only fixes data-entry typos in the
 * non-money fields (wrong UPI ref, wrong method, wrong date, notes).
 */
"use client";

import * as React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";

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
import { useUpdatePayment, type Payment } from "@/lib/queries/payments";
import { useBankAccounts } from "@/lib/queries/bank";
import { rupee, bankLabel } from "@/lib/utils";
import { blankReference } from "@/lib/payments/record-payment-toast";

const METHODS = [
  { value: "upi",           label: "UPI (Google Pay / PhonePe / Paytm)" },
  { value: "razorpay",      label: "Razorpay (online)" },
  { value: "bank_transfer", label: "Bank transfer (NEFT/RTGS/IMPS)" },
  { value: "cheque",        label: "Cheque" },
  { value: "cash",          label: "Cash" },
  { value: "other",         label: "Other" },
] as const;

const schema = z.object({
  method:        z.enum(["upi", "razorpay", "bank_transfer", "cheque", "cash", "other"]),
  /* R-1444: optional — a cleared one is saved as "<Method> <date> <time>" (blankReference). */
  reference:     z.string(),
  receivedDate:  z.string().min(1, "Date required"),
  notes:         z.string().optional(),
  bankAccountId: z.string().optional(),   // "" = not linked
});
type FormData = z.infer<typeof schema>;

interface EditPaymentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  payment: Payment | null;
  customerName: string;
}

export function EditPaymentDialog({ open, onOpenChange, payment, customerName }: EditPaymentDialogProps) {
  const updatePayment = useUpdatePayment();
  const { data: bankAccounts } = useBankAccounts();
  const [method, setMethod] = React.useState<FormData["method"]>("upi");
  const [bankAccountId, setBankAccountId] = React.useState<string>("");

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: { method: "upi", reference: "", receivedDate: "", notes: "", bankAccountId: "" },
  });

  // Re-seed the form whenever a different payment opens.
  React.useEffect(() => {
    if (open && payment) {
      const m = payment.method;
      setMethod(m);
      setBankAccountId(payment.bank_account_id ?? "");
      reset({
        method:        m,
        reference:     payment.reference ?? "",
        receivedDate:  payment.received_at ? payment.received_at.slice(0, 10) : "",
        notes:         payment.notes ?? "",
        bankAccountId: payment.bank_account_id ?? "",
      });
    }
  }, [open, payment, reset]);

  if (!payment) return null;

  const onSubmit = (data: FormData) => {
    // Preserve the original time-of-day; only the calendar date is user-editable.
    // Anchor to noon local to avoid the date shifting across the UTC boundary.
    const originalDate = payment.received_at?.slice(0, 10);
    const received_at =
      data.receivedDate === originalDate
        ? payment.received_at
        : new Date(`${data.receivedDate}T12:00:00`).toISOString();

    updatePayment.mutate(
      {
        id:              payment.id,
        // method + bankAccountId are controlled by local state (the Radix
        // Selects), so read them directly — the hidden-input/register bridge
        // can lag a click, which silently dropped the bank tag.
        method,
        reference:       data.reference.trim() || blankReference(method, data.receivedDate),
        received_at,
        notes:           data.notes?.trim() || null,
        bank_account_id: bankAccountId || null,
      },
      { onSuccess: () => onOpenChange(false) },
    );
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-[480px] p-0 flex flex-col overflow-x-hidden">
        <SheetHeader>
          <SheetTitle>Edit payment details</SheetTitle>
          <SheetDescription>
            Correct a data-entry mistake on this payment from <b>{customerName}</b>{" "}
            (quote <span className="font-mono font-semibold">{payment.quote_id}</span>).
          </SheetDescription>
        </SheetHeader>

        <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col flex-1 min-h-0 w-full">
          <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-4">
            {/* Amount — LOCKED. Shown for context only. */}
            <div className="rounded-md bg-paper-2 border border-hairline px-3 py-2.5">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">Amount received</p>
                  <p className="font-serif text-xl tabular-nums text-ink mt-0.5">{rupee(payment.amount)}</p>
                </div>
                <span className="inline-flex items-center gap-1 text-2xs text-ink-3">
                  <Icon name="lock" size={12} /> Locked
                </span>
              </div>
              <p className="text-2xs text-ink-3 mt-1.5 leading-relaxed">
                Amount can&apos;t be edited — it drives the GST receipt voucher &amp; subscription.
                If the amount is wrong, reverse this payment and record a fresh one.
              </p>
            </div>

            <FormField label="Payment method" required htmlFor="edit-method">
              <Select
                value={method}
                onValueChange={(v) => {
                  const mv = v as FormData["method"];
                  setMethod(mv);
                  (register("method") as unknown as { onChange: (e: unknown) => void }).onChange({
                    target: { value: mv, name: "method" },
                  });
                }}
              >
                <SelectTrigger id="edit-method">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {METHODS.map((m) => (
                    <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <input type="hidden" {...register("method")} value={method} />
            </FormField>

            <FormField label="Transaction reference (Optional)" htmlFor="edit-reference">
              <Input
                id="edit-reference"
                placeholder="UPI Ref / UTR / Cheque no."
                error={errors.reference?.message}
                {...register("reference")}
              />
            </FormField>

            <FormField label="Received on" required htmlFor="edit-date">
              <Input
                id="edit-date"
                type="date"
                error={errors.receivedDate?.message}
                {...register("receivedDate")}
              />
            </FormField>

            <FormField label="Received in (bank account)" htmlFor="edit-bank">
              <Select
                value={bankAccountId || "none"}
                onValueChange={(v) => {
                  const val = v === "none" ? "" : v;
                  setBankAccountId(val);
                  (register("bankAccountId") as unknown as { onChange: (e: unknown) => void }).onChange({
                    target: { value: val, name: "bankAccountId" },
                  });
                }}
              >
                <SelectTrigger id="edit-bank">
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
              <input type="hidden" {...register("bankAccountId")} value={bankAccountId} />
              <p className="mt-1 text-2xs text-ink-3">
                Tags which account received this money (for reports + easier reconciliation).
                Doesn&apos;t change the account balance — that comes from your bank statement.
              </p>
            </FormField>

            <FormField label="Notes (optional)" htmlFor="edit-notes">
              <Textarea
                id="edit-notes"
                placeholder="Any additional details about this payment…"
                rows={2}
                {...register("notes")}
              />
            </FormField>
          </div>

          <SheetFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={isSubmitting || updatePayment.isPending} icon="check">
              Save changes
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}
