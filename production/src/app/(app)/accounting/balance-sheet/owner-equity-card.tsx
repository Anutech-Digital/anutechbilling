/**
 * R-1839 — owner drawings & capital on the Balance Sheet (where equity lives).
 *
 *   • RecordOwnerEquityDialog — record money the owner (or a partner) took out / put in: date,
 *     amount, from which bank account or Petty Cash, partner, note. The RPC adds the matching
 *     bank / cash line, so the account balance moves in the same step.
 *   • OwnerEquityCard — the register: by month with the FY total, by partner for a firm, every
 *     entry (remove), CSV for the CA. A Pvt Ltd company sees "Paid to a director" choices
 *     instead (salary, loan to director — s.185 caution, reimbursement, dividend).
 */
"use client";

import * as React from "react";
import Link from "next/link";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { LoadErrorInline } from "@/components/shared/load-error";
import { useConfirm } from "@/components/providers/confirm-provider";
import { rupee, formatDate } from "@/lib/utils";
import { downloadCSV } from "@/lib/csv";
import { istToday } from "@/lib/dates/ist";
import { fyOf } from "@/lib/accounting/ledger";
import { useBankAccounts, type BankAccountRow } from "@/lib/queries/bank";
import { depositAccounts } from "@/lib/payments/deposit-accounts";
import {
  DIRECTOR_CHOICES, drawingsRegister, drawingsRegisterCsv,
  type OwnerEquityKind, type OwnerEquityMovement, type OwnerEquityWords,
} from "@/lib/accounting/owner-equity";
import { useRecordOwnerEquity, useDeleteOwnerEquity } from "@/lib/queries/owner-equity";
import { BusinessTypePrompt } from "@/components/features/compliance/business-type-prompt";
import { PartnerPicker } from "@/components/features/partners/partner-picker";
import { activePartners, movementPartner, type FirmPartner } from "@/lib/accounting/partners";
import { parseWholeRupees } from "./format";

export interface RecordInit { kind: OwnerEquityKind; amount?: number }

const monthLabel = (ym: string) => {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-IN", { month: "short", year: "numeric", timeZone: "UTC" });
};
const fyText = (y: number) => `FY ${y}-${String((y + 1) % 100).padStart(2, "0")}`;
const accountText = (a: Pick<BankAccountRow, "name" | "account_type"> | undefined) =>
  a ? `${a.name}${a.account_type === "cash" ? " (cash)" : ""}` : "Account removed";

// ── Record dialog ──────────────────────────────────────────────────────────────────────────

