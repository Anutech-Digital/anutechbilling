/**
 * Banking — bank accounts landing page.
 *
 * Lists every bank account the operator has connected. Each card shows
 * the account nickname, bank logo + IFSC, last-4 digits, current balance
 * (= opening_balance + sum of credit-debit across imported transactions),
 * and a row count + unmatched chip so the operator sees "12 imported · 4
 * unmatched" at a glance.
 *
 * Empty state walks them through the first add. Phase 2 will surface
 * "Import statement" right here for one-tap data refresh.
 */
"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import type { Route } from "next";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/shared/empty-state";
import { useBankAccounts, type BankAccountRow } from "@/lib/queries/bank";
import { rupee } from "@/lib/utils";
import { AddBankAccountForm } from "@/components/features/banking/add-bank-account-form";
import { DeleteBankAccountDialog } from "@/components/features/banking/delete-bank-account-dialog";
import { TransferDialog } from "@/components/features/banking/transfer-dialog";

export default function BankingPage() {
  const router = useRouter();
  const { data: accounts, isLoading } = useBankAccounts();
  const [addOpen, setAddOpen] = React.useState(false);
  const [editAccount, setEditAccount] = React.useState<BankAccountRow | null>(null);
  const [deleteAccount, setDeleteAccount] = React.useState<BankAccountRow | null>(null);
  const [transferOpen, setTransferOpen] = React.useState(false);

  // "Total balance" = cash/bank ASSETS only. A credit card is a liability, so
  // its (negative) balance is excluded here and surfaced separately as "owed" —
  // otherwise a big card bill would silently shrink the headline cash figure.
  const totalBalance = (accounts ?? [])
    .filter((a) => a.account_type !== "credit_card")
    .reduce((sum, a) => sum + (a.current_balance ?? a.opening_balance), 0);
  const cardOwed = (accounts ?? [])
    .filter((a) => a.account_type === "credit_card")
    .reduce((sum, a) => sum + Math.max(0, -(a.current_balance ?? a.opening_balance)), 0);

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1800px] mx-auto">
      {/* Header */}
      <div className="flex items-end justify-between gap-3 flex-wrap mb-6">
        <div>
          <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Accounting</p>
          <h1 className="font-serif text-3xl md:text-4xl leading-tight">Banking</h1>
          <p className="text-sm text-ink-3 mt-1">
            Connect your bank accounts, import statements, and reconcile against
            customer payments + vendor expenses.
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          {(accounts?.length ?? 0) >= 2 && (
            <Button icon="refresh" onClick={() => setTransferOpen(true)}>
              Move money / withdraw
            </Button>
          )}
          <Button variant="primary" icon="plus" onClick={() => setAddOpen(true)}>
            Add account
          </Button>
        </div>
      </div>

      {/* Summary strip */}
      {!isLoading && accounts && accounts.length > 0 && (
        <Card className="mb-6">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div>
              <p className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold">Total balance</p>
              <p className="font-serif text-2xl text-ink mt-1">{rupee(totalBalance, { compact: true })}</p>
              <p className="text-[11px] text-ink-3 mt-0.5">
                {cardOwed > 0 ? <>Cash &amp; bank · <span className="text-rose">{rupee(cardOwed, { compact: true })} cards ka owe / udhari</span></> : "Across all accounts"}
              </p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold">Accounts</p>
              <p className="font-serif text-2xl text-ink mt-1">{accounts.length}</p>
              <p className="text-[11px] text-ink-3 mt-0.5">Active</p>
            </div>
            <div className="md:col-span-2">
              <p className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold mb-2">Tips</p>
              <ul className="text-xs text-ink-2 space-y-1 list-disc list-inside">
                <li>Statement upload: Download last 30 days from your bank, upload CSV.</li>
                <li>Each credit gets auto-suggested matches against your payments.</li>
              </ul>
            </div>
          </div>
        </Card>
      )}

      {/* Account grid OR empty state */}
      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1, 2, 3].map((i) => <Skeleton key={i} className="h-40 rounded-lg" />)}
        </div>
      ) : !accounts || accounts.length === 0 ? (
        <Card>
          <EmptyState
            icon="rupee"
            title="No bank accounts connected yet."
            body="Add your first bank account — HDFC, ICICI, SBI, Axis, or any Indian bank. Once added, upload a statement CSV and we'll match each transaction against your customer payments + vendor expenses."
            action={
              <Button variant="primary" icon="plus" onClick={() => setAddOpen(true)}>
                Add bank account
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {accounts.map((acc) => (
            <BankAccountCard
              key={acc.id}
              account={acc}
              onOpen={() => router.push(`/accounting/banking/${acc.id}` as Route)}
              onEdit={() => setEditAccount(acc)}
              onDelete={() => setDeleteAccount(acc)}
            />
          ))}
        </div>
      )}

      {/* Add + Edit share one form (edit passes the account). */}
      <AddBankAccountForm open={addOpen} onOpenChange={setAddOpen} />
      <AddBankAccountForm
        open={editAccount !== null}
        onOpenChange={(o) => { if (!o) setEditAccount(null); }}
        account={editAccount}
      />
      <DeleteBankAccountDialog
        open={deleteAccount !== null}
        onOpenChange={(o) => { if (!o) setDeleteAccount(null); }}
        account={deleteAccount}
      />
      <TransferDialog open={transferOpen} onOpenChange={setTransferOpen} accounts={accounts ?? []} />
    </div>
  );
}

