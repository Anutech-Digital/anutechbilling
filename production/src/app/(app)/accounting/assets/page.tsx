/**
 * Assets & EMIs — things bought on EMI / a loan (laptop, car, server, phone…).
 *
 * R-1864: "Bought on EMI / loan" records the asset (register, depreciation), the loan and its
 * reducing-balance schedule in one step (components/features/accounting/emi-loan-dialogs.tsx).
 * Each EMI is reconciled from the bank statement (Banking → Reconcile → EMI / loan repayment,
 * or Auto-reconcile) or paid here; principal reduces the loan, interest goes to the P&L.
 * Purchases recorded before R-1864 (no schedule) keep Pay EMI + history below.
 */
"use client";

import * as React from "react";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { LoadError } from "@/components/shared/load-error";
import { FAB } from "@/components/ui/fab";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { rupee, formatDate } from "@/lib/utils";
import { useBankAccounts } from "@/lib/queries/bank";
import { FixedAssetRegister } from "@/components/features/accounting/fixed-asset-register";
import {
  useEmiPurchases, useRecordEmiPayment, useEmiPayments,
  EMI_CATEGORY_LABEL, type EmiPurchase,
} from "@/lib/queries/emi";
import { istToday } from "@/lib/dates/ist";
import { EmiPurchaseDialog, EmiScheduleDialog } from "@/components/features/accounting/emi-loan-dialogs";

function todayISO(): string {
  return istToday();
}
const selectCls = "w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-amber";

