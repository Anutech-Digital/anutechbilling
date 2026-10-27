/**
 * AddBankAccountForm — drawer to add a new bank account.
 *
 * Captures: nickname, bank name (with Indian bank shortlist), last 4 digits
 * of account number, IFSC (validated), account type, opening balance + date.
 *
 * Why last-4 only: storing full account numbers is a PCI/security liability
 * we don't want. Last 4 is enough to disambiguate visually + matches what
 * banks show on statements.
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
import { FormField } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { useCreateBankAccount, useUpdateBankAccount, type BankAccountRow } from "@/lib/queries/bank";
import { istToday } from "@/lib/dates/ist";

// Indian IFSC: 4 letters (bank) + 0 + 6 letters/digits (branch). The rule and its message
// live in lib/banking/bank-details (R-1905) — one message everywhere.
import { ifscProblem } from "@/lib/banking/bank-details";

const COMMON_INDIAN_BANKS = [
  "HDFC Bank",
  "ICICI Bank",
  "State Bank of India",
  "Axis Bank",
  "Kotak Mahindra Bank",
  "Yes Bank",
  "IndusInd Bank",
  "IDFC FIRST Bank",
  "Punjab National Bank",
  "Bank of Baroda",
  "Canara Bank",
  "Union Bank of India",
  "Federal Bank",
  "RBL Bank",
  "Other",
];

const schema = z.object({
  name:                 z.string().min(2, "Nickname required").max(60),
  bank_name:            z.string().optional(),
  account_number_last4: z.string().optional(),
  ifsc:                 z.string().optional(),
  account_type:         z.enum(["current", "savings", "overdraft", "fixed_deposit", "cash", "other", "credit_card"]),
  opening_balance:      z.coerce.number().int(),
  opening_balance_date: z.string().min(1, "Date required"),
  notes:                z.string().optional(),
}).superRefine((val, ctx) => {
  // Bank identifiers are required for real bank accounts, but not for a
  // cash account (no IFSC) or a credit card (no IFSC — it's a card, not a
  // bank account).
  if (val.account_type !== "cash" && val.account_type !== "credit_card") {
    if (!val.bank_name || val.bank_name.length < 2)
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["bank_name"], message: "Bank required" });
    if (!/^\d{4}$/.test(val.account_number_last4 ?? ""))
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["account_number_last4"], message: "Last 4 digits only" });
    const ifscBad = (val.ifsc ?? "").trim() ? ifscProblem(val.ifsc ?? "") : "Add the IFSC, e.g. HDFC0001234";
    if (ifscBad)
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["ifsc"], message: ifscBad });
  }
});

type FormData = z.infer<typeof schema>;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** When provided, the form edits this account instead of creating a new one. */
  account?: BankAccountRow | null;
}

type OpenDropdown = "bank" | "type" | null;

