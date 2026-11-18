/**
 * R-2095 (30 Oct 2026, September reconcile): Reconcile → money in → "Other / manual" could only mark
 * an interest credit reconciled — the P&L never saw it. "Interest received" books the line as other
 * income (P&L → Other income) and reconciles it, one transaction.
 *
 * R-2366 (2 Nov 2026, Pardeep: "app me interest income ka option banao"): interest now says where it
 * came from (FD / savings / other), may name the FD, and an FD premature closure is ONE save —
 * principal back from the FD (its balance goes down) + the rest as interest; TDS the bank deducted
 * goes to TDS receivable and the income is booked gross (book_bank_credit_as_interest).
 *
 * R-2390 (staging 2 Nov): nothing is pre-picked any more unless the narration says interest — the
 * ₹40,02,110 FD auto-redeem line had "Other income" pre-picked (one click = ₹40 L booked as income).
 * An FD redeem / premature closure / sweep line pre-picks Interest received → Fixed deposit → that FD
 * with "FD closed" ticked, i.e. the R-2366 closure above (principal back + the rest as interest).
 *
 * R-2935 (staging 18 Nov, HDFC 4523): a bank that pays the FD on three lines (… REDEEM PRINCIPAL /
 * … REDEEM INTEREST / … REDEEM TAX) — the INTEREST line books as plain interest (redeemVerdict: by
 * itself when the FD's balance is already 0, else after the owner ticks "Interest only"; held while
 * the FD's money could be inside it); the PRINCIPAL line is never income — not as Other income
 * either. A held save says why next to the button (footer reason), not only in the form.
 */
"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { rupee } from "@/lib/utils";
import { useBankAccounts, type BankTransactionRow } from "@/lib/queries/bank";
import { useBookInterestIncome, useBookOtherIncome, type OtherIncomeHead } from "@/lib/queries/bank-other-income";
import { fdRedeemGuess, fdRedeemPart, guessInterestSource, interestSplit, looksLikeInterest, redeemVerdict, type InterestSource } from "@/lib/banking/interest-income";
import { useFooterSaveReport, type FooterSave } from "./reconcile-who-tiles";

export { looksLikeInterest };

type FdLite = { id: string; name: string; account_type?: string | null; account_number_last4?: string | null; is_active?: boolean | null; current_balance?: number | null };

/** Smart default for an FD closure: the FD's whole balance comes back, when it fits in this line. */
function defaultPrincipal(fd: FdLite | null | undefined, amount: number): string {
  const bal = fd?.current_balance ?? 0;
  return bal > 0 && bal < amount ? String(bal) : "";
}

type PrePick = {
  head: OtherIncomeHead | null; source: InterestSource; fdId: string; closure: boolean; principalText: string;
  /** The narration says an FD came back (fdRedeemGuess) — interest without "FD closed" is refused
   *  while the principal could be in the line (redeemVerdict, R-2935). */
  redeem: boolean;
};

/** R-2390: what the narration lets us pre-pick — never "Other income" on its own. */
function pickFor(description: string | null | undefined, fds: readonly FdLite[], amount: number): PrePick {
  const g = fdRedeemGuess(description, fds);
  const fd = g.fdId ? fds.find((a) => a.id === g.fdId) ?? null : null;
  if (g.redeem) {
    /* R-2935: the bank's own "… REDEEM INTEREST" line — interest only, the FD named, nothing to split. */
    if (redeemVerdict({ description, redeem: true, credit: amount, fd, fds }) !== "hold") {
      return { head: "interest", source: "fd", fdId: fd?.id ?? "", closure: false, principalText: "", redeem: true };
    }
    return { head: "interest", source: "fd", fdId: fd?.id ?? "", closure: !!fd, principalText: fd ? defaultPrincipal(fd, amount) : "", redeem: true };
  }
  const interest = looksLikeInterest(description);
  const source = guessInterestSource(description);
  return {
    head: interest ? "interest" : null, source,
    fdId: interest && source === "fd" && fd ? fd.id : "", closure: false, principalText: "", redeem: false,
  };
}

