/**
 * R-2394 — Private Vault → Banking → one account: like the business Banking account page,
 * with the vault's own meanings. Opening balance + as-of date, statement import (same
 * readers as the company import), every line with the running balance, filters (unmatched /
 * matched / typed, in / out, month), search, a statement check like a BRS, and each
 * statement line matched in a side sheet (BankReconcileSheet).
 *
 * The balance is COMPUTED (personal_account_balances): opening + money in − money out, so an
 * EMI on Loans or an entry on Income & Expenses with this account moves it too. The account
 * is still an ASSET on the Banking list (a card stays under "Owed").
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { toast } from "sonner";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Money } from "@/components/ui/money";
import { EmptyState } from "@/components/shared/empty-state";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { VaultLoadError } from "@/components/features/vault/vault-load-error";
import { BankImportDialog } from "@/components/features/vault/bank-import-dialog";
import { BankReconcileSheet } from "@/components/features/vault/bank-reconcile-sheet";
import { usePersonalAccounts, useSavePersonalAccount } from "@/lib/queries/personal-vault";
import { useAccountTransactions, type AccountTx } from "@/lib/queries/personal-banking";
import {
  ALL_LINES,
  accountKindLabel,
  buildLedger,
  checkAgainstStatement,
  filterLedger,
  ledgerMonths,
  ledgerTotals,
  statementCheckText,
  type LedgerFilter,
} from "@/lib/vault/personal/bank-ledger";
import { rowLabel } from "@/lib/vault/personal/income-expense";
import { isLiabilityAccount, type AccountKind } from "@/lib/vault/personal/net-worth";
import { parseRupees } from "@/lib/vault/personal/parse-rupees";
import { istToday } from "@/lib/dates/ist";
import { formatDate, rupee } from "@/lib/utils";

const STATUS_LABEL = { unmatched: "Unmatched", matched: "Matched", entry: "Typed" } as const;

function monthLabel(m: string): string {
  const [y, mo] = m.split("-").map(Number);
  return new Date(Date.UTC(y, mo - 1, 1)).toLocaleDateString("en-IN", { month: "short", year: "numeric", timeZone: "UTC" });
}

export default function PersonalBankAccountPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;
  const accountsQ = usePersonalAccounts(true);
  const txQ = useAccountTransactions(id);
  const saveAccount = useSavePersonalAccount();

  const [filter, setFilter] = React.useState<LedgerFilter>(ALL_LINES);
  const [importOpen, setImportOpen] = React.useState(false);
  const [openingOpen, setOpeningOpen] = React.useState(false);
  const [openingForm, setOpeningForm] = React.useState({ amount: "", asOf: "" });
  const [openingError, setOpeningError] = React.useState<string | null>(null);
  const [sheetLine, setSheetLine] = React.useState<AccountTx | null>(null);

  const accounts = accountsQ.data ?? [];
  const account = accounts.find((a) => a.id === id) ?? null;

  const ledger = React.useMemo(
    () => (account ? buildLedger(account, txQ.data ?? []) : []),
    [account, txQ.data],
  );
  const totals = account ? ledgerTotals(account, ledger) : null;
  const check = checkAgainstStatement(ledger);
  const months = ledgerMonths(ledger);
  const shown = filterLedger(ledger, filter).slice().reverse(); // newest first
  const otherTails = accounts.filter((a) => a.id !== id && a.account_last4).map((a) => a.account_last4!) ;

  if (accountsQ.error || txQ.error) return <VaultLoadError error={accountsQ.error ?? txQ.error} />;
  if (accountsQ.isLoading) return <Skeleton className="h-64 w-full rounded-xl" />;
  if (!account) {
    return (
      <Card className="p-6">
        <EmptyState icon="wallet" title="Account not found" body="It may have been removed."
          action={<Button asChild><Link href="/vault/personal/banking">Back to Banking</Link></Button>} />
      </Card>
    );
  }

  const card = account.kind === "credit_card";
  const openOpening = () => {
    setOpeningForm({ amount: String(account.opening_balance ?? 0), asOf: account.opening_as_of ?? "" });
    setOpeningError(null);
    setOpeningOpen(true);
  };
  const saveOpening = async () => {
    const p = parseRupees(openingForm.amount);
    if (!p.ok) { setOpeningError("Type a whole amount in digits, like 125000 or 1,25,000. No minus sign."); return; }
    try {
      await saveAccount.mutateAsync({
        id: account.id, kind: account.kind, label: account.label,
        opening_balance: p.value, opening_as_of: openingForm.asOf || istToday(),
      });
      toast.success("Opening balance saved.");
      setOpeningOpen(false);
    } catch { /* the hook already showed why */ }
  };

  const unmatchedCount = totals?.unmatched ?? 0;

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <Link href="/vault/personal/banking" className="text-xs text-ink-3 hover:underline">← Banking</Link>
          <div className="flex items-center gap-2 flex-wrap mt-0.5">
            <h1 className="text-lg font-semibold text-ink">{account.label}</h1>
            <Badge kind="muted" size="sm">{accountKindLabel(account.kind)}</Badge>
            <Badge kind="muted" size="sm">{isLiabilityAccount(account.kind as AccountKind) ? "Owed" : "Asset"}</Badge>
          </div>
          <p className="text-xs text-ink-3">
            {account.institution || "—"}
            {account.account_last4 && <span className="font-mono"> ····{account.account_last4}</span>}
          </p>
        </div>
        <div className="flex gap-2 flex-shrink-0">
          <Button variant="outline" onClick={openOpening}>Opening balance</Button>
          <Button variant={unmatchedCount > 0 ? "outline" : "primary"} onClick={() => setImportOpen(true)}>
            <Icon name="upload" size={14} className="mr-1.5" />
            Import statement
          </Button>
          {unmatchedCount > 0 && (
            <Button variant="primary" onClick={() => setFilter({ ...ALL_LINES, status: "unmatched" })}>
              Match {unmatchedCount} line{unmatchedCount === 1 ? "" : "s"}
            </Button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Card className="p-4">
          <p className="text-2xs uppercase tracking-wide text-ink-3">{card ? "Owed now" : "Balance"}</p>
          <div className="mt-0.5" data-testid="vba-balance">
            <Money amount={account.balance} size="display" tone={card && account.balance > 0 ? "negative" : "default"} autoNegative={false} />
          </div>
        </Card>
        <Card className="p-4">
          <p className="text-2xs uppercase tracking-wide text-ink-3">Opening</p>
          <div className="mt-0.5"><Money amount={account.opening_balance} size="display" autoNegative={false} /></div>
          <p className="text-3xs text-ink-3 mt-0.5">{account.opening_as_of ? `as of ${formatDate(account.opening_as_of)}` : "date not set"}</p>
        </Card>
        <Card className="p-4">
          <p className="text-2xs uppercase tracking-wide text-ink-3">In / Out</p>
          <p className="mt-1 text-sm text-ink">
            <span className="text-emerald">+{rupee(totals?.moneyIn ?? 0)}</span>
            {" · "}
            <span>−{rupee(totals?.moneyOut ?? 0)}</span>
          </p>
        </Card>
        <Card className="p-4" data-testid="vba-check">
          <p className="text-2xs uppercase tracking-wide text-ink-3">Statement check</p>
          {check ? (
            <>
              <p className={`mt-1 text-sm font-medium ${check.matches ? "text-emerald" : "text-rose"}`}>
                {check.matches ? "Matches the statement" : `Difference ${rupee(Math.abs(check.difference))}`}
              </p>
              <p className="text-3xs text-ink-3 mt-0.5">
                Statement {rupee(check.statementBalance)} on {formatDate(check.statementDate)}
                {!check.matches && <> · here {rupee(check.appBalance)}</>}
              </p>
              {!check.matches && <p className="text-3xs text-ink-2 mt-0.5">{statementCheckText(check)}</p>}
            </>
          ) : (
            <p className="mt-1 text-sm text-ink-3">Import a statement to check.</p>
          )}
        </Card>
      </div>

      <Card className="p-0 overflow-hidden">
        <div className="px-4 py-2.5 border-b border-hairline bg-paper-2 flex flex-wrap items-center gap-2">
          <div className="flex gap-1" role="group" aria-label="Show">
            {(["all", "unmatched", "matched", "entry"] as const).map((s) => (
              <button key={s} type="button" aria-pressed={filter.status === s}
                onClick={() => setFilter((f) => ({ ...f, status: s }))}
                className={`rounded-full border px-2.5 py-0.5 text-xs focus-visible:outline focus-visible:outline-2 ${filter.status === s ? "border-ink bg-ink text-paper" : "border-hairline text-ink-2"}`}>
                {s === "all" ? "All" : STATUS_LABEL[s]}
              </button>
            ))}
          </div>
          <Select value={filter.direction} onValueChange={(v) => setFilter((f) => ({ ...f, direction: v as LedgerFilter["direction"] }))}>
            <SelectTrigger aria-label="Money in or out" className="h-8 w-[130px] text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">In and out</SelectItem>
              <SelectItem value="in">Money in</SelectItem>
              <SelectItem value="out">Money out</SelectItem>
            </SelectContent>
          </Select>
          <Select value={filter.month ?? "all"} onValueChange={(v) => setFilter((f) => ({ ...f, month: v === "all" ? null : v }))}>
            <SelectTrigger aria-label="Month" className="h-8 w-[130px] text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All months</SelectItem>
              {months.map((m) => <SelectItem key={m} value={m}>{monthLabel(m)}</SelectItem>)}
            </SelectContent>
          </Select>
          <Input aria-label="Search lines" placeholder="Search narration, amount…" value={filter.query}
            onChange={(e) => setFilter((f) => ({ ...f, query: e.target.value }))} className="h-8 w-[220px] text-xs ml-auto" />
        </div>

        {txQ.isLoading ? (
          <Skeleton className="h-40 w-full" />
        ) : ledger.length === 0 ? (
          <div className="p-6">
            <EmptyState icon="upload" title="No lines yet"
              body="Import your bank statement, or add entries on Income & Expenses / Loans with this account."
              action={<Button onClick={() => setImportOpen(true)}>Import statement</Button>} />
          </div>
        ) : (
          <table className="w-full text-sm table-fixed">
            <thead className="text-2xs uppercase tracking-wide text-ink-3 border-b border-hairline">
              <tr>
                <th className="text-left font-medium px-4 py-2 w-[96px]">Date</th>
                <th className="text-left font-medium px-2 py-2">Details</th>
                <th className="text-right font-medium px-2 py-2 w-[110px]">In</th>
                <th className="text-right font-medium px-2 py-2 w-[110px]">Out</th>
                <th className="text-right font-medium px-2 py-2 w-[120px]">{card ? "Owed" : "Balance"}</th>
                <th className="text-right font-medium px-4 py-2 w-[120px]"><span className="sr-only">Action</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-hairline">
              {shown.map((r) => (
                <tr key={r.tx.id} data-testid="vba-line">
                  <td className="px-4 py-2 text-ink-2 whitespace-nowrap">{formatDate(r.tx.occurred_on)}</td>
                  <td className="px-2 py-2 min-w-0">
                    <p className="text-ink truncate" title={r.tx.raw_description ?? r.tx.note ?? undefined}>
                      {r.tx.raw_description || r.tx.note || rowLabel(r.tx)}
                    </p>
                    <p className="text-3xs text-ink-3 truncate">
                      <Badge kind={r.status === "unmatched" ? "warning" : "muted"} size="sm">{STATUS_LABEL[r.status]}</Badge>
                      {" "}{r.tx.category === "Byana / held money" ? "Byana / held money" : rowLabel(r.tx)}
                      {r.tx.category && r.tx.kind === "expense" && <> · {r.tx.category}</>}
                      {r.tx.party && <> · {r.tx.party}</>}
                    </p>
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums text-emerald">{r.moneyIn ? rupee(r.moneyIn) : ""}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{r.moneyOut ? rupee(r.moneyOut) : ""}</td>
                  <td className="px-2 py-2 text-right tabular-nums text-ink-2">{rupee(r.running)}</td>
                  <td className="px-4 py-2 text-right">
                    {r.status === "unmatched" && <Button size="sm" variant="primary" onClick={() => setSheetLine(r.tx)}>Match</Button>}
                    {r.status === "matched" && <Button size="sm" variant="ghost" onClick={() => setSheetLine(r.tx)}>View</Button>}
                  </td>
                </tr>
              ))}
              {shown.length === 0 && (
                <tr><td colSpan={6} className="px-4 py-6 text-center text-ink-3">No lines match these filters.</td></tr>
              )}
            </tbody>
          </table>
        )}
      </Card>

      <BankImportDialog account={account} otherTails={otherTails} open={importOpen} onOpenChange={setImportOpen} />
      <BankReconcileSheet line={sheetLine} account={account} accounts={accounts} onOpenChange={(v) => { if (!v) setSheetLine(null); }} />

      <Dialog open={openingOpen} onOpenChange={setOpeningOpen}>
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>Opening balance</DialogTitle>
            <DialogDescription className="text-xs">
              {card ? "What you owed on the card on this day." : "The balance on this day — every line after it is added to it."}
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="vba-opening" className="block text-2xs uppercase tracking-wide text-ink-3 mb-1">{card ? "Owed (₹)" : "Amount (₹)"}</label>
              <Input id="vba-opening" value={openingForm.amount} inputMode="numeric"
                onChange={(e) => { setOpeningForm((f) => ({ ...f, amount: e.target.value })); setOpeningError(null); }}
                aria-invalid={!!openingError || undefined} aria-describedby={openingError ? "vba-opening-error" : undefined} />
              {openingError && <p id="vba-opening-error" role="alert" className="mt-1 text-xs text-rose">{openingError}</p>}
            </div>
            <div>
              <label htmlFor="vba-asof" className="block text-2xs uppercase tracking-wide text-ink-3 mb-1">As of</label>
              <Input id="vba-asof" type="date" value={openingForm.asOf} onChange={(e) => setOpeningForm((f) => ({ ...f, asOf: e.target.value }))} />
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-3">
            <Button variant="outline" onClick={() => setOpeningOpen(false)}>Cancel</Button>
            <Button variant="primary" onClick={saveOpening} loading={saveAccount.isPending}>Save</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
