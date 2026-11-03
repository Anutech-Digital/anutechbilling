/**
 * R-2394 — Private Vault → Banking → an account → one statement line, matched in a side sheet.
 *
 * Only the vault's own meanings (never the company ledger's): Expense (category), Income
 * (where it came from — R-2387), Drawing from company, Card payment, ATM cash, Transfer
 * between my accounts (pairs the other account's line, or creates it), Loan EMI / repayment
 * (R-2388 — the principal / interest split is booked by personal_loan_record_payment), Byana /
 * held money (R-2386), and Already entered (an entry typed on Loans / Income & Expenses — the
 * bank line merges into it, so the money is counted once).
 *
 * ONE RPC per save (personal_bank_reconcile): the line, its other leg / loan rows / owe-hold
 * entry and an "always put X under Y" rule land together or not at all.
 */
"use client";

import * as React from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Money } from "@/components/ui/money";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { PersonalAccount } from "@/lib/queries/personal-vault";
import { usePersonalCategories } from "@/lib/queries/personal-vault";
import { usePersonalLoans } from "@/lib/queries/personal-loans";
import { usePersonalOweHold } from "@/lib/queries/personal-owe-hold";
import {
  useAccountTransactions,
  useMatchableEntries,
  useReconcileLine,
  useUnreconcileLine,
  type AccountTx,
} from "@/lib/queries/personal-banking";
import {
  ACTION_LABEL,
  actionsFor,
  matchCandidates,
  matchStatus,
  ruleTextFrom,
  suggestedAction,
  transferCandidates,
  txSign,
  type ReconcileAction,
} from "@/lib/vault/personal/bank-ledger";
import { EXPENSE_FORM_CATEGORIES, INCOME_SOURCES, KIND_LABEL, rowLabel } from "@/lib/vault/personal/income-expense";
import { PAYMENT_KIND_LABEL, type LoanPaymentKind } from "@/lib/vault/personal/loans";
import { OWE_HOLD_KIND_LABEL, type OweHoldKind } from "@/lib/vault/personal/owe-hold";
import { formatDate, rupee } from "@/lib/utils";

const NEW = "__new__";
const NONE = "__none__";

interface Props {
  line: AccountTx | null;
  account: PersonalAccount;
  accounts: readonly PersonalAccount[];
  onOpenChange: (open: boolean) => void;
}

export function BankReconcileSheet({ line, account, accounts, onOpenChange }: Props) {
  return (
    <Sheet open={!!line} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:w-[30rem] sm:max-w-[95vw] overflow-y-auto">
        {line && <SheetBody key={line.id} line={line} account={account} accounts={accounts} onDone={() => onOpenChange(false)} />}
      </SheetContent>
    </Sheet>
  );
}

