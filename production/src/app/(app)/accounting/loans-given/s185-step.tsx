/**
 * R-1853 — the step shown BEFORE a loan to a director is saved: what Companies Act s.185 says,
 * in plain words, and the reason this loan is allowed. Save stays off until a reason is picked;
 * "Back" leaves without saving. s.186's rough limit shows when the share capital register has
 * paid-up capital (R-1851). A caution, not a legal ruling — the CA decides.
 * Rules + sources: lib/accounting/director-loans.ts.
 */
"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import { rupee, cn } from "@/lib/utils";
import { COMPANIES_ACT_SOURCE, s185Options, type S185Basis, type S186Estimate } from "@/lib/accounting/director-loans";
import type { Designation } from "@/lib/company/directors";

export interface S185StepProps {
  directorName: string;
  designation: Designation;
  amount: number;
  interestRate: number;
  s186: S186Estimate | null;
  basis: S185Basis | null;
  onBasis: (b: S185Basis) => void;
}

export function S185Step({ directorName, designation, amount, interestRate, s186, basis, onBasis }: S185StepProps) {
  const options = s185Options(designation);
  return (
    <div className="space-y-3">
      <div className="rounded-md border border-amber/50 bg-amber-soft/40 p-3 text-sm text-ink-2 leading-relaxed">
        <p className="font-semibold text-ink mb-1">Companies Act s.185 bars most loans to a director</p>
        <p>
          A company may not lend to its own director (or the director&apos;s relative or firm). Breaking this can cost the company
          a fine of {rupee(500000)} to {rupee(2500000)}, and the director too (s.185(4)). If you are not sure, ask your CA before
          giving {rupee(amount)} to {directorName}.
        </p>
      </div>

      <fieldset>
        <legend className="block text-xs font-medium text-ink-2 mb-1.5">Why is this loan allowed?</legend>
        <div className="space-y-1.5">
          {options.map((o) => (
            <label
              key={o.key}
              className={cn(
                "flex items-start gap-2 rounded-md border px-3 py-2 text-sm",
                o.allowed ? "cursor-pointer" : "opacity-60 cursor-not-allowed",
                basis === o.key ? "border-amber bg-amber-soft/30" : "border-hairline",
              )}
            >
              <input
                type="radio"
                name="s185-basis"
                className="mt-1"
                value={o.key}
                checked={basis === o.key}
                disabled={!o.allowed}
                onChange={() => onBasis(o.key)}
              />
              <span className="min-w-0">
                <span className="block text-ink">{o.label}</span>
                <span className="block text-xs text-ink-3">{o.allowed ? o.section : o.why}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="rounded-md border border-hairline bg-paper-2/40 p-3 text-xs text-ink-2 leading-relaxed space-y-1">
        <p className="font-semibold text-ink-2">Also check s.186</p>
        {s186 ? (
          <p className={cn(s186.over && "text-rose font-medium")}>
            Loans given still owed + this loan = {rupee(s186.total)}. Rough limit: {rupee(s186.limit)} (60% of paid-up capital
            {" "}— free reserves and securities premium not counted).{" "}
            {s186.over
              ? "This goes over it — a special resolution may be needed first (s.186(3)). Ask your CA."
              : "Within it."}
          </p>
        ) : (
          <p>Add the share capital in Settings → Company to see the s.186 limit.</p>
        )}
        {interestRate <= 0 && (
          <p>s.186(7): a loan under s.186 may not carry interest below the Government-security yield for a similar term — an interest-free loan needs your CA&apos;s view.</p>
        )}
        <p>
          <a href={COMPANIES_ACT_SOURCE} target="_blank" rel="noreferrer" className="text-indigo underline">Read the Act (India Code)</a>
        </p>
      </div>
    </div>
  );
}

/** Footer for the step: Back (nothing saved) and Give — off until a reason is picked. */
export function S185Footer({
  amount, directorName, basis, pending, onBack, onGive,
}: { amount: number; directorName: string; basis: S185Basis | null; pending: boolean; onBack: () => void; onGive: () => void }) {
  return (
    <>
      <Button type="button" variant="default" onClick={onBack}>Back</Button>
      <Button type="button" variant="primary" loading={pending} disabled={!basis} onClick={onGive}>
        Give {rupee(amount)} to {directorName}
      </Button>
    </>
  );
}
