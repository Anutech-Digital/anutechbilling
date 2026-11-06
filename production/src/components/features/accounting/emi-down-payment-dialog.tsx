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
 *
 * R-2523: "Split across sources" — the down payment from SEVERAL places (Thar Roxx: three HDFC
 * statement lines ₹21,000 + ₹87,394 + ₹19,700 and ₹71,906 from Petty Cash). Each part is a
 * statement line (used whole, reconciled to it), an account line the app makes (bank / FD /
 * Petty Cash, with amount and date) or the owner's capital; they must add up. One server step
 * (set_emi_down_payment_parts). A split down payment is changed only here.
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
  useEmiDownPayment, useChangeEmiDownPaymentSource, useDownPaymentLineCandidates, useSetEmiDownPaymentParts,
  type EmiPurchase, type EmiDownPart, type EmiDownPartInput,
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
  if (src.kind === "split") return `Split — ${src.parts.length} parts`;
  return "Not recorded";
}

/* ── R-2523: the down payment from SEVERAL sources ─────────────────────────────────────────── */

/** One row of the split editor. source: "" | "line:<id>" (a statement line, used whole) |
 *  "acc:<id>" (a bank / FD / Petty Cash line the app makes) | OWNER. */
export type SplitRow = { key: string; source: string; amount: string; date: string; partner: string };

/** The current parts as editor rows (or one empty row for the whole amount). Pure — tested. */
export function rowsFromParts(parts: readonly EmiDownPart[], total: number, purchasedOn: string): SplitRow[] {
  if (parts.length === 0) return [{ key: "r0", source: "", amount: String(total), date: purchasedOn, partner: "" }];
  return parts.map((p, i) => p.kind === "owner"
    ? { key: `r${i}`, source: OWNER, amount: String(p.amount), date: p.date, partner: p.partner ?? "" }
    : p.imported
    ? { key: `r${i}`, source: `line:${p.lineId}`, amount: String(p.amount), date: p.date, partner: "" }
    : { key: `r${i}`, source: `acc:${p.accountId}`, amount: String(p.amount), date: p.date, partner: "" });
}

/** Rows → what set_emi_down_payment_parts takes, plus the sum and the first problem. Pure — tested. */
export function splitPlan(rows: readonly SplitRow[], total: number, lineAmount: (id: string) => number | undefined, needsPartner: boolean) {
  let sum = 0;
  let problem: string | null = null;
  const parts: EmiDownPartInput[] = [];
  rows.forEach((r, i) => {
    const n = i + 1;
    if (r.source.startsWith("line:")) {
      const id = r.source.slice(5);
      sum += lineAmount(id) ?? 0;
      parts.push({ bank_txn_id: id });
      return;
    }
    const amount = /^\d+$/.test(r.amount.trim()) ? Number(r.amount.trim()) : NaN;
    if (Number.isFinite(amount)) sum += amount;
    if (!problem && !r.source) problem = `Part ${n}: pick where it was paid from`;
    else if (!problem && !(amount > 0)) problem = `Part ${n}: enter the amount in whole rupees`;
    else if (!problem && !r.date) problem = `Part ${n}: enter the date`;
    else if (!problem && r.source === OWNER && needsPartner && !r.partner.trim()) problem = `Part ${n}: pick the partner who paid it`;
    if (r.source === OWNER) parts.push({ paid_by_owner: true, amount, date: r.date, partner: r.partner.trim() || null });
    else if (r.source.startsWith("acc:")) parts.push({ account_id: r.source.slice(4), amount, date: r.date });
  });
  const left = total - sum;
  if (!problem && left !== 0) problem = left > 0 ? `${rupee(left)} of the down payment is not in a part yet` : `The parts are ${rupee(-left)} more than the down payment`;
  return { parts, sum, left, problem };
}

