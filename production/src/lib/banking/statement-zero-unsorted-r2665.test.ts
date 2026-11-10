/**
 * R-2665 — two false "lines missing" alarms found importing HDFC credit-card statements (10 Nov):
 *  (1) a running balance of exactly ₹0 (the card fully paid) was read as "no balance", so the
 *      day it ended was compared on its other line and the payment showed as a missing gap;
 *  (2) the chain was walked in FILE order — HDFC prints Domestic lines, then International lines
 *      (each block in date order), so the dates jump back and the opening / breaks were wrong.
 * Every check now walks the lines in date order, stable within a day (a newest-first file is
 * turned round first). A real missing line must still be found.
 */
import { describe, expect, it } from "vitest";

import { parseStatement, settleReversals, type ParsedRow } from "./statement-parse";
import { checkPreview } from "./statement-verify";
import { checkStatement, inDateOrder } from "./statement-check";
import { openingBalanceFromStatement } from "./opening-balance";

const csv = (...lines: string[]) => parseStatement(["Date,Narration,Debit,Credit,Balance", ...lines].join("\n"));

describe("R-2665 a ₹0 running balance is a real balance", () => {
  /* A credit-card account: balances below 0 are what is owed. */
  const res = csv(
    "01/02/2026,OPENING SPEND,100,,-200352",
    "03/02/2026,FUEL,100,,-200452",
    "03/02/2026,CARD PAYMENT,,200452,0",
    "05/02/2026,SHOP,50,,-50",
  );

  it("parse keeps 0 (and 0.00) as the balance; a blank cell stays 'no balance'", () => {
    expect(res.rows.map((r) => r.balance_after)).toEqual([-200352, -200452, 0, -50]);
    const more = csv("01/02/2026,A,10,,0.00", "02/02/2026,B,10,,", "03/02/2026,C,10,,-");
    expect(more.rows.map((r) => r.balance_after)).toEqual([0, null, null]);
  });

  it("the day that ends on ₹0 is not a gap of the payment amount (was: missing ₹2,00,452)", () => {
    expect(checkPreview(res.rows).gaps).toEqual([]);
    expect(checkStatement(res.rows, -200252)?.verdict).toBe("match");
    /* The statement ends on the ₹0 day — nothing after it to cancel the false gap out. */
    const endsOnZero = res.rows.slice(0, 3);
    expect(checkPreview(endsOnZero).gaps).toEqual([]);
    expect(checkStatement(endsOnZero, -200252)).toMatchObject({ verdict: "match", statementBalance: 0 });
  });

  it("opening read from a statement whose first line ends on ₹0", () => {
    const r = csv("01/02/2026,CARD PAYMENT,,5000,0", "02/02/2026,SHOP,50,,-50");
    expect(openingBalanceFromStatement(r.rows, "2026-02-01")).toMatchObject({ ok: true, amount: -5000, chainBreaks: 0 });
  });
});

describe("R-2665 lines printed in two date-sorted blocks (HDFC Domestic, then International)", () => {
  /* In date order: 20/01 −1000 → −1000, 22/01 −500 → −1500, 03/02 +1500 → 0, 05/02 −200 → −200. */
  const DOMESTIC = ["03/02/2026,CARD PAYMENT,,1500,0", "05/02/2026,SHOP,200,,-200"];
  const INTERNATIONAL = ["20/01/2026,SAAS INC,1000,,-1000", "22/01/2026,MARKUP FEE,500,,-1500"];
  const rows = csv(...DOMESTIC, ...INTERNATIONAL).rows;

  it("inDateOrder: by date, file order kept inside a day, newest-first file turned round first", () => {
    const l = (txn_date: string, n: number) => ({ txn_date, n });
    // two blocks (one step forward, one back — no proof of newest-first): file order inside a day.
    expect(inDateOrder([l("2026-02-03", 1), l("2026-02-03", 2), l("2026-02-05", 3), l("2026-01-20", 4)]).map((x) => x.n))
      .toEqual([4, 1, 2, 3]);
    // newest-first: the day's lines are newest-first too — reversed, then sorted.
    expect(inDateOrder([l("2026-02-05", 1), l("2026-02-03", 2), l("2026-02-03", 3), l("2026-01-20", 4)]).map((x) => x.n))
      .toEqual([4, 3, 2, 1]);
  });

  it("a two-block file with few dates is not taken for newest-first (same-day order kept)", () => {
    /* [03/02 PAY, 03/02 SHOP] then [20/01 SAAS]: one step back only — not newest-first. */
    const r = csv("03/02/2026,CARD PAYMENT,,1000,0", "03/02/2026,SHOP,200,,-200", "20/01/2026,SAAS INC,1000,,-1000").rows;
    expect(inDateOrder(r).map((x) => x.description)).toEqual(["SAAS INC", "CARD PAYMENT", "SHOP"]);
    expect(openingBalanceFromStatement(r, "2026-02-01")).toEqual({ ok: true, amount: -1000, firstLineDate: "2026-02-03", linesBefore: 1, chainBreaks: 0 });
  });

  it("a newest-first file is known by its running balance, even with only two dates", () => {
    /* Printed newest-first: 03/02 SHOP −200 → −200, 03/02 PAY +1000 → 0, 20/01 SAAS −1000 → −1000. */
    const r = csv("03/02/2026,SHOP,200,,-200", "03/02/2026,CARD PAYMENT,,1000,0", "20/01/2026,SAAS INC,1000,,-1000").rows;
    expect(inDateOrder(r).map((x) => x.description)).toEqual(["SAAS INC", "CARD PAYMENT", "SHOP"]);
    expect(openingBalanceFromStatement(r, "2026-02-01")).toMatchObject({ ok: true, amount: -1000, chainBreaks: 0 });
  });

  it("no false gap in the preview check", () => {
    expect(checkPreview(rows).gaps).toEqual([]);
  });

  it("opening balance from the statement: the right first line, no breaks", () => {
    expect(openingBalanceFromStatement(rows, "2026-01-01"))
      .toEqual({ ok: true, amount: 0, firstLineDate: "2026-01-20", linesBefore: 0, chainBreaks: 0 });
    expect(openingBalanceFromStatement(rows, "2026-02-01"))
      .toEqual({ ok: true, amount: -1500, firstLineDate: "2026-02-03", linesBefore: 2, chainBreaks: 0 });
  });

  it("a real missing line is still found (sorting must not hide it)", () => {
    const missing = csv(...DOMESTIC, "20/01/2026,SAAS INC,1000,,-1000").rows;   // 22/01 −500 left out
    const gaps = checkPreview(missing).gaps;
    expect(gaps).toHaveLength(1);
    expect(gaps[0].amount).toBe(500);   // positive = money OUT with no line in the preview
    const ob = openingBalanceFromStatement(missing, "2026-01-01");
    expect(ob.ok && ob.chainBreaks).toBe(1);
  });

  it("a reversal is judged against the line before it IN DATE ORDER, not in the file", () => {
    /* Date order: 20/01 −1000 → −1000; 21/01 ATM reversal printed 'debit −300' → −700; 03/02 +700 → 0. */
    const r = csv("21/01/2026,ATM REV,-300,,-700", "03/02/2026,CARD PAYMENT,,700,0", "20/01/2026,SAAS INC,1000,,-1000").rows;
    const rev = r.find((x) => x.description.startsWith("ATM REV")) as ParsedRow;
    expect(rev).toMatchObject({ debit: 0, credit: 300, reversal: true });
    expect(rev.checkSign).toBeUndefined();
    expect(settleReversals(r)).toEqual(r);   // settling again gives the same answer
  });
});