export function RecordOwnerEquityDialog({ init, words, partners, onClose }: {
  init: RecordInit | null; words: OwnerEquityWords; partners: FirmPartner[]; onClose: () => void;
}) {
  const { data: accounts } = useBankAccounts();
  const record = useRecordOwnerEquity();
  const usable = React.useMemo(() => depositAccounts(accounts) as BankAccountRow[], [accounts]);
  const [kind, setKind] = React.useState<OwnerEquityKind>("drawings");
  const [date, setDate] = React.useState(istToday());
  const [amount, setAmount] = React.useState("");
  const [accountId, setAccountId] = React.useState("");
  const [partner, setPartner] = React.useState("");
  const [note, setNote] = React.useState("");
  const [err, setErr] = React.useState<string | null>(null);
  const today = istToday();

  React.useEffect(() => {
    if (!init) return;
    setKind(init.kind);
    setDate(istToday());
    setAmount(init.amount ? String(init.amount) : "");
    /* One bank account → that one; otherwise nothing picked (a wrong account is worse than none). */
    const banks = usable.filter((a) => a.account_type !== "cash");
    setAccountId(banks.length === 1 && usable.length === 1 ? banks[0].id : "");
    /* One partner in the firm today → that one; otherwise nothing picked. */
    const current = activePartners(partners, istToday());
    setPartner(current.length === 1 ? current[0].name : "");
    setNote("");
    setErr(null);
  }, [init, usable, partners]);

  const account = usable.find((a) => a.id === accountId);
  const isCash = account?.account_type === "cash";
  const amt = parseWholeRupees(amount);
  const cashShort = kind === "drawings" && isCash && typeof amt === "number" && account?.current_balance != null && amt > account.current_balance;

  async function submit() {
    if (amt === "bad" || amt === null || amt <= 0) { setErr("Enter the amount in whole rupees, e.g. 25000."); return; }
    if (!date || date > today) { setErr("Pick the date the money moved (not a future date)."); return; }
    if (!accountId) { setErr(kind === "drawings" ? "Pick the account the money was taken from." : "Pick the account the money went into."); return; }
    if (words.needsPartner && !partner.trim()) { setErr(`Pick the ${words.person} — each ${words.person} has their own capital account.`); return; }
    setErr(null);
    try {
      await record.mutateAsync({ kind, date, amount: amt, accountId, partner: partner.trim() || null, note: note.trim() || null });
      onClose();
    } catch { /* the hook shows the error */ }
  }

  return (
    <Dialog open={init !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="md:!max-w-md">
        <DialogHeader>
          <DialogTitle>{kind === "drawings" ? `Record ${words.drawings.toLowerCase()}` : `Record ${words.capital.toLowerCase()}`}</DialogTitle>
          <DialogDescription>
            {kind === "drawings"
              ? `Money the ${words.person} took out of the business for personal use (cash, a transfer to a personal account, or a personal bill paid from the business). It lowers the ${words.person}'s capital — it is not an expense and never reaches the P&L.`
              : `Money the ${words.person} put into the business. It adds to the ${words.person}'s capital — it is not income.`}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-1.5" role="group" aria-label="Money out or money in">
            {(["drawings", "capital_introduced"] as const).map((k) => (
              <button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(k)}
                className={`rounded-md border px-2 py-2 text-sm font-medium ${kind === k ? "border-indigo bg-indigo/10 text-indigo" : "border-hairline text-ink-2"}`}>
                {k === "drawings" ? `${words.drawings} (out)` : `${words.capital} (in)`}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <FormField label="Date" required htmlFor="oe-date">
              <Input id="oe-date" type="date" value={date} max={today} onChange={(e) => setDate(e.target.value)} />
            </FormField>
            <FormField label="Amount (₹)" required htmlFor="oe-amount">
              <Input id="oe-amount" inputMode="numeric" placeholder="e.g. 25000" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </FormField>
          </div>

          <FormField label={kind === "drawings" ? "Taken from" : "Put into"} required htmlFor="oe-account">
            <select id="oe-account" value={accountId} onChange={(e) => setAccountId(e.target.value)}
              className="w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-indigo/40">
              <option value="" disabled>Pick a bank account or Petty Cash…</option>
              {usable.map((a) => (
                <option key={a.id} value={a.id}>
                  {accountText(a)}{a.current_balance != null ? ` · ${rupee(a.current_balance)}` : ""}
                </option>
              ))}
            </select>
            {usable.length === 0 && (
              <p className="text-xs text-ink-3 mt-1">No bank or cash account yet — <Link className="text-indigo underline" href="/accounting/banking">add one in Banking</Link>.</p>
            )}
            {account && (
              <p className="text-xs text-ink-3 mt-1">
                {isCash
                  ? `The ${account.name} balance ${kind === "drawings" ? "drops" : "goes up"} now.`
                  : "A line is added to this account now. When the bank statement is imported, reconcile that statement line to this entry — it replaces the line, so the money is never counted twice."}
              </p>
            )}
            {cashShort && <p role="alert" className="text-xs text-amber-ink mt-1">That is more than the {rupee(account?.current_balance ?? 0)} in {account?.name}. Check the amount, or record the cash that came in first.</p>}
          </FormField>

          {words.needsPartner && (
            <FormField label="Partner" required htmlFor="oe-partner">
              {/* R-1847: from the partners register, never free text. */}
              <PartnerPicker id="oe-partner" partners={partners} onDate={date || today} value={partner} onChange={setPartner} />
            </FormField>
          )}

          <FormField label="Note (optional)" htmlFor="oe-note">
            <Input id="oe-note" placeholder={kind === "drawings" ? "e.g. Home rent, personal LIC premium" : "e.g. From savings account"} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
          </FormField>
          {err && <p role="alert" className="text-sm text-rose">{err}</p>}
        </div>

        <DialogFooter>
          <Button type="button" variant="default" onClick={onClose}>Cancel</Button>
          <Button type="button" variant="primary" loading={record.isPending} onClick={submit}>
            {kind === "drawings" ? "Record drawings" : "Record capital"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Register card ──────────────────────────────────────────────────────────────────────────

export function OwnerEquityCard({ words, movements, partners = [], loading, error, onRetry, onRecord }: {
  words: OwnerEquityWords;
  movements: OwnerEquityMovement[];
  /** R-1847: the firm's partners register — linked entries show the register name. */
  partners?: FirmPartner[];
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  onRecord: (init: RecordInit) => void;
}) {
  const { data: accounts } = useBankAccounts();
  const del = useDeleteOwnerEquity();
  const confirm = useConfirm();
  const thisFy = fyOf(istToday());
  const fys = React.useMemo(() => {
    const s = new Set<number>([thisFy]);
    for (const m of movements) s.add(fyOf(m.movement_date));
    return [...s].sort((a, b) => b - a);
  }, [movements, thisFy]);
  const [fy, setFy] = React.useState(thisFy);
  const reg = React.useMemo(() => drawingsRegister(movements, fy), [movements, fy]);
  const inFy = movements.filter((m) => fyOf(m.movement_date) === fy);
  const accountById = (id: string) => (accounts ?? []).find((a) => a.id === id);

  function exportCsv() {
    const { header, rows } = drawingsRegisterCsv(movements, fy, (id) => accountText(accountById(id)), words);
    downloadCSV(`drawings-capital-${fyText(fy).replace(/\s/g, "-")}.csv`, header, rows);
  }

  async function remove(m: OwnerEquityMovement) {
    const ok = await confirm({
      title: "Remove this entry?",
      body: m.own_line
        ? `The ${rupee(m.amount)} line it added to ${accountText(accountById(m.bank_account_id))} is removed too.`
        : `The bank line stays and goes back to Unmatched on ${accountText(accountById(m.bank_account_id))}.`,
      confirmLabel: "Remove", danger: true,
    });
    if (ok) del.mutate(m.id);
  }

  if (!words.allowed) {
    return (
      <Card id="drawings" className="mt-6 p-5 md:p-6 scroll-mt-20">
        {/* Type not set reads as Pvt Ltd — a proprietor or firm sets it here to get drawings. */}
        <BusinessTypePrompt className="mb-3" />
        <h2 className="text-xs uppercase tracking-wider text-ink-3 font-semibold">Money paid to a director</h2>
        <p className="text-xs text-ink-3 mt-1 max-w-xl leading-relaxed">
          A Pvt Ltd company has no owner drawings. Money a director takes from the company is one of these — book it where it belongs:
        </p>
        <ul className="mt-3 space-y-2">
          {DIRECTOR_CHOICES.map((c) => (
            <li key={c.key} className="rounded-md border border-hairline p-3">
              <p className="text-sm text-ink font-medium">{c.label}</p>
              <p className="text-xs text-ink-3 mt-0.5">{c.hint}</p>
              {c.caution && <p className="text-xs text-amber-ink bg-amber-soft/40 rounded px-2 py-1 mt-1.5">{c.caution}</p>}
              {c.key !== "dividend" && <Link href={c.href as never} className="text-xs text-indigo underline mt-1 inline-block">Open</Link>}
            </li>
          ))}
        </ul>
      </Card>
    );
  }

  return (
    <Card id="drawings" className="mt-6 p-5 md:p-6 scroll-mt-20">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <h2 className="text-xs uppercase tracking-wider text-ink-3 font-semibold">{words.register}</h2>
          <p className="text-xs text-ink-3 mt-1 max-w-xl leading-relaxed">
            Money the {words.person} takes out lowers their capital; money put in adds to it. Neither is an expense or income.
            From the bank page, Reconcile a line as {words.drawings.toLowerCase()} — or record it here.
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <Button size="sm" variant="primary" icon="plus" onClick={() => onRecord({ kind: "drawings" })}>Record drawings</Button>
          <Button size="sm" variant="default" icon="plus" onClick={() => onRecord({ kind: "capital_introduced" })}>Record capital</Button>
        </div>
      </div>

      {error ? (
        <div className="mt-3"><LoadErrorInline what={words.register} onRetry={onRetry} error={error} /></div>
      ) : loading ? (
        <Skeleton className="mt-3 h-16 w-full" />
      ) : (
        <>
          <div className="mt-4 flex items-center justify-between gap-2 flex-wrap">
            <div className="flex gap-1.5 flex-wrap" role="group" aria-label="Financial year">
              {fys.map((y) => (
                <button key={y} type="button" aria-pressed={fy === y} onClick={() => setFy(y)}
                  className={`rounded-md border px-2 py-1 text-xs font-medium ${fy === y ? "border-indigo bg-indigo/10 text-indigo" : "border-hairline text-ink-2"}`}>
                  {fyText(y)}
                </button>
              ))}
            </div>
            <Button size="sm" variant="ghost" icon="download" onClick={exportCsv} disabled={inFy.length === 0}>CSV for CA</Button>
          </div>

          {inFy.length === 0 ? (
            <p className="mt-3 text-sm text-ink-3">No entries in {fyText(fy)}.</p>
          ) : (
            <>
              {/* By month + FY total */}
              <div className="mt-3 text-sm">
                <div className="grid grid-cols-[1fr_auto_auto] gap-x-4 text-3xs uppercase tracking-wider text-ink-3 font-semibold pb-1 border-b border-hairline">
                  <span>Month</span><span className="text-right">Put in</span><span className="text-right">Taken out</span>
                </div>
                {reg.months.map((r) => (
                  <div key={r.month} className="grid grid-cols-[1fr_auto_auto] gap-x-4 py-1 tabular-nums">
                    <span>{monthLabel(r.month)}</span>
                    <span className="text-right">{r.capitalIntroduced ? rupee(r.capitalIntroduced) : "—"}</span>
                    <span className="text-right">{r.drawings ? rupee(r.drawings) : "—"}</span>
                  </div>
                ))}
                <div className="grid grid-cols-[1fr_auto_auto] gap-x-4 py-1 border-t border-hairline font-semibold tabular-nums">
                  <span>{fyText(fy)} total</span>
                  <span className="text-right">{rupee(reg.totals.capitalIntroduced)}</span>
                  <span className="text-right">{rupee(reg.totals.drawings)}</span>
                </div>
              </div>

              {words.needsPartner && reg.byPartner.length > 0 && (
                <div className="mt-4 text-sm">
                  <p className="text-3xs uppercase tracking-wider text-ink-3 font-semibold pb-1 border-b border-hairline">By partner</p>
                  {reg.byPartner.map((p) => (
                    <div key={p.partner} className="flex justify-between gap-3 py-1 tabular-nums">
                      <span className="min-w-0 truncate">{p.partner}</span>
                      <span className="text-right text-ink-2">in {rupee(p.capitalIntroduced)} · out {rupee(p.drawings)}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* Every entry */}
              <ul className="mt-4 divide-y divide-hairline border-t border-hairline">
                {inFy.map((m) => {
                  const acc = accountById(m.bank_account_id);
                  const waiting = m.own_line && acc && acc.account_type !== "cash";
                  return (
                    <li key={m.id} className="py-2 flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm text-ink">
                          {m.kind === "drawings" ? words.drawings : words.capital}
                          {(() => {
                            const who = movementPartner(m, partners);
                            return who ? <span className="text-ink-2"> · {who.name}{who.linked ? "" : " (typed name — link it in Partners' capital above)"}</span> : null;
                          })()}
                        </p>
                        <p className="text-xs text-ink-3">
                          {formatDate(m.movement_date)} · {accountText(acc)}{m.note ? ` · ${m.note}` : ""}
                        </p>
                        {waiting && <p className="text-xs text-amber-ink mt-0.5">Waiting for the bank line — reconcile it to this entry when the statement comes in.</p>}
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className={`text-sm tabular-nums ${m.kind === "drawings" ? "text-rose" : "text-emerald"}`}>
                          {m.kind === "drawings" ? "−" : "+"}{rupee(m.amount)}
                        </span>
                        <button type="button" onClick={() => remove(m)} aria-label={`Remove ${m.kind === "drawings" ? "drawings" : "capital"} entry of ${rupee(m.amount)} on ${formatDate(m.movement_date)}`}
                          className="text-ink-3 hover:text-rose p-1">
                          <Icon name="trash" size={14} />
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </>
      )}
    </Card>
  );
}
