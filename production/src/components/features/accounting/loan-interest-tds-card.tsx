/**
 * R-2376 — Business Loans: "TDS 10% due" on interest to a non-bank lender (s.393(1) Table 5(iii)
 * Income-tax Act 2025, old s.194A) once one lender's FY interest + processing fee (ex-GST) is
 * above ₹10,000. Rule: lib/accounting/loan-interest-tds.ts.
 *
 * Shows ONLY what needs the owner: a due line (amount + the entry to post when deducting), a
 * one-time "is this lender a bank?" question, and — for a proprietorship — a one-time "were last
 * year's accounts tax-audited?" question. It never posts an entry: the owner keeps the TDS back on
 * a repayment (Banking → Reconcile → Loan / EMI, TDS box) — the one TDS payable list.
 * Answers: owner / accountant (set_loan_interest_tds refuses the rest).
 */
"use client";

import * as React from "react";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { rupee, formatDate } from "@/lib/utils";
import { istToday } from "@/lib/dates/ist";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { canDeleteMoney } from "@/lib/auth/roles";
import { useComplianceProfile } from "@/lib/compliance/profile";
import { useLoanInterestTds, useSetLoanInterestTds } from "@/lib/queries/loan-interest-tds";
import {
  loanInterestTds, fyStartOf, thresholdFor, LOAN_TDS, type LenderTdsLine, type DeductorGate,
} from "@/lib/accounting/loan-interest-tds";

const fyLabel = (start: number) => `FY ${start}-${String((start + 1) % 100).padStart(2, "0")}`;

export function LoanInterestTdsCard() {
  const q = useLoanInterestTds();
  const profile = useComplianceProfile();
  const role = useCurrentUser().data?.role;
  /* Same group as set_loan_interest_tds: owner / accountant (canDeleteMoney's roles). */
  const canAnswer = Boolean(role) && canDeleteMoney(role);
  const save = useSetLoanInterestTds();

  const view = React.useMemo(() => {
    if (!q.data?.ready) return null;
    const thisFy = fyStartOf(istToday());
    const businessType = profile.data?.businessType ?? null;
    let gate: DeductorGate | null = null;
    const lines: LenderTdsLine[] = [];
    let crossedButOff = false;
    for (const fy of [thisFy - 1, thisFy]) {
      const r = loanInterestTds({ events: q.data.events, settings: q.data.settings, businessType, fyStart: fy });
      if (fy === thisFy) gate = r.gate;
      for (const l of r.lines) {
        if (l.status === "due" || l.status === "ask_type") lines.push(l);
        if (l.status === "not_required" && r.gate.kind === "off") crossedButOff = true;
      }
    }
    return { gate: gate as DeductorGate, lines, crossedButOff, thisFy };
  }, [q.data, profile.data?.businessType]);

  if (!view) return null;
  const { gate, lines } = view;

  if (gate.kind === "off") {
    if (!view.crossedButOff) return null;
    return (
      <Card className="mb-5 p-3 text-xs text-ink-3 flex flex-wrap items-center gap-2" data-testid="loan-interest-tds">
        <span>The TDS check on loan interest is off.</span>
        {canAnswer && (
          <button type="button" className="text-indigo-ink font-medium underline hover:no-underline"
            onClick={() => save.mutate({ what: "off", key: null, value: "false" })}>Turn on</button>
        )}
      </Card>
    );
  }
  if (lines.length === 0) return null;

  return (
    <Card className="mb-5 p-3 md:p-4 border-amber/40 bg-amber-soft/25 space-y-3" data-testid="loan-interest-tds">
      <div>
        <p className="text-sm font-semibold text-ink">TDS on loan interest</p>
        <p className="text-xs text-ink-3 mt-0.5">
          Interest (and the loan processing fee, without GST) paid to one lender that is not a bank needs {LOAN_TDS.ratePct}% TDS
          once it is more than {rupee(thresholdFor(view.thisFy))} in the year — on the whole year&apos;s amount.
        </p>
      </div>

      {gate.kind === "ask_audit" && (
        <div className="rounded-md border border-hairline bg-paper p-2.5 text-sm text-ink-2">
          <p>
            A proprietorship deducts this TDS only if its accounts were <b>tax-audited</b> for {fyLabel(gate.prevFyStart)} (turnover above ₹1 crore).
            Were they?
          </p>
          {canAnswer ? (
            <div className="mt-2 flex flex-wrap gap-2">
              <Button size="sm" variant="default" loading={save.isPending}
                onClick={() => save.mutate({ what: "audited", key: String(gate.prevFyStart), value: "true" })}>Yes, tax-audited</Button>
              <Button size="sm" variant="default" loading={save.isPending}
                onClick={() => save.mutate({ what: "audited", key: String(gate.prevFyStart), value: "false" })}>No, not audited</Button>
            </div>
          ) : <p className="mt-1 text-xs text-ink-3">The owner or accountant answers this once.</p>}
        </div>
      )}

      {gate.kind === "not_required" ? null : (
        <ul className="space-y-2">
          {lines.map((l) => (
            <li key={`${l.fyStart}-${l.key}`} className="rounded-md border border-hairline bg-paper p-2.5 text-sm">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-medium text-ink">{l.lender}</span>
                <span className="text-ink">
                  {l.status === "due" ? "TDS 10% due" : "TDS 10% may be due"} <b className="font-mono">{rupee(l.tdsDue)}</b>
                </span>
              </div>
              <p className="text-xs text-ink-3 mt-0.5">
                {fyLabel(l.fyStart)}: interest + fee {rupee(l.total)} — above {rupee(thresholdFor(l.fyStart))} on {formatDate(l.crossedOn ?? "")}
                {l.tdsKept > 0 && <> · {rupee(l.tdsKept)} already kept back</>} · {l.section}
              </p>
              {l.status === "ask_type" ? (
                canAnswer ? (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <span className="text-xs text-ink-2">Is {l.lender} a bank?</span>
                    <Button size="sm" variant="default" loading={save.isPending}
                      onClick={() => save.mutate({ what: "lender", key: l.key, value: "non_bank" })}>Not a bank (NBFC / other)</Button>
                    <Button size="sm" variant="default" loading={save.isPending}
                      onClick={() => save.mutate({ what: "lender", key: l.key, value: "bank" })}>Bank — no TDS</Button>
                  </div>
                ) : <p className="mt-1 text-xs text-ink-3">The owner or accountant marks whether {l.lender} is a bank.</p>
              ) : l.entry && (
                <p className="mt-1 text-xs text-ink-2">
                  Entry when you deduct: <b>Dr {l.entry.dr}</b> {rupee(l.entry.amount)} / <b>Cr {l.entry.cr}</b>.
                  Keep it back from the next payment to this lender (Banking → Reconcile → Loan / EMI, TDS box), then deposit it with your other TDS.
                </p>
              )}
            </li>
          ))}
        </ul>
      )}

      {canAnswer && (
        <button type="button" className="text-xs text-ink-3 underline hover:no-underline"
          onClick={() => save.mutate({ what: "off", key: null, value: "true" })}>Turn this check off</button>
      )}
    </Card>
  );
}