function SplitEditor({ purchase, total, parts, onClose }: {
  purchase: EmiPurchase; total: number; parts: readonly EmiDownPart[]; onClose: () => void;
}) {
  const accountsQ = useBankAccounts();
  const profileQ = useComplianceProfile();
  const words = ownerEquityWords(profileQ.data?.businessType ?? null);
  const linesQ = useDownPaymentLineCandidates(purchase.purchased_on);
  const save = useSetEmiDownPaymentParts();
  const [rows, setRows] = React.useState<SplitRow[]>(() => rowsFromParts(parts, total, purchase.purchased_on));
  const nextKey = React.useRef(rows.length);

  const accounts = accountsQ.data ?? [];
  const accName = (id: string) => accounts.find((a) => a.id === id)?.name ?? "Account";
  /* Statement lines: the ones already in this down payment + unmatched money-out lines near the purchase. */
  const lines = React.useMemo(() => {
    const own = parts.filter((p): p is Extract<EmiDownPart, { kind: "account" }> => p.kind === "account" && p.imported)
      .map((p) => ({ id: p.lineId, account_name: accName(p.accountId), txn_date: p.date, description: null as string | null, debit: p.amount }));
    const seen = new Set(own.map((l) => l.id));
    return [...own, ...(linesQ.data ?? []).filter((l) => !seen.has(l.id))];
  // eslint-disable-next-line react-hooks/exhaustive-deps -- accName reads accounts, listed
  }, [parts, linesQ.data, accounts]);
  const lineAmount = (id: string) => lines.find((l) => l.id === id)?.debit;
  const plan = splitPlan(rows, total, lineAmount, words.needsPartner);
  const used = new Set(rows.map((r) => r.source).filter((v) => v.startsWith("line:") || v === OWNER));

  const update = (key: string, patch: Partial<SplitRow>) =>
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const addRow = () => {
    const key = `r${nextKey.current++}`;
    setRows((rs) => [...rs, { key, source: "", amount: plan.left > 0 ? String(plan.left) : "", date: purchase.purchased_on, partner: "" }]);
  };

  async function submit() {
    if (plan.problem) return;
    await save.mutateAsync({ purchaseId: purchase.id, parts: plan.parts });
    onClose();
  }

  return (
    <>
      <div className="space-y-2" data-testid="down-split">
        {rows.map((r, i) => {
          const isLine = r.source.startsWith("line:");
          const open = downPaymentAccounts(accounts, r.date || purchase.purchased_on);
          return (
            <div key={r.key} className="rounded-md border border-hairline p-2 space-y-1.5">
              <div className="flex items-center gap-2">
                <select aria-label={`Part ${i + 1} paid from`} value={r.source} className={selectCls}
                  onChange={(e) => {
                    const v = e.target.value;
                    const amt = v.startsWith("line:") ? lineAmount(v.slice(5)) : undefined;
                    update(r.key, { source: v, ...(amt != null ? { amount: String(amt) } : {}) });
                  }}>
                  <option value="">Pick where it was paid from</option>
                  {lines.length > 0 && (
                    <optgroup label="Bank statement line (used whole)">
                      {lines.map((l) => (
                        <option key={l.id} value={`line:${l.id}`} disabled={used.has(`line:${l.id}`) && r.source !== `line:${l.id}`}>
                          {formatDate(l.txn_date)} · {l.account_name} · {rupee(l.debit)}{l.description ? ` · ${l.description.slice(0, 40)}` : ""}
                        </option>
                      ))}
                    </optgroup>
                  )}
                  <optgroup label="Recorded by hand">
                    {open.map(({ account, open: ok, note }) => (
                      <option key={account.id} value={`acc:${account.id}`} disabled={!ok}>
                        {account.name}{account.account_type === "cash" ? " (cash)" : ""}{note ? ` — ${note}` : ""}
                      </option>
                    ))}
                    {words.allowed && (
                      <option value={OWNER} disabled={used.has(OWNER) && r.source !== OWNER}>Paid by {words.person} ({words.capital.toLowerCase()})</option>
                    )}
                  </optgroup>
                </select>
                {rows.length > 1 && (
                  <Button size="sm" variant="ghost" icon="trash" aria-label={`Remove part ${i + 1}`}
                    onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))} />
                )}
              </div>
              {!isLine && (
                <div className="flex flex-wrap gap-2">
                  <label className="flex-1 min-w-[8rem]">
                    <span className={labelCls}>Amount (₹)</span>
                    <Input aria-label={`Part ${i + 1} amount`} inputMode="numeric" value={r.amount} onChange={(e) => update(r.key, { amount: e.target.value })} />
                  </label>
                  <label className="flex-1 min-w-[8rem]">
                    <span className={labelCls}>Paid on</span>
                    <Input aria-label={`Part ${i + 1} date`} type="date" value={r.date} onChange={(e) => update(r.key, { date: e.target.value })} />
                  </label>
                  {r.source === OWNER && words.needsPartner && (
                    <label className="flex-1 min-w-[8rem]">
                      <span className={labelCls}>Which {words.person}</span>
                      <Input aria-label={`Part ${i + 1} ${words.person}`} value={r.partner} onChange={(e) => update(r.key, { partner: e.target.value })} />
                    </label>
                  )}
                </div>
              )}
            </div>
          );
        })}
        <div className="flex items-center justify-between gap-2">
          <Button size="sm" variant="ghost" icon="plus" onClick={addRow} disabled={rows.length >= 12}>Add a part</Button>
          <p className={`text-sm tabular-nums ${plan.left === 0 ? "text-ink-2" : "text-amber-ink"}`} data-testid="down-split-total">
            {rupee(plan.sum)} of {rupee(total)}{plan.left === 0 ? " ✓" : plan.left > 0 ? ` — ${rupee(plan.left)} left` : ` — ${rupee(-plan.left)} too much`}
          </p>
        </div>
        <p className="text-xs text-ink-3">
          A statement line counts once and is reconciled to this down payment. Cash, an account with no statement yet, or the owner&apos;s money get a line made by the app — you can match it to the bank later from Banking.
        </p>
        {plan.problem && plan.left === 0 && <p className="text-xs text-amber-ink">{plan.problem}</p>}
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose} disabled={save.isPending}>Cancel</Button>
        <Button variant="primary" loading={save.isPending} disabled={Boolean(plan.problem)} onClick={submit}>
          Save {rows.length} part{rows.length === 1 ? "" : "s"}
        </Button>
      </DialogFooter>
    </>
  );
}