// ============================================================
// Account card
// ============================================================
function BankAccountCard({
  account, onOpen, onEdit, onDelete,
}: {
  account: BankAccountRow;
  onOpen: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const balance = account.current_balance ?? account.opening_balance;
  const isPositive = balance >= 0;
  // A credit card is a liability: its balance is ≤ 0 while money is owed. Show
  // that as "owed" (the magnitude), not a negative number.
  const isCard = account.account_type === "credit_card";
  return (
    <div className="relative rounded-lg border border-hairline bg-paper hover:border-hairline-strong hover:shadow-md transition-all">
      {/* Actions menu — absolutely positioned so it doesn't nest in the open button */}
      <div className="absolute top-3 right-3 z-10">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Account actions"
              className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-3 transition-colors hover:bg-paper-2 hover:text-ink data-[state=open]:bg-paper-2 data-[state=open]:text-ink"
            >
              <Icon name="more_h" size={20} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[11rem]">
            <DropdownMenuItem className="gap-2.5 py-2 cursor-pointer" onClick={onOpen}>
              <Icon name="arrow_right" size={16} /> View transactions
            </DropdownMenuItem>
            <DropdownMenuItem className="gap-2.5 py-2 cursor-pointer" onClick={onEdit}>
              <Icon name="edit" size={16} /> Edit account
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem destructive className="gap-2.5 py-2 cursor-pointer" onClick={onDelete}>
              <Icon name="trash" size={16} /> Delete account
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <button type="button" onClick={onOpen} className="text-left w-full p-5">
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="min-w-0">
            <p className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold">
              {account.bank_name}
            </p>
            <h3 className="font-semibold text-ink truncate mt-0.5">{account.name}</h3>
            {account.account_type === "cash" ? (
              <p className="text-xs text-ink-3 mt-0.5">Cash in hand</p>
            ) : isCard ? (
              <p className="text-xs text-ink-3 mt-0.5">Company credit card · owe / udhari</p>
            ) : (
              <p className="text-xs text-ink-3 font-mono mt-0.5">
                {[account.account_number_last4 && `••• ${account.account_number_last4}`, account.ifsc]
                  .filter(Boolean).join(" · ") || "No account number"}
              </p>
            )}
          </div>
          {/* leave room for the menu button */}
          <Badge kind={account.account_type === "cash" ? "success" : isCard ? "danger" : "muted"} size="sm" className="mr-9">
            {account.account_type === "current" ? "Current" :
             account.account_type === "savings" ? "Savings" :
             account.account_type === "overdraft" ? "OD" :
             account.account_type === "fixed_deposit" ? "FD" :
             account.account_type === "cash" ? "Cash" :
             isCard ? "Card" : account.account_type}
          </Badge>
        </div>

        <div className="border-t border-hairline pt-3">
          <p className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold">
            {isCard ? "Owe / Udhari" : "Balance"}
          </p>
          {isCard ? (
            <>
              <p className={`font-serif text-2xl mt-1 ${balance < 0 ? "text-rose" : "text-emerald"}`}>
                {rupee(Math.abs(balance))}
              </p>
              <p className="text-[10px] text-ink-3 mt-0.5">
                {balance < 0 ? "card par owe / udhari" : balance > 0 ? "extra jama (credit)" : "koi owe / udhari nahi"}
              </p>
            </>
          ) : (
            <p className={`font-serif text-2xl mt-1 ${isPositive ? "text-ink" : "text-rose"}`}>
              {rupee(balance)}
            </p>
          )}
          {/* Data-integrity guard: cash-in-hand can never be negative in reality. */}
          {account.account_type === "cash" && balance < 0 && (
            <div className="mt-2 flex items-start gap-1.5 rounded-md bg-rose/10 px-2 py-1.5 text-[11px] text-rose">
              <Icon name="alert" size={12} className="mt-0.5 shrink-0" />
              <span>Cash can&apos;t be negative — you likely missed a cash deposit/top-up. Add it via <b>Move money</b>, or reconcile the missing entry.</span>
            </div>
          )}
          <p className="text-[11px] text-ink-3 mt-1 inline-flex items-center gap-1">
            <Icon name="arrow_right" size={11} /> View transactions
          </p>
        </div>
      </button>
    </div>
  );
}
