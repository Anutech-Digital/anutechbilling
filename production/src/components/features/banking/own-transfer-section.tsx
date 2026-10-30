/**
 * R-2095 (30 Oct 2026, September reconcile): an FD sweep-in / sweep-out was "Own transfer → mark
 * reconciled" only, so the FD account never moved. Now the line is posted against the OTHER account
 * (any of the company's accounts — a fixed deposit can be added right here): that account's own
 * statement line is matched when it has one, else the opposite line is added there.
 */
"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { rupee } from "@/lib/utils";
import { useBankAccounts, useCreateBankAccount, type BankTransactionRow } from "@/lib/queries/bank";
import { useReconcileAsTransfer } from "@/lib/queries/bank-other-income";

type AccountLite = { id: string; name: string; bank_name?: string | null; account_type?: string | null; is_active?: boolean | null };

/** The accounts this line can move money to / from: active, not this one; fixed deposits first. */
export function transferAccountOptions(accounts: readonly AccountLite[], thisAccountId: string): AccountLite[] {
  return accounts
    .filter((a) => a.id !== thisAccountId && a.is_active !== false)
    .sort((a, b) => Number(b.account_type === "fixed_deposit") - Number(a.account_type === "fixed_deposit") || a.name.localeCompare(b.name));
}

export function transferAccountLabel(a: AccountLite): string {
  return `${a.name}${a.account_type === "fixed_deposit" ? " · Fixed deposit" : a.bank_name ? ` · ${a.bank_name}` : ""}`;
}

export function OwnTransferSection({ transaction, onDone }: { transaction: BankTransactionRow; onDone: () => void }) {
  const accountsQ = useBankAccounts();
  const createAccount = useCreateBankAccount();
  const post = useReconcileAsTransfer();
  const options = transferAccountOptions((accountsQ.data ?? []) as AccountLite[], transaction.bank_account_id);
  const [pick, setPick] = React.useState("");
  const [adding, setAdding] = React.useState(false);
  const [fdName, setFdName] = React.useState("");
  const [fdBank, setFdBank] = React.useState("");
  React.useEffect(() => { setPick(""); setAdding(false); }, [transaction.id]);

  const isIn = (transaction.credit ?? 0) > 0;
  const amount = isIn ? transaction.credit : transaction.debit;

  async function addFd() {
    try {
      const acc = await createAccount.mutateAsync({
        name: fdName.trim(), bank_name: fdBank.trim(), account_type: "fixed_deposit",
        opening_balance: 0, opening_balance_date: transaction.txn_date,
      } as never);
      setPick((acc as { id: string }).id);
      setAdding(false);
    } catch { /* the hook toasts */ }
  }

  async function submit() {
    if (!pick) return;
    try {
      await post.mutateAsync({ transactionId: transaction.id, otherAccountId: pick });
      onDone();
    } catch { /* the hook toasts */ }
  }

  return (
    <section aria-label="Transfer with another account" className="rounded-md border border-indigo/40 bg-indigo-soft/20 p-3 space-y-2">
      <p className="text-xs font-semibold text-ink-2">{isIn ? "Came in from which account?" : "Went to which account?"}</p>
      <p className="text-xs text-ink-3 leading-relaxed">
        An FD sweep-in or sweep-out is money between your own accounts. Pick the other account so its balance moves too —
        its own statement line is matched if it has one.
      </p>
      {!adding ? (
        <div className="flex flex-wrap items-center gap-2">
          <select value={pick} onChange={(e) => (e.target.value === "__new" ? setAdding(true) : setPick(e.target.value))}
            aria-label="Other account"
            className="min-w-0 flex-1 rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-indigo/40">
            <option value="" disabled>Pick the other account…</option>
            {options.map((a) => <option key={a.id} value={a.id}>{transferAccountLabel(a)}</option>)}
            <option value="__new">＋ New fixed deposit account</option>
          </select>
          <Button size="sm" variant="primary" icon="check" onClick={submit} disabled={!pick || post.isPending} loading={post.isPending}>
            Post {rupee(amount)} as transfer
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <Input value={fdName} onChange={(e) => setFdName(e.target.value)} placeholder="FD name (e.g. HDFC FD 1)" aria-label="Fixed deposit name" />
          <Input value={fdBank} onChange={(e) => setFdBank(e.target.value)} placeholder="Bank (e.g. HDFC)" aria-label="Fixed deposit bank" />
          <div className="flex gap-2">
            <Button size="sm" variant="primary" onClick={addFd} disabled={!fdName.trim() || !fdBank.trim() || createAccount.isPending} loading={createAccount.isPending}>
              Add FD
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>Cancel</Button>
          </div>
        </div>
      )}
    </section>
  );
}