export function AddBankAccountForm({ open, onOpenChange, account }: Props) {
  /* R-1692: Escape while the Bank / Account type dropdown is open closes the dropdown only.
     react-select and react-dialog bring different copies of Radix's dismissable layer, so
     neither knows the other is on top — one Escape closed both, and the dropdown then left
     `pointer-events: none` on <body>: nothing could be clicked and "Add account" would not
     open again until a reload. The drawer sees the Escape first (and the same event stops the
     dropdown's own handler), so it closes the open dropdown itself and stays open; the next
     Escape closes the drawer. */
  const [dropdown, setDropdown] = React.useState<OpenDropdown>(null);
  const onSheetEscape = (e: KeyboardEvent) => {
    if (dropdown === null) return;
    e.preventDefault();
    setDropdown(null);
  };
  React.useEffect(() => { if (!open) setDropdown(null); }, [open]);
  const create = useCreateBankAccount();
  const update = useUpdateBankAccount();
  const isEdit = Boolean(account);
  const {
    register,
    handleSubmit,
    reset,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: {
      account_type:         "current",
      opening_balance:      0,
      opening_balance_date: istToday(),
    },
  });

  const [bankName, setBankName] = React.useState("");
  const [accountType, setAccountType] = React.useState<FormData["account_type"]>("current");

  // Prefill on open (edit → from the account; add → blank defaults).
  React.useEffect(() => {
    if (!open) return;
    if (account) {
      reset({
        name:                 account.name,
        bank_name:            account.bank_name,
        account_number_last4: account.account_number_last4 ?? "",
        ifsc:                 account.ifsc ?? "",
        account_type:         account.account_type,
        // Card balances are stored negative (owed); show them as a positive "owed".
        opening_balance:      account.account_type === "credit_card" ? -account.opening_balance : account.opening_balance,
        opening_balance_date: account.opening_balance_date,
        notes:                account.notes ?? "",
      });
      setBankName(account.bank_name);
      setAccountType(account.account_type);
    } else {
      reset({
        account_type:         "current",
        opening_balance:      0,
        opening_balance_date: istToday(),
      });
      setBankName("");
      setAccountType("current");
    }
  }, [open, account, reset]);

  React.useEffect(() => { setValue("bank_name", bankName); }, [bankName, setValue]);
  React.useEffect(() => { setValue("account_type", accountType); }, [accountType, setValue]);

  const isCash = accountType === "cash";
  const isCard = accountType === "credit_card";

  const onSubmit = async (data: FormData) => {
    const payload = {
      name:                 data.name.trim(),
      // Neither a cash account nor a credit card has a bank IFSC / account number.
      bank_name:            isCash ? "Cash in hand" : isCard ? "Credit Card" : (data.bank_name ?? ""),
      account_number_last4: (isCash || isCard) ? null : (data.account_number_last4 ?? null),
      ifsc:                 (isCash || isCard) ? null : (data.ifsc ?? null),
      account_type:         data.account_type,
      // A credit card is a liability: the operator enters what they OWE (a
      // positive number); we store it as a NEGATIVE balance so the running
      // balance (opening + Σ(credit−debit)) reads as "amount owed" everywhere.
      opening_balance:      isCard ? -Math.abs(data.opening_balance) : data.opening_balance,
      opening_balance_date: data.opening_balance_date,
      notes:                data.notes?.trim() || null,
    };
    try {
      if (account) {
        await update.mutateAsync({ id: account.id, patch: payload });
      } else {
        await create.mutateAsync(payload);
      }
      onOpenChange(false);
    } catch {
      /* error toast handled in hook */
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-[480px] md:max-w-[520px] p-0 flex flex-col overflow-x-hidden"
        onEscapeKeyDown={onSheetEscape}
      >
        <SheetHeader>
          <SheetTitle>{isEdit ? "Edit account" : "Add bank account"}</SheetTitle>
          <SheetDescription>
            {isEdit
              ? "Update the account details. Fixing the opening balance corrects the running balance shown everywhere."
              : "Set up a new bank account to import statements + reconcile transactions."}
          </SheetDescription>
        </SheetHeader>

        <form
          onSubmit={handleSubmit(onSubmit)}
          className="flex flex-col flex-1 min-h-0 min-w-0 w-full"
        >
          <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-4">
            <FormField label="Nickname" required htmlFor="name">
              <Input
                id="name"
                autoFocus
                placeholder="HDFC Current — Mumbai"
                error={errors.name?.message}
                {...register("name")}
              />
              <p className="text-xs text-ink-3 mt-1">
                Short name to identify this account in dropdowns. E.g. &ldquo;HDFC Main&rdquo; or &ldquo;ICICI Operations&rdquo;.
              </p>
            </FormField>

            {!isCash && !isCard && (
              <>
                <FormField label="Bank" required htmlFor="bank_name">
                  <Select value={bankName} onValueChange={setBankName}
                    open={dropdown === "bank"} onOpenChange={(o) => setDropdown(o ? "bank" : null)}>
                    <SelectTrigger id="bank_name" error={!!errors.bank_name}>
                      <SelectValue placeholder="Select your bank" />
                    </SelectTrigger>
                    <SelectContent>
                      {COMMON_INDIAN_BANKS.map((b) => (
                        <SelectItem key={b} value={b}>{b}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <input type="hidden" {...register("bank_name")} value={bankName} />
                  {errors.bank_name?.message && (
                    <p className="mt-1 text-xs text-rose">{errors.bank_name.message}</p>
                  )}
                </FormField>

                <div className="grid grid-cols-2 gap-3">
                  <FormField label="Last 4 digits" required htmlFor="account_number_last4">
                    <Input
                      id="account_number_last4"
                      inputMode="numeric"
                      maxLength={4}
                      placeholder="1234"
                      className="font-mono"
                      error={errors.account_number_last4?.message}
                      {...register("account_number_last4")}
                    />
                    <p className="text-xs text-ink-3 mt-1">
                      Last 4 only — full number not stored
                    </p>
                  </FormField>
                  <FormField label="IFSC" required htmlFor="ifsc">
                    <Input
                      id="ifsc"
                      placeholder="HDFC0001234"
                      className="font-mono uppercase"
                      maxLength={11}
                      error={errors.ifsc?.message}
                      {...register("ifsc")}
                    />
                  </FormField>
                </div>
              </>
            )}

            {isCash && (
              <div className="rounded-md bg-amber-soft/50 border border-amber/30 px-3 py-2 text-xs text-amber-ink leading-relaxed">
                <b>Petty cash / cash in hand.</b> No bank or IFSC needed. Move money in
                with &ldquo;Withdraw to petty cash&rdquo; from a bank account, and cash
                expenses (Expenses → paid by Cash) reduce this balance.
              </div>
            )}

            {isCard && (
              <div className="rounded-md bg-indigo-soft/50 border border-indigo/30 px-3 py-2 text-xs text-indigo-ink leading-relaxed">
                <b>Company credit card.</b> This is a <b>liability</b> — money you have to pay back.
                Add card spends as transactions on this card and categorise them as expenses;
                when you pay the card bill, use <b>Transfer</b> (bank → this card) —
                do not record the bill again as a new expense, or the spend is counted twice.
              </div>
            )}

            <FormField label="Account type" htmlFor="account_type">
              <Select value={accountType} onValueChange={(v) => setAccountType(v as FormData["account_type"])}
                open={dropdown === "type"} onOpenChange={(o) => setDropdown(o ? "type" : null)}>
                <SelectTrigger id="account_type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="current">Current</SelectItem>
                  <SelectItem value="savings">Savings</SelectItem>
                  <SelectItem value="overdraft">Overdraft (OD/CC)</SelectItem>
                  <SelectItem value="credit_card">Credit Card</SelectItem>
                  <SelectItem value="fixed_deposit">Fixed Deposit</SelectItem>
                  <SelectItem value="cash">Cash / Petty cash</SelectItem>
                  <SelectItem value="other">Other</SelectItem>
                </SelectContent>
              </Select>
              <input type="hidden" {...register("account_type")} value={accountType} />
            </FormField>

            <div className="grid grid-cols-2 gap-3">
              <FormField label={isCard ? "Outstanding on the card (₹)" : "Opening balance (₹)"} htmlFor="opening_balance">
                <Input
                  id="opening_balance"
                  type="text"
                  inputMode="numeric"
                  prefix="₹"
                  placeholder="0"
                  error={errors.opening_balance?.message}
                  {...register("opening_balance")}
                />
              </FormField>
              <FormField label="As of date" required htmlFor="opening_balance_date">
                <Input
                  id="opening_balance_date"
                  type="date"
                  max={istToday()}
                  error={errors.opening_balance_date?.message}
                  {...register("opening_balance_date")}
                />
              </FormField>
            </div>
            <p className="text-xs text-ink-3 -mt-2 leading-relaxed">
              {isCard
                ? "Enter the amount outstanding on this card as of the date above (a positive number). New card spends add to it; paying the bill reduces it."
                : "Opening balance = money in this account on the “as of” date, BEFORE any transaction you import. Set it to the closing balance on your bank statement just before your first imported line — the running balance builds on top of it."}
            </p>

            <FormField label="Notes" htmlFor="notes">
              <textarea
                id="notes"
                rows={2}
                placeholder="Internal note (optional) — e.g. main operational account, branch contact, …"
                className="w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink placeholder:text-ink-4 focus:outline-none focus:ring-2 focus:ring-amber resize-y"
                {...register("notes")}
              />
            </FormField>

            <div className="rounded-md bg-paper-2/40 border border-hairline px-3 py-2 text-xs text-ink-3 leading-relaxed">
              <b className="text-ink-2">Security:</b> ResellerOS stores only the
              IFSC and last 4 digits of your account number — never the full
              account number or any credentials. Your live bank balance is
              calculated from the opening balance + the transactions you
              import here.
            </div>
          </div>

          <SheetFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              loading={isSubmitting || create.isPending || update.isPending}
            >
              {isEdit ? "Save changes" : "Add account"}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}