/** Change where the down payment of one asset was paid from — one source, or split across several (R-2523). */
export function EmiDownPaymentDialog({ purchase, onClose }: { purchase: EmiPurchase; onClose: () => void }) {
  const srcQ = useEmiDownPayment(purchase);
  const accountsQ = useBankAccounts();
  const profileQ = useComplianceProfile();
  const words = ownerEquityWords(profileQ.data?.businessType ?? null);
  const change = useChangeEmiDownPaymentSource();
  const [value, setValue] = React.useState("");
  const [partner, setPartner] = React.useState("");
  const [splitMode, setSplitMode] = React.useState(false);

  const src = srcQ.data;
  const total = (purchase.down_payment ?? 0) + (purchase.processing_fee ?? 0) + (purchase.processing_fee_gst ?? 0);
  const amount = src && src.kind !== "none" ? src.amount : total;
  const date = src && src.kind !== "none" ? src.date : purchase.purchased_on;
  const isSplit = src?.kind === "split";
  const imported = src?.kind === "account" && src.imported;
  const exclude = src?.kind === "account" ? src.accountId : src?.kind === "owner" ? OWNER : null;
  const byOwner = value === OWNER;
  const showSplit = splitMode || isSplit;

  const problem = !value ? "Pick where the down payment was paid from"
    : byOwner && words.needsPartner && !partner.trim() ? `Pick the ${words.person} who paid it`
    : null;

  async function submit() {
    if (problem || imported) return;
    await change.mutateAsync({ purchaseId: purchase.id, accountId: byOwner ? null : value, paidByOwner: byOwner, partner: byOwner ? partner.trim() || null : null });
    onClose();
  }

  const accounts = accountsQ.data ?? [];
  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className={showSplit ? "md:!max-w-2xl" : "md:!max-w-md"}>
        <DialogHeader>
          <DialogTitle>Down payment — {purchase.name}</DialogTitle>
          <DialogDescription>
            {isSplit || showSplit
              ? <>{rupee(total)} in total. Paid from several places? Add each part — they must add up to {rupee(total)}. The asset cost and the loan stay the same.</>
              : <>{rupee(amount)} paid on {formatDate(date)}. Changing where it came from moves only this money — the asset cost and the loan stay the same.</>}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="rounded-md bg-paper-2/50 px-3 py-2 text-sm">
            <span className="text-ink-3">Paid from now: </span>
            <b className="text-ink" data-testid="down-now">{srcQ.isLoading ? "Loading…" : srcQ.isError ? "Could not load — close and open again" : currentText(src, accounts)}</b>
            {isSplit && src?.kind === "split" && (
              <ul className="mt-1 space-y-0.5 text-xs text-ink-2" data-testid="down-parts">
                {src.parts.map((p, i) => (
                  <li key={i} className="flex justify-between gap-3">
                    <span>{p.kind === "owner" ? `Paid by owner${p.partner ? ` — ${p.partner}` : ""}` : `${accounts.find((a) => a.id === p.accountId)?.name ?? "An account"}${p.imported ? " · bank statement" : " · recorded by hand"}`} · {formatDate(p.date)}</span>
                    <span className="font-mono tabular-nums">{rupee(p.amount)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {showSplit ? null : imported ? (
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
              {src && (
                <button type="button" className="text-xs text-indigo-ink font-medium underline hover:no-underline" onClick={() => setSplitMode(true)}>
                  Paid from several places (bank lines, cash, owner)? Split across sources →
                </button>
              )}
            </>
          )}
        </div>
        {showSplit && src ? (
          <SplitEditor purchase={purchase} total={total} parts={src.parts ?? []} onClose={onClose} />
        ) : (
          <DialogFooter>
            <Button variant="ghost" onClick={onClose} disabled={change.isPending}>Cancel</Button>
            {!imported && !showSplit && (
              <Button variant="primary" loading={change.isPending} disabled={Boolean(problem) || srcQ.isLoading} onClick={submit}>
                Save paid from
              </Button>
            )}
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
