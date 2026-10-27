// @vitest-environment jsdom
/* R-1829 — a real HDFC statement of 1,449 lines showed "₹3 apart … download the full
   statement" in red. Amounts carry paise and are stored in whole rupees, so Σ(rounded)
   drifts a few rupees from the bank's own balance. That is rounding, not missing lines:
   the card must say so calmly, and keep the red card (with the date) for a real gap. */
import * as React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { StatementCheckCard } from "./statement-check-card";
import { checkStatement, type StatementLine } from "@/lib/banking/statement-check";

afterEach(cleanup);

type Raw = { date: string; debit: number; credit: number };   // true amounts, with paise

/** What the importer stores: amounts and running balance rounded to whole rupees. */
function stored(opening: number, raw: Raw[]): StatementLine[] {
  let bal = opening;
  return raw.map((r) => {
    bal = Math.round((bal - r.debit + r.credit) * 100) / 100;
    return { txn_date: r.date, debit: Math.round(r.debit), credit: Math.round(r.credit), balance_after: Math.round(bal) };
  });
}

const dayOf = (i: number, perDay = 7) =>
  new Date(Date.UTC(2026, 3, 1) + Math.floor(i / perDay) * 86_400_000).toISOString().slice(0, 10);

/** 1,449 lines, 7 a day. Ten debits of ₹999.35 round down (+₹0.35 each in the app) and
    the true closing balance ends in 50 paise, so the app ends exactly ₹3 above the bank. */
function paiseStatement(): StatementLine[] {
  const raw: Raw[] = [];
  for (let i = 0; i < 1449; i++) {
    const date = dayOf(i);
    if (i % 2 === 0) raw.push({ date, debit: 0, credit: 2500 });
    else raw.push({ date, debit: i < 20 ? 999.35 : 2400, credit: 0 });
  }
  return stored(100000, raw);
}

/** A whole-rupee statement of 40 lines (4 a day); `drop` removes one line from what is imported. */
function wholeStatement(drop?: number): StatementLine[] {
  const raw: Raw[] = [];
  for (let i = 0; i < 40; i++) {
    const date = dayOf(i, 4);
    raw.push(i % 2 === 0 ? { date, debit: 0, credit: 3000 } : { date, debit: i === 21 ? 500 : 1200, credit: 0 });
  }
  const lines = stored(100000, raw);
  return drop === undefined ? lines : lines.filter((_, i) => i !== drop);
}

const cases = [
  {
    name: "1,449 lines with paise rounding, ₹3 off → neutral rounding line, nothing missing",
    lines: paiseStatement(),
    verdict: "rounding",
    difference: 3,
    has: ["₹3 difference comes from paise rounding across 1,449 lines", "Nothing is missing"],
    hasNot: ["Fix:", "Lines missing", "download the full statement"],
    alert: false,
  },
  {
    name: "one missing ₹500 line → red card naming the date it starts",
    lines: wholeStatement(21),   // line 21 = the ₹500 debit on 6 Apr 2026 (4 lines a day)
    verdict: "off",
    difference: 500,
    has: ["₹500", "6 Apr 2026", "Fix:"],
    hasNot: ["paise rounding"],
    alert: true,
  },
  {
    name: "an exact match → the quiet Matches line",
    lines: wholeStatement(),
    verdict: "match",
    difference: 0,
    has: ["Matches the bank statement"],
    hasNot: ["Fix:", "paise rounding"],
    alert: false,
  },
] as const;

describe("StatementCheckCard — rounding vs a real gap (R-1829)", () => {
  it.each(cases)("$name", ({ lines, verdict, difference, has, hasNot, alert }) => {
    const check = checkStatement([...lines], 100000)!;
    expect(check.verdict).toBe(verdict);
    expect(check.difference).toBe(difference);

    const { container } = render(
      <StatementCheckCard check={check} openingBalance={100000} openingDate="2026-03-31" onImport={() => {}} />,
    );
    const text = container.textContent ?? "";
    for (const s of has) expect(text).toContain(s);
    for (const s of hasNot) expect(text).not.toContain(s);
    expect(container.querySelector("[role=alert]") !== null).toBe(alert);
    if (!alert) expect(container.querySelector(".text-rose")).toBeNull();
  });
});