const REDEEM_NEEDS_CLOSURE = "This line looks like an FD coming back — pick the FD and tick “FD closed”, so the principal is not booked as income.";

/** R-2935: an "… INTEREST" redeem line with nothing in the books proving the principal is elsewhere. */
const SAY_INTEREST_ONLY = "Tick “Interest only” if the principal came on its own bank line — or pick the FD and tick “FD closed” if the principal is in this line.";
/** R-2935: a redeem line is the FD's money (or part of it) — never plain Other income. */
const REDEEM_NOT_OTHER = "This line looks like an FD coming back — it is not other income. Use Interest received, or Own transfer for the principal.";
/** R-2935: the bank's "… REDEEM PRINCIPAL" line — the FD's own money, never income. */
const PRINCIPAL_LINE = "This line is the FD principal coming back, not income — reconcile it under Own transfer, from the FD account.";

const PICK_HEAD = "Pick Interest received or Other income";

const SOURCES: readonly (readonly [InterestSource, string])[] = [["fd", "Fixed deposit"], ["savings", "Savings account"], ["other", "Other"]];

/** "1,00,000" / "₹ 600" → 100000 / 600; blank → 0. */
function rupeesIn(s: string): number {
  const n = Number(s.replace(/[₹,\s]/g, ""));
  return Number.isFinite(n) ? Math.round(n) : NaN;
}

