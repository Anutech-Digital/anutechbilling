/**
 * R-1525 — "Record payment — multiple invoices".
 *
 * Pardeep (17 Oct, R-1524): a customer pays several invoices with ONE transfer. Before this
 * the payment could only be recorded against one quote/invoice, and the rest became advance
 * credit. Here the operator enters the money once, the sheet spreads it over the customer's
 * open invoices oldest first (editable per line, TDS per line with the R-1520 hint), and
 * record_multi_invoice_payment saves every line — or none — in one transaction. Whatever is
 * left becomes advance credit through record_payment's own overpayment path.
 *
 * Issued GST invoices are never merged (R-1524 decision): each invoice keeps its own number
 * and gets its own payment row.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { useFieldArray, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { toastError } from "@/lib/errors/toast-error";
import { useBankAccounts } from "@/lib/queries/bank";
import { useCustomerOpenInvoices, useRecordMultiInvoicePayment } from "@/lib/queries/payments";
import {
  PAYMENT_METHODS,
  defaultDepositAccountId,
  depositAccountLabel,
  depositAccounts,
  type PaymentMethod,
} from "@/lib/payments/deposit-accounts";
import { paymentRefProblem } from "@/lib/forms/poka-yoke";
import { cashReference } from "@/lib/payments/record-payment-toast";
import { tdsShortfallLine } from "@/lib/accounting/tds-match";
import { istToday } from "@/lib/dates/ist";
import { rupee, formatDate } from "@/lib/utils";
import { invoiceHref } from "@/app/(app)/invoices/invoice-href";
import { CustomerCombobox } from "@/components/features/customers/customer-combobox";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import {
  fifoAllocate,
  lineTdsHint,
  openInvoicesOldestFirst,
  summarise,
  toRpcAllocations,
} from "./multi-invoice-allocation";

const lineSchema = z.object({
  invoiceId:  z.string(),
  amount:     z.coerce.number({ invalid_type_error: "Enter rupees." }).int("Whole rupees only.").min(0, "Cannot be negative."),
  tds:        z.coerce.number({ invalid_type_error: "Enter rupees." }).int("Whole rupees only.").min(0, "Cannot be negative."),
  tdsSection: z.string().optional(),
  tdsRatePct: z.number().optional(),
});

export const multiInvoicePaymentSchema = z.object({
  customerId:     z.string().min(1, "Choose the customer who paid."),
  received:       z.coerce.number({ invalid_type_error: "Enter the amount received." }).int("Whole rupees only — no paise.").min(1, "Amount must be more than ₹0."),
  receivedDate:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Payment date required."),
  method:         z.string().min(1, "Choose how the money came in."),
  bankAccountId:  z.string(),
  reference:      z.string(),
  notes:          z.string().optional(),
  excessToCredit: z.boolean(),
  lines:          z.array(lineSchema),
}).superRefine((d, ctx) => {
  const ref = d.reference.trim();
  if (d.method === "cash") return;   // blank cash reference is filled on submit (R-248)
  const problem = ref ? paymentRefProblem(d.method, ref) : "Enter the UTR / cheque no. / transaction ID.";
  if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["reference"], message: problem });
});

type FormData = z.infer<typeof multiInvoicePaymentSchema>;

export function MultiInvoicePaymentDialog({
  open,
  onOpenChange,
  customerId: fixedCustomerId = null,
  customerName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Set on the customer page; null on /payments → the sheet asks for the customer. */
  customerId?: string | null;
  customerName?: string | null;
}) {
  const form = useForm<FormData>({
    resolver: zodResolver(multiInvoicePaymentSchema),
    defaultValues: {
      customerId: fixedCustomerId ?? "",
      received: 0,
      receivedDate: istToday(),
      method: "bank_transfer",
      bankAccountId: "",
      reference: "",
      notes: "",
      excessToCredit: true,
      lines: [],
    },
  });
  const { register, handleSubmit, setValue, watch, control, reset, formState: { errors } } = form;
  const { fields, replace } = useFieldArray({ control, name: "lines" });

  const customerId = watch("customerId");
  const received = Number(watch("received")) || 0;
  const method = watch("method");
  const bankAccountId = watch("bankAccountId");
  const lines = watch("lines");

  const { data: rawInvoices, isLoading: invoicesLoading, error: invoicesError } = useCustomerOpenInvoices(open ? customerId : null);
  const invoices = React.useMemo(() => openInvoicesOldestFirst(rawInvoices ?? []), [rawInvoices]);
  const { data: bankAccounts } = useBankAccounts();
  const receiveAccounts = React.useMemo(() => depositAccounts(bankAccounts), [bankAccounts]);
  const record = useRecordMultiInvoicePayment();

  /* Lines follow the received amount (oldest first) until the operator types into one. */
  const [manual, setManual] = React.useState(false);

  /* Reset when the sheet opens. */
  React.useEffect(() => {
    if (!open) return;
    reset({
      customerId: fixedCustomerId ?? "", received: 0, receivedDate: istToday(), method: "bank_transfer",
      bankAccountId: "", reference: "", notes: "", excessToCredit: true, lines: [],
    });
    setManual(false);
  }, [open, fixedCustomerId, reset]);

  const autoFill = React.useCallback((amount: number) => {
    replace(fifoAllocate(amount, invoices).map((l) => ({ ...l, tdsSection: undefined, tdsRatePct: undefined })));
    setManual(false);
  }, [invoices, replace]);
  /* Keyed on the invoices' ids + dues, not the array: a refetch with the same rows must not
     wipe what the operator typed. */
  const invoicesKey = invoices.map((i) => `${i.id}:${i.due}`).join(",");
  React.useEffect(() => { if (open) autoFill(received); }, [open, invoicesKey]); // eslint-disable-line react-hooks/exhaustive-deps
  React.useEffect(() => { if (open && !manual) autoFill(received); }, [received]); // eslint-disable-line react-hooks/exhaustive-deps


  /* Pre-pick the account when the company has exactly one that fits the method (R-404). */
  React.useEffect(() => {
    if (!open || bankAccountId) return;
    const pick = defaultDepositAccountId(bankAccounts, method);
    if (pick) setValue("bankAccountId", pick);
  }, [open, method, bankAccounts]); // eslint-disable-line react-hooks/exhaustive-deps

  const summary = summarise(received, lines ?? [], invoices);
  const totalDue = invoices.reduce((s, i) => s + i.due, 0);

  const onValid = (d: FormData) => {
    if (summary.problem) {
      toast.error("Payment not saved — the split needs fixing", { description: summary.problem });
      return;
    }
    if (summary.remaining > 0 && !d.excessToCredit) {
      toast.error("Payment not saved — money left over", {
        description: `${rupee(summary.remaining)} is not applied to any invoice. Apply it to an invoice, or tick “Keep as advance credit”.`,
      });
      return;
    }
    const reference = d.method === "cash" && !d.reference.trim() ? cashReference(d.receivedDate) : d.reference;
    record.mutate(
      {
        customerId: d.customerId,
        receivedOn: d.receivedDate,
        method: d.method as PaymentMethod,
        bankAccountId: d.bankAccountId || null,
        reference,
        received: d.received,
        allocations: toRpcAllocations(d.lines),
        excessToCredit: d.excessToCredit,
        notes: d.notes?.trim() || null,
      },
      {
        onSuccess: (r) => {
          if (r.idempotent_replay) {
            toast.warning("Already recorded — nothing new saved", {
              description: `Reference ${reference} is already on these invoices. Check Payments before entering it again.`,
            });
          } else {
            const paid = r.lines.filter((l) => l.invoice_paid).length;
            toast.success(`${rupee(r.received)} recorded across ${r.lines.length} invoice${r.lines.length === 1 ? "" : "s"}`, {
              description: [
                paid ? `${paid} invoice${paid === 1 ? "" : "s"} now paid in full.` : null,
                r.excess_credit > 0 ? `${rupee(r.excess_credit)} kept as advance credit.` : null,
              ].filter(Boolean).join(" ") || undefined,
            });
          }
          onOpenChange(false);
        },
        onError: (e) => toastError(e, {
          fallback: "Payment not saved — nothing was recorded on any invoice. Check the amounts and try again.",
        }),
      },
    );
  };

  const onInvalid = (formErrors: typeof errors) => {
    const first = (["customerId", "received", "receivedDate", "method", "reference"] as const).find((k) => formErrors[k]);
    const message = first ? String(formErrors[first]?.message ?? "Check this field") : "Check the invoice lines.";
    toast.error("Payment not saved — one field needs fixing", { description: message });
    if (first) document.getElementById(`mip_${first}`)?.focus();
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-2xl flex flex-col p-0">
        <SheetHeader className="px-5 pt-5">
          <SheetTitle>Record payment — multiple invoices</SheetTitle>
          <SheetDescription>
            One payment spread over {customerName ? <b>{customerName}</b> : "a customer"}&apos;s open invoices, oldest first.
            Each invoice keeps its own number; anything left over becomes advance credit.
          </SheetDescription>
        </SheetHeader>

        <form onSubmit={handleSubmit(onValid, onInvalid)} noValidate className="flex flex-col flex-1 min-h-0 min-w-0 w-full">
          <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-4">
            {!fixedCustomerId && (
              <FormField label="Customer" required htmlFor="mip_customerId">
                <CustomerCombobox
                  id="mip_customerId"
                  value={customerId}
                  onChange={(id) => setValue("customerId", id, { shouldValidate: true })}
                  placeholder="Choose the customer who paid"
                />
              </FormField>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <FormField label="Amount received (₹)" required htmlFor="mip_received">
                <Input id="mip_received" type="number" inputMode="numeric" min={1} step={1}
                       error={errors.received?.message} {...register("received")} />
              </FormField>
              <FormField label="Received on" required htmlFor="mip_receivedDate">
                <Input id="mip_receivedDate" type="date" error={errors.receivedDate?.message} {...register("receivedDate")} />
              </FormField>
              <FormField label="Payment method" required htmlFor="mip_method">
                <Select value={method} onValueChange={(v) => setValue("method", v, { shouldValidate: !!errors.reference })}>
                  <SelectTrigger id="mip_method"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {PAYMENT_METHODS.map((m) => <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </FormField>
              <FormField label="Received in" htmlFor="mip_bank">
                {receiveAccounts.length > 0 ? (
                  <Select value={bankAccountId || "none"} onValueChange={(v) => setValue("bankAccountId", v === "none" ? "" : v)}>
                    <SelectTrigger id="mip_bank"><SelectValue placeholder="Choose the account" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">Not sure yet</SelectItem>
                      {receiveAccounts.map((a) => <SelectItem key={a.id} value={a.id}>{depositAccountLabel(a)}</SelectItem>)}
                    </SelectContent>
                  </Select>
                ) : (
                  <p id="mip_bank" className="text-xs text-ink-3">
                    No bank account yet. <Link href="/accounting/banking" className="underline text-ink">Add one</Link> — the payment saves without it.
                  </p>
                )}
              </FormField>
              <FormField label={method === "cash" ? "Reference (optional for cash)" : "UTR / cheque no. / transaction ID"} required={method !== "cash"} htmlFor="mip_reference" className="sm:col-span-2">
                <Input id="mip_reference" placeholder="e.g. 402312345678" error={errors.reference?.message} {...register("reference")} />
              </FormField>
            </div>

            {/* ── Invoices ───────────────────────────────────────────── */}
            <section aria-labelledby="mip_invoices_h" className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 id="mip_invoices_h" className="text-sm font-semibold text-ink">
                  Open invoices{invoices.length ? ` · ${invoices.length} · ${rupee(totalDue)} due` : ""}
                </h3>
                <Button type="button" size="sm" variant="outline" icon="refresh" onClick={() => autoFill(received)}
                        disabled={!invoices.length}>
                  Auto-fill oldest first
                </Button>
              </div>

              {!customerId ? (
                <p className="text-xs text-ink-3">Choose the customer to see their open invoices.</p>
              ) : invoicesLoading ? (
                <p className="text-xs text-ink-3">Loading open invoices…</p>
              ) : invoicesError ? (
                <p role="alert" className="text-xs text-rose">
                  Could not load the invoices. Close this and open it again; if it keeps failing, record each invoice from its own page.
                </p>
              ) : invoices.length === 0 ? (
                <p className="text-xs text-ink-3">
                  No open invoices for this customer. To take an advance, record it from the quote; project invoices are paid from the project.
                </p>
              ) : (
                <ul className="divide-y divide-hairline rounded-lg border border-hairline">
                  {fields.map((f, idx) => {
                    const inv = invoices.find((i) => i.id === f.invoiceId);
                    if (!inv) return null;
                    const line = lines?.[idx] ?? f;
                    const over = summary.overDue.includes(inv.id);
                    const hint = lineTdsHint(inv, { amount: Number(line.amount) || 0, tds: Number(line.tds) || 0 });
                    const showTds = (Number(line.tds) || 0) > 0 || !!line.tdsSection;
                    return (
                      <li key={f.id} className="px-3 py-2.5 space-y-1.5">
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                          <div className="min-w-0 flex-1">
                            <Link href={invoiceHref(inv.id)} className="font-mono text-sm font-semibold text-ink underline-offset-2 hover:underline">
                              {inv.id}
                            </Link>
                            <div className="text-2xs text-ink-3">
                              {formatDate(inv.invoice_date)} · due <b className="text-ink">{rupee(inv.due)}</b>
                            </div>
                          </div>
                          <label className="flex items-center gap-1.5 text-xs text-ink-3" htmlFor={`mip_line_${idx}`}>
                            Apply ₹
                            <Input
                              id={`mip_line_${idx}`}
                              type="number" inputMode="numeric" min={0} step={1}
                              wrapperClassName="w-28"
                              aria-invalid={over || undefined}
                              error={over ? "More than due" : errors.lines?.[idx]?.amount?.message}
                              {...register(`lines.${idx}.amount`, { onChange: () => setManual(true) })}
                            />
                          </label>
                        </div>
                        {showTds ? (
                          <div className="flex flex-wrap items-center gap-2 text-xs text-ink-3">
                            <label htmlFor={`mip_tds_${idx}`} className="flex items-center gap-1.5">
                              TDS deducted ₹
                              <Input id={`mip_tds_${idx}`} type="number" inputMode="numeric" min={0} step={1} wrapperClassName="w-24"
                                     {...register(`lines.${idx}.tds`, { onChange: () => setManual(true) })} />
                            </label>
                            {line.tdsSection && <span>{line.tdsSection}{line.tdsRatePct != null ? ` @ ${line.tdsRatePct}%` : ""}</span>}
                            <Button type="button" size="sm" variant="ghost" onClick={() => {
                              setValue(`lines.${idx}.tds`, 0); setValue(`lines.${idx}.tdsSection`, undefined); setValue(`lines.${idx}.tdsRatePct`, undefined);
                            }}>Remove TDS</Button>
                          </div>
                        ) : hint ? (
                          <div role="status" className="rounded-md border border-amber/40 bg-amber-soft px-2.5 py-1.5 text-xs text-amber-ink flex flex-wrap items-center justify-between gap-2">
                            <span>{tdsShortfallLine(hint)}</span>
                            <Button type="button" size="sm" variant="outline" onClick={() => {
                              setManual(true);
                              setValue(`lines.${idx}.tds`, hint.tds);
                              setValue(`lines.${idx}.tdsSection`, hint.section);
                              setValue(`lines.${idx}.tdsRatePct`, hint.ratePct);
                            }}>Haan, TDS lagao</Button>
                          </div>
                        ) : (Number(line.amount) || 0) > 0 ? (
                          <Button type="button" size="sm" variant="ghost" className="!px-0 text-xs" onClick={() => setValue(`lines.${idx}.tdsSection`, "194J")}>
                            + Customer deducted TDS
                          </Button>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

            {/* ── What will happen ───────────────────────────────────── */}
            <div className="rounded-lg border border-hairline bg-paper-2 px-3 py-2.5 text-xs space-y-1">
              <div className="flex justify-between"><span className="text-ink-3">Received</span><b>{rupee(received)}</b></div>
              <div className="flex justify-between"><span className="text-ink-3">Applied to {summary.used.length} invoice{summary.used.length === 1 ? "" : "s"}</span><b>{rupee(summary.allocated)}</b></div>
              <div className="flex justify-between">
                <span className="text-ink-3">{summary.remaining >= 0 ? "Left over → advance credit" : "Applied more than received"}</span>
                <b className={summary.remaining < 0 ? "text-rose" : undefined}>{rupee(Math.abs(summary.remaining))}</b>
              </div>
              {summary.remaining > 0 && (
                <label className="flex items-center gap-2 pt-1 text-ink" htmlFor="mip_excess">
                  <Checkbox id="mip_excess" checked={watch("excessToCredit")} onCheckedChange={(v) => setValue("excessToCredit", v === true)} />
                  Keep {rupee(summary.remaining)} as the customer&apos;s advance credit
                </label>
              )}
              {summary.problem && received > 0 && (
                <p role="alert" className="text-rose pt-1 flex items-start gap-1.5">
                  <Icon name="alert" size={13} className="shrink-0 mt-0.5" />{summary.problem}
                </p>
              )}
            </div>

            <FormField label="Notes (optional)" htmlFor="mip_notes">
              <Input id="mip_notes" {...register("notes")} />
            </FormField>
          </div>

          <SheetFooter className="px-5 py-3 border-t border-hairline">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" variant="primary" icon="rupee" loading={record.isPending}>
              Record {received > 0 ? rupee(received) : "payment"}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}
