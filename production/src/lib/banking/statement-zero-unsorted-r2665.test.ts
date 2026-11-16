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

/**
 * Which way was the file printed? 11 Nov: the first rule let ONE reversed pair of running
 * balances turn a small oldest-first file round (R-2522's two FD redemptions lost their
 * out-of-order note). The dates decide first; the running balance only where the dates cannot
 * tell, and only with a clear majority (2+ links and more than twice the other way).
 */
describe("R-2665 file direction: dates first, one reversed pair never turns the file round", () => {
  const names = (rows: ParsedRow[]) => inDateOrder(rows).map((x) => x.description);

  it("R-2522: oldest-first file, one pair out of order inside a day — order kept, note stays", () => {
    const r = csv(
      "20/11/2025,SALARY IN,,1000,2000",
      "21/11/2025,FD TWO,,700,3000",    // printed first, happened second (2300 → 3000)
      "21/11/2025,FD ONE,,300,2300",    // printed second, happened first (2000 → 2300)
      "22/11/2025,ATM,100,,2900",
    ).rows;
    expect(names(r)).toEqual(["SALARY IN", "FD TWO", "FD ONE", "ATM"]);
    expect(openingBalanceFromStatement(r, "2025-11-20"))
      .toMatchObject({ ok: true, amount: 1000, chainBreaks: 0, outOfOrder: { days: ["2025-11-21"] } });
    expect(checkPreview(r).gaps).toEqual([]);
  });

  /* A card statement with a running balance, printed newest-first. In date order:
     20/01 −1000 → −1000, 22/01 −500 → −1500, 22/01 −100 → −1600, 03/02 +1600 → 0, 05/02 −200 → −200. */
  const SAAS = "20/01/2026,SAAS INC,1000,,-1000";
  const FEE = "22/01/2026,MARKUP FEE,500,,-1500";
  const FUEL = "22/01/2026,FUEL,100,,-1600";
  const PAY = "03/02/2026,CARD PAYMENT,,1600,0";
  const SHOP = "05/02/2026,SHOP,200,,-200";

  it("a newest-first card statement is turned round: right opening, no break, no note", () => {
    const r = csv(SHOP, PAY, FUEL, FEE, SAAS).rows;
    expect(names(r)).toEqual(["SAAS INC", "MARKUP FEE", "FUEL", "CARD PAYMENT", "SHOP"]);
    expect(openingBalanceFromStatement(r, "2026-01-01"))
      .toEqual({ ok: true, amount: 0, firstLineDate: "2026-01-20", linesBefore: 0, chainBreaks: 0 });
    expect(checkPreview(r).gaps).toEqual([]);
  });

  it("a newest-first file with one pair out of order inside a day is still newest-first", () => {
    const r = csv(SHOP, PAY, FEE, FUEL, SAAS).rows;   // FEE / FUEL swapped
    expect(names(r)).toEqual(["SAAS INC", "FUEL", "MARKUP FEE", "CARD PAYMENT", "SHOP"]);
    expect(openingBalanceFromStatement(r, "2026-01-01"))
      .toMatchObject({ ok: true, amount: 0, chainBreaks: 0, outOfOrder: { days: ["2026-01-22"] } });
  });

  it("days newest-first but the lines inside a day oldest-first: the day's own order is kept", () => {
    /* 01/02 +1000 → 1000 · 03/02 −100 → 900, −100 → 800, +50 → 850 · 05/02 −50 → 800, +200 → 1000, −300 → 700 */
    const r = csv(
      "05/02/2026,A1,50,,800", "05/02/2026,A2,,200,1000", "05/02/2026,A3,300,,700",
      "03/02/2026,B1,100,,900", "03/02/2026,B2,100,,800", "03/02/2026,B3,,50,850",
      "01/02/2026,C1,,1000,1000",
    ).rows;
    expect(names(r)).toEqual(["C1", "B1", "B2", "B3", "A1", "A2", "A3"]);
    expect(openingBalanceFromStatement(r, "2026-02-01"))
      .toEqual({ ok: true, amount: 0, firstLineDate: "2026-02-01", linesBefore: 0, chainBreaks: 0 });
  });

  /* One day only — the dates cannot tell. 1000: +100 → 1100, −50 → 1050, +200 → 1250, −25 → 1225. */
  const A = "07/03/2026,A,,100,1100";
  const B = "07/03/2026,B,50,,1050";
  const C = "07/03/2026,C,,200,1250";
  const D = "07/03/2026,D,25,,1225";
  const CLEAN = { ok: true, amount: 1000, firstLineDate: "2026-03-07", linesBefore: 0, chainBreaks: 0 };

  it("a one-day file printed oldest-first is kept", () => {
    const r = csv(A, B, C, D).rows;
    expect(names(r)).toEqual(["A", "B", "C", "D"]);
    expect(openingBalanceFromStatement(r, "2026-03-01")).toEqual(CLEAN);
  });

  it("a one-day file printed newest-first is turned round by its running balance", () => {
    const r = csv(D, C, B, A).rows;
    expect(names(r)).toEqual(["A", "B", "C", "D"]);
    expect(openingBalanceFromStatement(r, "2026-03-01")).toEqual(CLEAN);
    expect(checkPreview(r).gaps).toEqual([]);
  });

  it("a one-day oldest-first file with one pair swapped is not turned round (note, no break)", () => {
    const r = csv(A, C, B, D).rows;
    expect(names(r)).toEqual(["A", "C", "B", "D"]);
    expect(openingBalanceFromStatement(r, "2026-03-01"))
      .toMatchObject({ ok: true, amount: 1000, chainBreaks: 0, outOfOrder: { days: ["2026-03-07"] } });
    expect(checkPreview(r).gaps).toEqual([]);
  });

  it("a 2-line file: two dates go in date order; one day keeps the printed order (a lone pair proves nothing)", () => {
    expect(names(csv(SHOP, PAY).rows)).toEqual(["CARD PAYMENT", "SHOP"]);
    expect(openingBalanceFromStatement(csv(SHOP, PAY).rows, "2026-02-01"))
      .toEqual({ ok: true, amount: -1600, firstLineDate: "2026-02-03", linesBefore: 0, chainBreaks: 0 });
    expect(names(csv(A, B).rows)).toEqual(["A", "B"]);
    expect(openingBalanceFromStatement(csv(A, B).rows, "2026-03-01")).toEqual({ ...CLEAN });
    /* Printed the other way: kept as printed, flagged as out of order — never a missing-line break. */
    const ba = csv(B, A).rows;
    expect(names(ba)).toEqual(["B", "A"]);
    expect(openingBalanceFromStatement(ba, "2026-03-01"))
      .toMatchObject({ ok: true, chainBreaks: 0, outOfOrder: { days: ["2026-03-07"] } });
    expect(checkPreview(ba).gaps).toEqual([]);
  });
});