export function OtherIncomeSection({ transaction, onDone, onFooterSave }: {
  transaction: BankTransactionRow;
  onDone: () => void;
  /** R-2354: the Reconcile sheet draws "Book ₹X as interest received / other income" in its sticky
   *  footer. Given → no inline button; the footer gets the same label, disabled rule and submit. */
  onFooterSave?: (save: FooterSave | null) => void;
}) {
  const book = useBookOtherIncome();
  const bookInterest = useBookInterestIncome();
  const accountsQ = useBankAccounts();
  const amount = transaction.credit ?? 0;
  const fds = ((accountsQ.data ?? []) as FdLite[])
    .filter((a) => a.account_type === "fixed_deposit" && a.id !== transaction.bank_account_id && a.is_active !== false);
  /* R-2390: the pre-pick (pickFor) is redone when the line changes; when the FD list arrives later it
     is applied only if the owner has not touched the form yet — it never undoes their choice. */
  const fdsKey = fds.map((a) => a.id).join(",");
  const lineKey = `${transaction.id}|${transaction.description ?? ""}|${amount}`;
  const first = React.useMemo(() => pickFor(transaction.description, fds, amount),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fds is new each render; fdsKey stands for it
    [lineKey, fdsKey]);
  const [head, setHead] = React.useState<OtherIncomeHead | null>(first.head);
  const [source, setSource] = React.useState<InterestSource>(first.source);
  const [fdId, setFdId] = React.useState(first.fdId);
  const [closure, setClosure] = React.useState(first.closure);
  const [principalText, setPrincipalText] = React.useState(first.principalText);
  const [tdsText, setTdsText] = React.useState("");
  /* R-2935: the owner's own word that a redeem line is interest only (asked when the books cannot tell). */
  const [interestOnly, setInterestOnly] = React.useState(false);
  const touched = React.useRef(false);
  const lastLine = React.useRef(lineKey);
  React.useEffect(() => {
    if (lastLine.current !== lineKey) { lastLine.current = lineKey; touched.current = false; setTdsText(""); setInterestOnly(false); }
    if (touched.current) return;
    setHead(first.head); setSource(first.source); setFdId(first.fdId);
    setClosure(first.closure); setPrincipalText(first.principalText);
  }, [first, lineKey]);
  const touch = () => { touched.current = true; };

  const fd = fds.find((a) => a.id === fdId) ?? null;
  const isClosure = head === "interest" && source === "fd" && !!fd && closure;
  const principal = isClosure ? rupeesIn(principalText) : 0;
  const tds = head === "interest" ? rupeesIn(tdsText) : 0;
  const split = interestSplit({ credit: amount, principal: principal || 0, tds: tds || 0, fdBalance: isClosure ? fd?.current_balance ?? null : null });
  const badNumber = Number.isNaN(principal) || Number.isNaN(tds);
  /* R-2935: a redeem line books as plain interest only when the principal cannot be inside it. */
  const verdict = isClosure ? "free" : redeemVerdict({
    description: transaction.description, redeem: first.redeem, credit: amount, fd: source === "fd" ? fd : null, fds,
  });
  const askInterestOnly = head === "interest" && verdict === "ask";
  const part = fdRedeemPart(transaction.description);
  const splitError = head === "other" ? (first.redeem ? REDEEM_NOT_OTHER : null)
    : head !== "interest" ? null
    : verdict === "hold" ? REDEEM_NEEDS_CLOSURE
    : verdict === "ask" && !interestOnly ? SAY_INTEREST_ONLY
    : badNumber ? "Enter amounts in rupees."
    : isClosure && principal <= 0 ? "Enter the principal coming back from the FD."
    : split.error;
  /* The bank's "… PRINCIPAL" line (one that does not also say interest) has nothing to split off —
     say where it goes instead. */
  const interestError = splitError && !badNumber && part === "principal" && !looksLikeInterest(transaction.description) ? PRINCIPAL_LINE : splitError;

  function pickFd(id: string) {
    touch();
    setFdId(id);
    if (!id) setClosure(false);
    /* R-2390: another FD → its own balance, never the previous FD's. */
    else if (closure) setPrincipalText(defaultPrincipal(fds.find((a) => a.id === id), amount));
  }
  function toggleClosure(on: boolean) {
    touch();
    setClosure(on);
    if (on && !principalText) setPrincipalText(defaultPrincipal(fd, amount));
  }

  async function submit() {
    if (head === null) return;   // R-2390: the owner must pick first
    try {
      if (head === "interest") {
        await bookInterest.mutateAsync({
          transactionId: transaction.id, source,
          fdAccountId: source === "fd" && fd ? fd.id : null,
          principal: isClosure ? principal : 0, interest: split.interest, tds: tds || 0,
        });
      } else {
        await book.mutateAsync({ transactionId: transaction.id, head });
      }
      onDone();
    } catch { /* the hook toasts */ }
  }

  /* R-2354: same label, same rule, same submit() — in the footer when the sheet asks. */
  const saveLabel = head === null ? `Book ${rupee(amount)} as income`
    : head !== "interest" ? `Book ${rupee(amount)} as other income`
    : isClosure && principal > 0 ? `Book FD closure: ${rupee(principal)} principal + ${rupee(split.gross)} interest`
    : `Book ${rupee(split.gross)} as interest received`;
  const pending = book.isPending || bookInterest.isPending;
  const disabled = amount <= 0 || head === null || !!interestError;
  useFooterSaveReport(onFooterSave, {
    label: saveLabel, onSave: () => { void submit(); }, disabled, loading: pending,
    /* R-2935: a held save says why next to the button — the form's own line may be scrolled away. */
    disabledReason: head === null ? `${PICK_HEAD} first.` : amount > 0 ? interestError : null,
  });

  return (
    <section aria-label="Income that is not a sale" className="rounded-md border border-emerald/40 bg-emerald-soft/20 p-3 space-y-2">
      <p className="text-xs font-semibold text-ink-2">Interest or other income?</p>
      <p className="text-xs text-ink-3 leading-relaxed">
        Interest on an FD or savings account is income, not a sale — it goes to the P&amp;L as <b>Other income</b>.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5" role="group" aria-label="What this income is">
        {([["interest", "Interest received"], ["other", "Other income"]] as const).map(([k, label]) => (
          <button key={k} type="button" aria-pressed={head === k} onClick={() => { touch(); setHead(k); }}
            className={`rounded-md border px-2 py-1.5 text-xs font-medium text-left ${head === k ? "border-emerald bg-emerald/10 text-ink" : "border-hairline text-ink-2"}`}>
            {label}
          </button>
        ))}
      </div>
      {head === null && !onFooterSave && <p className="text-xs text-ink-3">{PICK_HEAD}.</p>}
      {head === "other" && interestError && <p className="text-xs text-rose-ink" aria-live="polite">{interestError}</p>}

      {head === "interest" && (
        <div className="space-y-2 border-t border-hairline pt-2">
          <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Interest from">
            <span className="text-xs text-ink-3 mr-1">Interest from</span>
            {SOURCES.map(([k, label]) => (
              <button key={k} type="button" aria-pressed={source === k} onClick={() => { touch(); setSource(k); }}
                className={`rounded-md border px-2 py-1 text-xs font-medium ${source === k ? "border-emerald bg-emerald/10 text-ink" : "border-hairline text-ink-2"}`}>
                {label}
              </button>
            ))}
          </div>

          {source === "fd" && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 items-center">
              <select value={fdId} onChange={(e) => pickFd(e.target.value)} aria-label="FD account"
                className="min-w-0 rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-emerald/40">
                <option value="">{fds.length ? "Which FD? (optional)" : "No FD account yet — add one under Own transfer"}</option>
                {fds.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}{a.current_balance != null ? ` · ${rupee(a.current_balance)}` : ""}</option>
                ))}
              </select>
              {fd && (
                <label className="flex items-center gap-2 text-xs text-ink-2">
                  <input type="checkbox" checked={closure} onChange={(e) => toggleClosure(e.target.checked)} />
                  FD closed — this line has the principal too
                </label>
              )}
            </div>
          )}

          {askInterestOnly && (
            <label className="flex items-center gap-2 text-xs text-ink-2">
              <input type="checkbox" checked={interestOnly} onChange={(e) => { touch(); setInterestOnly(e.target.checked); }} />
              Interest only — the principal came on its own bank line
            </label>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {isClosure && (
              <label className="text-xs text-ink-3 space-y-1">
                <span>Principal back from the FD (₹)</span>
                <Input value={principalText} onChange={(e) => { touch(); setPrincipalText(e.target.value); }} inputMode="numeric"
                  aria-label="Principal back from the FD" placeholder={fd?.current_balance ? String(fd.current_balance) : "0"} />
              </label>
            )}
            <label className="text-xs text-ink-3 space-y-1">
              <span>TDS deducted by the bank (₹, optional)</span>
              <Input value={tdsText} onChange={(e) => { touch(); setTdsText(e.target.value); }} inputMode="numeric"
                aria-label="TDS deducted by the bank" placeholder="0" />
            </label>
          </div>

          {first.redeem && part === "interest" && (
            <p className="text-xs text-ink-3">
              If the bank took the TDS as its own bank line (… TAX), leave TDS at 0 here and book that line under Tax → TDS cut by bank.
            </p>
          )}

          <p className="text-xs text-ink-2" aria-live="polite">
            {interestError ? <span className="text-rose-ink">{interestError}</span> : (
              <>
                Interest income <b>{rupee(split.gross)}</b>
                {(isClosure || (tds || 0) > 0) && (
                  <span className="text-ink-3">
                    {" "}= {rupee(split.interest)} credited{(tds || 0) > 0 ? ` + ${rupee(tds)} TDS (to TDS receivable)` : ""}
                    {isClosure ? ` · ${rupee(principal)} principal back from ${fd?.name}` : ""}
                  </span>
                )}
              </>
            )}
          </p>
        </div>
      )}

      {!onFooterSave && (
        <Button size="sm" variant="primary" icon="check" onClick={submit} loading={pending} disabled={pending || disabled}>
          {saveLabel}
        </Button>
      )}
    </section>
  );
}