export default function AssetsPage() {
  const q = useEmiPurchases();
  const [addOpen, setAddOpen] = React.useState(false);
  const [payFor, setPayFor] = React.useState<EmiPurchase | null>(null);
  const [historyFor, setHistoryFor] = React.useState<EmiPurchase | null>(null);
  const [scheduleFor, setScheduleFor] = React.useState<string | null>(null);
  /* A loan with a schedule (R-1864) opens it; an older purchase keeps Pay EMI + history. */
  const openPay = (p: EmiPurchase) => (p.first_emi_on ? setScheduleFor(p.id) : setPayFor(p));
  const openHistory = (p: EmiPurchase) => (p.first_emi_on ? setScheduleFor(p.id) : setHistoryFor(p));
  const scheduled = scheduleFor ? (q.data ?? []).find((r) => r.id === scheduleFor) : undefined;

  const rows = q.data ?? [];
  const assetValue   = rows.reduce((s, r) => s + r.total_cost, 0);
  const outstanding  = rows.reduce((s, r) => s + r.outstanding, 0);
  const activeCount  = rows.filter((r) => r.status === "active").length;

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1800px] mx-auto">
      <div className="flex items-end justify-between gap-3 flex-wrap mb-6">
        <div>
          <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Accounting</p>
          <h1 className="font-serif text-3xl md:text-4xl tracking-tight">Assets &amp; EMIs</h1>
          <p className="text-sm text-ink-3 mt-1">
            Bought on EMI or a loan — record it once. Each EMI in the bank statement is split into principal (reduces the loan) and interest (P&amp;L); the asset is depreciated in the register.
          </p>
        </div>
        <Button variant="primary" icon="plus" className="hidden md:inline-flex" onClick={() => setAddOpen(true)}>
          Bought on EMI / loan
        </Button>
      </div>

      {/* A failed load must not print ₹0 tiles (S32). */}
      {!q.isError && (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 md:gap-4 mb-6">
          <KPI label="Asset value" value={rupee(assetValue)} />
          <KPI label="EMI outstanding" value={rupee(outstanding)} tone="amber" />
          <KPI label="Active" value={String(activeCount)} />
        </div>
      )}

      {q.isLoading ? (
        <div className="space-y-3">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-16 w-full" />)}</div>
      ) : q.isError ? (
        <LoadError what="Financed purchases" onRetry={() => q.refetch()} />
      ) : rows.length === 0 ? (
        <Card className="py-2">
          <EmptyState
            icon="cart"
            title="No financed purchases yet"
            body="Bought a laptop, vehicle or equipment on EMI or a loan? Record it here — the asset, the loan and the EMI schedule in one step."
            action={<Button variant="primary" icon="plus" onClick={() => setAddOpen(true)}>Bought on EMI / loan</Button>}
          />
        </Card>
      ) : (
        <>
          <Card className="hidden md:block overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-paper-2/50 text-3xs uppercase tracking-wider text-ink-3 font-semibold">
                <tr>
                  <th className="text-left  px-4 py-3">Item</th>
                  <th className="text-left  px-4 py-3">Bought</th>
                  <th className="text-right px-4 py-3">Cost</th>
                  <th className="text-right px-4 py-3">Outstanding loan</th>
                  <th className="text-center px-4 py-3">EMIs</th>
                  <th className="text-left  px-4 py-3">Status</th>
                  <th className="text-right px-4 py-3">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline">
                {rows.map((p) => (
                  <tr key={p.id} className="hover:bg-paper-2/40">
                    <td className="px-4 py-3 font-medium text-ink">
                      <div className="flex items-center gap-2">
                        {p.name}
                        <Badge kind="muted">{EMI_CATEGORY_LABEL[p.category]}</Badge>
                      </div>
                      {p.lender && <div className="text-xs text-ink-3 font-normal">{p.lender}</div>}
                    </td>
                    <td className="px-4 py-3 text-ink-2">{formatDate(p.purchased_on)}</td>
                    <td className="px-4 py-3 text-right font-mono text-ink-2">{rupee(p.total_cost)}</td>
                    <td className="px-4 py-3 text-right font-mono font-semibold text-ink">{rupee(p.outstanding)}</td>
                    <td className="px-4 py-3 text-center text-ink-2 tabular-nums">{p.emisPaid}{p.emi_count ? ` / ${p.emi_count}` : ""}</td>
                    <td className="px-4 py-3">
                      <Badge kind={p.status === "closed" ? "success" : "warning"} dot>{p.status === "closed" ? "Cleared" : "Active"}</Badge>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-0.5">
                        {p.status === "active" && p.outstanding > 0 && (
                          <Button variant="ghost" size="sm" onClick={() => openPay(p)}>{p.first_emi_on ? "Schedule" : "Pay EMI"}</Button>
                        )}
                        <button type="button" title="EMI history" onClick={() => openHistory(p)} className="rounded p-1.5 text-ink-3 hover:bg-paper-2 hover:text-ink">
                          <Icon name="clock" size={15} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          <ul className="md:hidden space-y-2.5">
            {rows.map((p) => (
              <li key={p.id}>
                <Card className="p-4">
                  <div className="flex items-start justify-between gap-2 mb-1">
                    <div className="font-medium text-ink leading-tight">
                      {p.name} <span className="text-xs font-normal text-ink-3">· {EMI_CATEGORY_LABEL[p.category]}</span>
                    </div>
                    <div className="font-serif text-xl text-ink leading-none">{rupee(p.outstanding)}</div>
                  </div>
                  <div className="text-xs text-ink-3 mb-2">
                    {formatDate(p.purchased_on)} · {rupee(p.total_cost)} cost · {p.emisPaid}{p.emi_count ? `/${p.emi_count}` : ""} EMIs paid
                  </div>
                  <div className="flex items-center justify-between">
                    <Badge kind={p.status === "closed" ? "success" : "warning"} dot>{p.status === "closed" ? "Cleared" : "Active"}</Badge>
                    <div className="flex items-center gap-0.5">
                      {p.status === "active" && p.outstanding > 0 && (
                        <Button variant="ghost" size="sm" onClick={() => openPay(p)}>{p.first_emi_on ? "Schedule" : "Pay EMI"}</Button>
                      )}
                      <button type="button" aria-label="EMI history" onClick={() => openHistory(p)} className="rounded p-1.5 text-ink-3 hover:bg-paper-2 hover:text-ink">
                        <Icon name="clock" size={15} />
                      </button>
                    </div>
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        </>
      )}

      <FixedAssetRegister />

      <FAB icon="plus" label="EMI / loan" onClick={() => setAddOpen(true)} ariaLabel="Bought on EMI / loan" />
      {addOpen && <EmiPurchaseDialog onClose={() => setAddOpen(false)} />}
      {scheduled && <EmiScheduleDialog purchase={scheduled} onClose={() => setScheduleFor(null)} />}
      {payFor && <PayEmiDialog purchase={payFor} onClose={() => setPayFor(null)} />}
      {historyFor && <EmiHistoryDialog purchase={historyFor} onClose={() => setHistoryFor(null)} />}
    </div>
  );
}

function KPI({ label, value, tone }: { label: string; value: string; tone?: "amber" }) {
  return (
    <Card className="p-3 md:p-4">
      <div className="text-3xs uppercase tracking-wider text-ink-3 font-semibold mb-1">{label}</div>
      <div className={`font-serif text-xl md:text-2xl leading-tight ${tone === "amber" ? "text-amber" : "text-ink"}`}>{value}</div>
    </Card>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return <div className="flex items-center justify-between text-ink-2"><span>{label}</span><span className="font-mono">{value}</span></div>;
}

function PayEmiDialog({ purchase, onClose }: { purchase: EmiPurchase; onClose: () => void }) {
  const accountsQ = useBankAccounts();
  const pay       = useRecordEmiPayment();
  const accounts  = (accountsQ.data ?? []).filter((a) => a.is_active);

  const [amount, setAmount]   = React.useState(String(purchase.emi_amount || ""));
  const [interest, setInterest] = React.useState("0");
  const [date, setDate]       = React.useState(todayISO());
  const [accountId, setAccountId] = React.useState("");
  React.useEffect(() => { if (!accountId && accounts.length > 0) setAccountId(accounts[0].id); }, [accounts, accountId]);

  const amt  = Math.max(0, Math.round(Number(amount) || 0));
  const intr = Math.max(0, Math.round(Number(interest) || 0));
  const principal = amt - intr;
  const tooMuchInt = intr > amt;
  const tooMuchPrin = principal > purchase.outstanding;
  const valid = amt > 0 && !tooMuchInt && !tooMuchPrin && Boolean(accountId);

  async function submit() {
    if (!valid) return;
    await pay.mutateAsync({ purchaseId: purchase.id, amount: amt, interest: intr, paidOn: date, bankAccountId: accountId });
    onClose();
  }

  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="md:!max-w-md">
        <DialogHeader>
          <DialogTitle>Pay EMI — {purchase.name}</DialogTitle>
          <DialogDescription>Outstanding loan: <b className="text-ink">{rupee(purchase.outstanding)}</b>.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <label htmlFor="assets-emi-amount-2" className="block text-xs font-medium text-ink-2 mb-1">EMI amount (₹)</label>
            <Input id="assets-emi-amount-2" type="number" min={1} value={amount} onChange={(e) => setAmount(e.target.value)} />
          </div>
          <div>
            <label htmlFor="assets-of-which-interest-optional" className="block text-xs font-medium text-ink-2 mb-1">Of which interest (₹, optional)</label>
            <Input id="assets-of-which-interest-optional" type="number" min={0} value={interest} onChange={(e) => setInterest(e.target.value)} />
            {tooMuchInt && <p className="mt-1 text-xs text-rose">Interest can&apos;t exceed the EMI.</p>}
            {!tooMuchInt && tooMuchPrin && <p className="mt-1 text-xs text-rose">Principal ({rupee(principal)}) exceeds outstanding {rupee(purchase.outstanding)}.</p>}
          </div>
          <div>
            <label htmlFor="assets-paid-from" className="block text-xs font-medium text-ink-2 mb-1">Paid from</label>
            <select id="assets-paid-from" value={accountId} onChange={(e) => setAccountId(e.target.value)} className={selectCls}>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="assets-date" className="block text-xs font-medium text-ink-2 mb-1">Date</label>
            <Input id="assets-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div className="rounded-md bg-paper-2/50 p-3 text-sm space-y-1">
            <Row label="Principal (reduces loan)" value={rupee(Math.max(0, principal))} />
            {intr > 0 && <Row label="Interest (expense)" value={rupee(intr)} />}
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={pay.isPending}>Cancel</Button>
          <Button variant="primary" loading={pay.isPending} disabled={!valid} onClick={submit}>Pay {amt > 0 ? rupee(amt) : ""}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EmiHistoryDialog({ purchase, onClose }: { purchase: EmiPurchase; onClose: () => void }) {
  const histQ     = useEmiPayments(purchase.id);
  const accountsQ = useBankAccounts();
  const acctName  = new Map((accountsQ.data ?? []).map((a) => [a.id, a.name]));
  const rows      = histQ.data ?? [];

  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="md:!max-w-md">
        <DialogHeader>
          <DialogTitle>EMIs — {purchase.name}</DialogTitle>
          <DialogDescription>
            {rupee(purchase.total_cost)} cost · {rupee(purchase.down_payment)} down · {rupee(purchase.principalPaid)} principal paid · {rupee(purchase.outstanding)} outstanding
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[55vh] space-y-2 overflow-y-auto pr-1">
          {histQ.isLoading ? (
            <p className="text-xs text-ink-3">Loading…</p>
          ) : rows.length === 0 ? (
            <div className="rounded-md border border-dashed border-hairline p-6 text-center text-xs text-ink-3">No EMIs paid yet.</div>
          ) : (
            rows.map((h) => (
              <div key={h.id} className="flex items-start justify-between gap-3 rounded-md border border-hairline px-3 py-2">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-ink">{rupee(h.amount)}</div>
                  <div className="text-xs text-ink-3">
                    {formatDate(h.paid_on)}
                    {h.bank_account_id ? ` · ${acctName.get(h.bank_account_id) ?? "account"}` : ""}
                    {" · "}{rupee(h.principal_part)} principal{h.interest_part > 0 ? ` + ${rupee(h.interest_part)} interest` : ""}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
        <DialogFooter>
          <Button variant="primary" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
