/**
 * R-2395 — where an asset's down payment was paid from: a bank / FD account, Petty Cash, or
 * "Paid by owner" (capital introduced — no bank line). The same picker is used when the asset is
 * set up (EmiPurchaseDialog) and when it is changed later (EmiDownPaymentDialog, from Schedule),
 * so both ask the same thing the same way (UI rule 6). It starts EMPTY: the owner must pick —
 * a silent default put the Thar Roxx down payment on an FD that did not exist yet (3 Nov).
 *
 * The server (change_emi_down_payment_source) does the move in one step: removes the app-made
 * line (or the owner-capital row) and books the new source; asset cost and loan never change.
 * It refuses an account opened after the payment date, a locked month and a reconciled line.
 */
"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { rupee, formatDate } from "@/lib/utils";
import { useBankAccounts, type BankAccountRow } from "@/lib/queries/bank";
import { useComplianceProfile } from "@/lib/compliance/profile";
import { ownerEquityWords } from "@/lib/accounting/owner-equity";
import {
  useEmiDownPayment, useChangeEmiDownPaymentSource, type EmiPurchase,
} from "@/lib/queries/emi";

/** The picker's value: "" = not picked yet, OWNER = paid by owner, else an account id. */
export const OWNER = "__owner__";

const selectCls = "w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-amber";
const labelCls = "block text-xs font-medium text-ink-2 mb-1";

/** Accounts a down payment can come from (no credit card), and whether each was open on `date`. */
export function downPaymentAccounts(accounts: readonly BankAccountRow[], date: string | null) {
  return accounts
    .filter((a) => a.is_active && a.account_type !== "credit_card")
    .map((a) => {
      const opened = a.opening_balance_date ?? null;
      const tooEarly = Boolean(date && opened && date < opened);
      const closed = Boolean(date && a.closed_on && date > a.closed_on);
      return { account: a, open: !tooEarly && !closed, note: tooEarly ? `opened ${formatDate(opened!)}` : closed ? `closed ${formatDate(a.closed_on!)}` : null };
    });
}

/** The "Paid from" picker. `exclude` hides the current source (changing it to itself is pointless). */
export function DownPaymentSourceSelect({ id, value, onChange, date, exclude }: {
  id: string; value: string; onChange: (v: string) => void; date: string | null; exclude?: string | null;
}) {
  const q = useBankAccounts();
  const profileQ = useComplianceProfile();
  const words = ownerEquityWords(profileQ.data?.businessType ?? null);
  const list = downPaymentAccounts(q.data ?? [], date).filter((x) => x.account.id !== exclude);
  return (
    <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className={selectCls}>
      <option value="">Pick where it was paid from</option>
      {list.map(({ account, open, note }) => (
        <option key={account.id} value={account.id} disabled={!open}>
          {account.name}{account.account_type === "cash" ? " (cash)" : ""}{note ? ` — ${note}` : ""}
        </option>
      ))}
      {words.allowed && exclude !== OWNER && <option value={OWNER}>Paid by {words.person} ({words.capital.toLowerCase()})</option>}
    </select>
  );
}

/** Words for where it sits now. */
function currentText(src: ReturnType<typeof useEmiDownPayment>["data"], accounts: readonly BankAccountRow[]): string {
  if (!src) return "…";
  if (src.kind === "owner") return `Paid by owner (capital introduced)${src.partner ? ` — ${src.partner}` : ""}`;
  if (src.kind === "account") return accounts.find((a) => a.id === src.accountId)?.name ?? "An account";
  return "Not recorded";
}

/** Change where the down payment of one asset was paid from. */
export function EmiDownPaymentDialog({ purchase, onClose }: { purchase: EmiPurchase; onClose: () => void }) {
  const srcQ = useEmiDownPayment(purchase);
  const accountsQ = useBankAccounts();
  const profileQ = useComplianceProfile();
  const words = ownerEquityWords(profileQ.data?.businessType ?? null);
  const change = useChangeEmiDownPaymentSource();
  const [value, setValue] = React.useState("");
  const [partner, setPartner] = React.useState("");

  const src = srcQ.data;
  const amount = src && src.kind !== "none" ? src.amount
    : (purchase.down_payment ?? 0) + (purchase.processing_fee ?? 0) + (purchase.processing_fee_gst ?? 0);
  const date = src && src.kind !== "none" ? src.date : purchase.purchased_on;
  const imported = src?.kind === "account" && src.imported;
  const exclude = src?.kind === "account" ? src.accountId : src?.kind === "owner" ? OWNER : null;
  const byOwner = value === OWNER;

  const problem = !value ? "Pick where the down payment was paid from"
    : byOwner && words.needsPartner && !partner.trim() ? `Pick the ${words.person} who paid it`
    : null;

  async function submit() {
    if (problem || imported) return;
    await change.mutateAsync({ purchaseId: purchase.id, accountId: byOwner ? null : value, paidByOwner: byOwner, partner: byOwner ? partner.trim() || null : null });
    onClose();
  }

  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="md:!max-w-md">
        <DialogHeader>
          <DialogTitle>Down payment — {purchase.name}</DialogTitle>
          <DialogDescription>
            {rupee(amount)} paid on {formatDate(date)}. Changing where it came from moves only this money — the asset cost and the loan stay the same.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="rounded-md bg-paper-2/50 px-3 py-2 text-sm">
            <span className="text-ink-3">Paid from now: </span>
            <b className="text-ink" data-testid="down-now">{srcQ.isLoading ? "Loading…" : srcQ.isError ? "Could not load — close and open again" : currentText(src, accountsQ.data ?? [])}</b>
          </div>
          {imported ? (
            <p className="text-sm text-ink-2">
              This down payment is reconciled to a line in the bank statement, so the bank shows where it left from.
              If that is wrong, un-reconcile the line in Banking first, then change it here.
            </p>
          ) : (
            <>
              <div>
                <label htmlFor="emi-down-change" className={labelCls}>Paid from</label>
                <DownPaymentSourceSelect id="emi-down-change" value={value} onChange={setValue} date={date} exclude={exclude} />
                <p className="mt-1 text-xs text-ink-3">An account opened after {formatDate(date)} cannot have paid it.</p>
              </div>
              {byOwner && words.needsPartner && (
                <div>
                  <label htmlFor="emi-down-partner" className={labelCls}>Which {words.person}</label>
                  <Input id="emi-down-partner" value={partner} onChange={(e) => setPartner(e.target.value)} placeholder={`Name as in the ${words.person}s register`} />
                </div>
              )}
              {byOwner && (
                <p className="text-xs text-ink-3">
                  The {words.person}&apos;s capital goes up by {rupee(amount)} (money put into the business) — it is not income and no bank line is made.
                </p>
              )}
            </>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={change.isPending}>Cancel</Button>
          {!imported && (
            <Button variant="primary" loading={change.isPending} disabled={Boolean(problem) || srcQ.isLoading} onClick={submit}>
              Save paid from
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