function SheetBody({ line, account, accounts, onDone }: { line: AccountTx; account: PersonalAccount; accounts: readonly PersonalAccount[]; onDone: () => void }) {
  const sign = txSign(line.kind, account.kind);
  const status = matchStatus(line);
  const allowed = actionsFor(sign, account.kind);
  const [action, setAction] = React.useState<ReconcileAction>(() => suggestedAction(line, sign, account.kind));

  const reconcile = useReconcileLine();
  const undo = useUnreconcileLine();
  const categoriesQ = usePersonalCategories();
  const loansQ = usePersonalLoans();
  const oweHoldQ = usePersonalOweHold();
  const matchableQ = useMatchableEntries(account.id, line.amount);

  // fields
  const [category, setCategory] = React.useState(line.kind === "expense" && line.category ? line.category : "");
  const [incomeSource, setIncomeSource] = React.useState<string>(line.kind === "salary" ? "salary" : line.kind === "interest" ? "interest" : line.kind === "dividend" ? "dividend" : line.kind === "refund" ? "refund" : "");
  const [party, setParty] = React.useState(line.party ?? "");
  const [makeRule, setMakeRule] = React.useState(false);
  const [ruleText, setRuleText] = React.useState(() => ruleTextFrom(line.raw_description));
  const [otherAccount, setOtherAccount] = React.useState<string>(NONE);
  const [pairWith, setPairWith] = React.useState<string>(NEW);
  const [loanId, setLoanId] = React.useState<string>("");
  const [payKind, setPayKind] = React.useState<LoanPaymentKind | "">("");
  const [interest, setInterest] = React.useState("");
  const [holdId, setHoldId] = React.useState<string>(NEW);
  const [holdKind, setHoldKind] = React.useState<OweHoldKind>("advance_received");
  const [matchId, setMatchId] = React.useState<string>("");

  const others = accounts.filter((a) => a.id !== account.id && a.is_active);
  const otherChoices =
    action === "card_payment" ? others.filter((a) => (a.kind === "credit_card") !== (account.kind === "credit_card"))
    : action === "atm_cash" ? others.filter((a) => a.kind === "cash" || a.kind === "wallet")
    : others.filter((a) => a.kind !== "credit_card");

  const otherAcc = accounts.find((a) => a.id === otherAccount);
  const otherLinesQ = useAccountTransactions(action === "transfer" && otherAcc ? otherAcc.id : null);
  const pairs = otherAcc ? transferCandidates(line, sign, otherAcc.kind, otherLinesQ.data ?? []) : [];

  const direction = sign === -1 ? "taken" : "given";
  const loans = (loansQ.data ?? []).filter((l) => l.status === "open" && l.direction === direction);
  const payKinds: LoanPaymentKind[] = direction === "taken" ? ["emi", "prepayment", "interest"] : ["repayment", "interest"];
  const holds = (oweHoldQ.data ?? []).filter((h) => h.status === "open");
  const candidates = matchCandidates(line, account.kind, matchableQ.data ?? []);

  const ownExpense = (categoriesQ.data ?? []).filter((c) => c.direction === "expense").map((c) => c.name);
  const expenseCats = [...new Set([...EXPENSE_FORM_CATEGORIES, ...ownExpense])];

  /** Something the owner still has to pick — what is missing, and what to do (§24). */
  const need = (what: string, how: string) => { toast.error(what, { description: how }); };

  const save = async () => {
    let payload: Record<string, string | number | null | undefined> = {};
    switch (action) {
      case "expense":
        if (!category) { need("Pick a category.", "Choose one in the Category box, then press Save match. Nothing was saved."); return; }
        payload = { category, party, rule_text: makeRule ? ruleText.trim() : undefined };
        break;
      case "income":
        if (!incomeSource) { need("Pick where the money came from.", "Choose the source (salary, rent, interest…), then press Save match. Nothing was saved."); return; }
        payload = { income_source: incomeSource, party, rule_text: makeRule ? ruleText.trim() : undefined };
        break;
      case "drawing":
        payload = { party };
        break;
      case "card_payment":
      case "atm_cash":
        payload = { other_account_id: otherAccount === NONE ? undefined : otherAccount };
        break;
      case "transfer":
        if (otherAccount === NONE) { need("Pick the other account.", "Choose the account the money moved to or from. Nothing was saved."); return; }
        payload = { other_account_id: otherAccount, pair_tx_id: pairWith === NEW ? undefined : pairWith };
        break;
      case "loan":
        if (!loanId) { need("Pick the loan.", "Choose the loan this EMI belongs to — or add the loan on the Loans page first. Nothing was saved."); return; }
        if (interest && !/^\d+$/.test(interest.replace(/,/g, ""))) { need("Interest must be a whole amount in rupees.", "Type digits only, like 14167 — or leave it empty for the scheduled split. Nothing was saved."); return; }
        payload = { loan_id: loanId, pay_kind: payKind || undefined, interest: interest ? interest.replace(/,/g, "") : undefined };
        break;
      case "owe_hold":
        if (holdId === NEW) {
          if (sign === -1) { need("Pick the entry this payment settles.", "Choose the byana / held-money entry this payment is for. Nothing was saved."); return; }
          if (!party.trim()) { need("Type whose money it is.", "Type the buyer or person the money belongs to. Nothing was saved."); return; }
          payload = { hold_kind: holdKind, party };
        } else {
          payload = { owe_hold_id: holdId };
        }
        break;
      case "match":
        if (!matchId) { need("Pick the entry this line is.", "Choose one of the entries listed, or pick another type above. Nothing was saved."); return; }
        payload = { match_tx_id: matchId };
        break;
    }
    try {
      const res = await reconcile.mutateAsync({ txId: line.id, action, payload });
      toast.success("Line matched.", {
        description: res.suggested > 0 ? `The rule also suggested ${category || "this category"} for ${res.suggested} other line${res.suggested === 1 ? "" : "s"}.` : undefined,
      });
      onDone();
    } catch { /* the hook already showed why */ }
  };

  const doUndo = async () => {
    try {
      await undo.mutateAsync(line.id);
      toast.success("Match undone — the line is unmatched again.");
      onDone();
    } catch { /* the hook already showed why */ }
  };

  return (
    <>
      <SheetHeader>
        <SheetTitle>{status === "matched" ? "Matched line" : "Match this line"}</SheetTitle>
        <SheetDescription>
          {formatDate(line.occurred_on)} · {account.label}
        </SheetDescription>
      </SheetHeader>

      <div className="px-6 pb-6 space-y-4">
        <div className="rounded-lg border border-hairline bg-paper-2 p-3">
          <p className="text-sm text-ink break-words">{line.raw_description || line.note || "—"}</p>
          <div className="mt-1 flex items-center gap-2">
            <Badge kind={sign === 1 ? "success" : "muted"} size="sm">{sign === 1 ? "Money in" : "Money out"}</Badge>
            <Money amount={line.amount} size="cell" />
            {line.reference && <span className="text-3xs text-ink-3 font-mono truncate">{line.reference}</span>}
          </div>
        </div>

        {status === "matched" ? (
          <div className="space-y-3">
            <p className="text-sm text-ink-2" data-testid="vbr-matched-as">
              Matched as <strong>{line.category === "Byana / held money" ? "Byana / held money" : rowLabel({ kind: line.kind, income_source: line.income_source })}</strong>
              {line.category && line.kind === "expense" && <> · {line.category}</>}
            </p>
            <Button variant="outline" onClick={doUndo} loading={undo.isPending}>Undo match</Button>
          </div>
        ) : (
          <>
            <fieldset>
              <legend className="block text-2xs uppercase tracking-wide text-ink-3 mb-1.5">What is this?</legend>
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="What is this?">
                {allowed.map((a) => (
                  <button
                    key={a}
                    type="button"
                    aria-pressed={action === a}
                    onClick={() => setAction(a)}
                    className={`rounded-full border px-3 py-1 text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 ${action === a ? "border-ink bg-ink text-paper" : "border-hairline text-ink-2 hover:bg-paper-2"}`}
                  >
                    {ACTION_LABEL[a]}{a === "match" && candidates.length > 0 ? ` (${candidates.length})` : ""}
                  </button>
                ))}
              </div>
            </fieldset>

            {action === "expense" && (
              <>
                <div>
                <label htmlFor="vbr-category" className="block text-2xs uppercase tracking-wide text-ink-3 mb-1">Category</label>
                  <Select value={category} onValueChange={setCategory}>
                    <SelectTrigger id="vbr-category"><SelectValue placeholder="Pick a category" /></SelectTrigger>
                    <SelectContent>
                      {expenseCats.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                <label htmlFor="vbr-party" className="block text-2xs uppercase tracking-wide text-ink-3 mb-1">Paid to (optional)</label>
                  <Input id="vbr-party" value={party} onChange={(e) => setParty(e.target.value)} placeholder="Shop / person" />
                </div>
              </>
            )}

            {action === "income" && (
              <>
                <div>
                <label htmlFor="vbr-source" className="block text-2xs uppercase tracking-wide text-ink-3 mb-1">Where it came from</label>
                  <Select value={incomeSource} onValueChange={setIncomeSource}>
                    <SelectTrigger id="vbr-source"><SelectValue placeholder="Pick a source" /></SelectTrigger>
                    <SelectContent>
                      {INCOME_SOURCES.map((s) => <SelectItem key={s.id} value={s.id}>{s.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                <label htmlFor="vbr-party" className="block text-2xs uppercase tracking-wide text-ink-3 mb-1">Paid by (optional)</label>
                  <Input id="vbr-party" value={party} onChange={(e) => setParty(e.target.value)} placeholder="Employer / tenant" />
                </div>
              </>
            )}

            {(action === "expense" || action === "income") && (
              <div className="space-y-1.5">
                <label className="flex items-center gap-2 text-sm text-ink-2">
                  <input type="checkbox" checked={makeRule} onChange={(e) => setMakeRule(e.target.checked)} />
                  Always put lines with this text here
                </label>
                {makeRule && (
                  <Input aria-label="Rule text" value={ruleText} onChange={(e) => setRuleText(e.target.value)} placeholder="SWIGGY" />
                )}
              </div>
            )}

            {action === "drawing" && (
              <div>
                <label htmlFor="vbr-party" className="block text-2xs uppercase tracking-wide text-ink-3 mb-1">Company (optional)</label>
                <Input id="vbr-party" value={party} onChange={(e) => setParty(e.target.value)} placeholder="Your company" />
              </div>
            )}

            {(action === "card_payment" || action === "atm_cash" || action === "transfer") && (
              <div>
                <label htmlFor="vbr-other" className="block text-2xs uppercase tracking-wide text-ink-3 mb-1">{action === "card_payment" ? (account.kind === "credit_card" ? "Paid from" : "Card paid") : action === "atm_cash" ? "Cash kept in (optional)" : sign === -1 ? "Moved to" : "Moved from"}</label>
                <Select value={otherAccount} onValueChange={(v) => { setOtherAccount(v); setPairWith(NEW); }}>
                  <SelectTrigger id="vbr-other"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {action !== "transfer" && <SelectItem value={NONE}>Not tracked here</SelectItem>}
                    {action === "transfer" && <SelectItem value={NONE}>Pick an account</SelectItem>}
                    {otherChoices.map((a) => <SelectItem key={a.id} value={a.id}>{a.label}</SelectItem>)}
                  </SelectContent>
                </Select>
                {action !== "transfer" && otherAccount !== NONE && (
                  <p className="mt-1 text-3xs text-ink-3">The same amount is added on {otherAcc?.label} too.</p>
                )}
              </div>
            )}

            {action === "transfer" && otherAcc && (
              <fieldset>
                <legend className="block text-2xs uppercase tracking-wide text-ink-3 mb-1">Line on {otherAcc.label}</legend>
                <div className="space-y-1">
                  {pairs.map((p) => (
                    <label key={p.id} className="flex items-center gap-2 text-sm text-ink-2">
                      <input type="radio" name="vbr-pair" checked={pairWith === p.id} onChange={() => setPairWith(p.id)} />
                      {formatDate(p.occurred_on)} · {p.raw_description || p.note || KIND_LABEL[p.kind]}
                    </label>
                  ))}
                  <label className="flex items-center gap-2 text-sm text-ink-2">
                    <input type="radio" name="vbr-pair" checked={pairWith === NEW} onChange={() => setPairWith(NEW)} />
                    Add the line on {otherAcc.label}
                  </label>
                </div>
              </fieldset>
            )}

            {action === "loan" && (
              <>
                <div>
                <label htmlFor="vbr-loan" className="block text-2xs uppercase tracking-wide text-ink-3 mb-1">{direction === "taken" ? "Loan you took" : "Loan you gave"}</label>
                  <Select value={loanId} onValueChange={setLoanId}>
                    <SelectTrigger id="vbr-loan"><SelectValue placeholder={loans.length ? "Pick the loan" : "No open loan — add it on Loans"} /></SelectTrigger>
                    <SelectContent>
                      {loans.map((l) => <SelectItem key={l.id} value={l.id}>{l.party}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                <label htmlFor="vbr-paykind" className="block text-2xs uppercase tracking-wide text-ink-3 mb-1">Payment</label>
                    <Select value={payKind || payKinds[0]} onValueChange={(v) => setPayKind(v as LoanPaymentKind)}>
                      <SelectTrigger id="vbr-paykind"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {payKinds.map((k) => <SelectItem key={k} value={k}>{PAYMENT_KIND_LABEL[k]}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                <label htmlFor="vbr-interest" className="block text-2xs uppercase tracking-wide text-ink-3 mb-1">Interest part (₹)</label>
                    <Input id="vbr-interest" value={interest} onChange={(e) => setInterest(e.target.value)} inputMode="numeric" placeholder="Scheduled" />
                  </div>
                </div>
                <p className="text-3xs text-ink-3">Leave the interest empty for the scheduled split. The rest of the line is principal.</p>
              </>
            )}

            {action === "owe_hold" && (
              <>
                <div>
                <label htmlFor="vbr-hold" className="block text-2xs uppercase tracking-wide text-ink-3 mb-1">Entry</label>
                  <Select value={holdId} onValueChange={setHoldId}>
                    <SelectTrigger id="vbr-hold"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {sign === 1 && <SelectItem value={NEW}>New entry</SelectItem>}
                      {sign === -1 && <SelectItem value={NEW}>Pick an entry</SelectItem>}
                      {holds.map((h) => <SelectItem key={h.id} value={h.id}>{h.party} · {rupee(h.amount)}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                {sign === 1 && holdId === NEW && (
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                <label htmlFor="vbr-holdkind" className="block text-2xs uppercase tracking-wide text-ink-3 mb-1">Type</label>
                      <Select value={holdKind} onValueChange={(v) => setHoldKind(v as OweHoldKind)}>
                        <SelectTrigger id="vbr-holdkind"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {(["advance_received", "held_for_other"] as const).map((k) => <SelectItem key={k} value={k}>{OWE_HOLD_KIND_LABEL[k]}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>
                    <div>
                <label htmlFor="vbr-party" className="block text-2xs uppercase tracking-wide text-ink-3 mb-1">Whose money</label>
                      <Input id="vbr-party" value={party} onChange={(e) => setParty(e.target.value)} placeholder="Buyer / daughter" />
                    </div>
                  </div>
                )}
                <p className="text-3xs text-ink-3">Held money stays in the account but is taken off Net worth while it is open.</p>
              </>
            )}

            {action === "match" && (
              <fieldset>
                <legend className="block text-2xs uppercase tracking-wide text-ink-3 mb-1">Entries you already typed (same amount)</legend>
                {candidates.length === 0 ? (
                  <p className="text-sm text-ink-3">No entry of this amount within 10 days. Pick another type above.</p>
                ) : (
                  <div className="space-y-1">
                    {candidates.map((c) => (
                      <label key={c.id} className="flex items-center gap-2 text-sm text-ink-2">
                        <input type="radio" name="vbr-match" checked={matchId === c.id} onChange={() => setMatchId(c.id)} />
                        {formatDate(c.occurred_on)} · {rowLabel(c)}{c.category ? ` · ${c.category}` : ""}{c.note ? ` · ${c.note}` : ""}
                      </label>
                    ))}
                  </div>
                )}
              </fieldset>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={onDone}>Cancel</Button>
              <Button variant="primary" onClick={save} loading={reconcile.isPending}>Save match</Button>
            </div>
          </>
        )}
      </div>
    </>
  );
}
