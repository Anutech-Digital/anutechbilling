/**
 * R-2394 — the account page's pure part. Owner's example (3 Nov): "Demo Savings ₹25,000" —
 * a savings account opened at ₹50,000, one month of statement lines, an EMI and a LIC premium
 * already typed elsewhere.
 */
import { describe, expect, it } from "vitest";
import {
  actionsFor,
  buildLedger,
  checkAgainstStatement,
  compareTx,
  dbKindFor,
  filterLedger,
  ALL_LINES,
  ledgerMonths,
  ledgerTotals,
  matchCandidates,
  matchStatus,
  ruleTextFrom,
  statementCheckText,
  suggestedAction,
  toCategoryRules,
  transferCandidates,
  txSign,
  type LedgerTx,
} from "./bank-ledger";

let n = 0;
const tx = (p: Partial<LedgerTx>): LedgerTx => ({
  id: `t${++n}`, account_id: "sav", kind: "expense", amount: 100, occurred_on: "2026-04-01",
  created_at: "2026-11-03T01:00:00Z", category: null, note: null, party: null, income_source: null,
  source: "import", raw_description: null, reference: null, balance_after: null, dedupe_hash: `h${n}`,
  reconciled_at: null, line_no: null, pair_tx_id: null, owe_hold_id: null, ...p,
});

const SAV = { kind: "savings", opening_balance: 50000 };

describe("direction", () => {
  it("money in kinds are +1, the rest −1; card_payment is IN only on a credit card", () => {
    expect(txSign("salary", "savings")).toBe(1);
    expect(txSign("transfer_in", "savings")).toBe(1);
    expect(txSign("expense", "savings")).toBe(-1);
    expect(txSign("atm_cash", "savings")).toBe(-1);
    expect(txSign("card_payment", "savings")).toBe(-1);
    expect(txSign("card_payment", "credit_card")).toBe(1);
  });
});

describe("running balance", () => {
  const lines = [
    tx({ kind: "salary", amount: 85000, occurred_on: "2026-04-01", line_no: 1, balance_after: 135000 }),
    tx({ kind: "expense", amount: 450, occurred_on: "2026-04-02", line_no: 2, balance_after: 134550 }),
    // two lines of one statement on one date keep the file order whatever their ids
    tx({ id: "zz", kind: "expense", amount: 10000, occurred_on: "2026-04-05", line_no: 3, balance_after: 124550 }),
    tx({ id: "aa", kind: "expense", amount: 17356, occurred_on: "2026-04-05", line_no: 4, balance_after: 107194 }),
  ];

  it("ends on opening + in − out, oldest first, file order within a date", () => {
    const rows = buildLedger(SAV, lines);
    expect(rows.map((r) => r.running)).toEqual([135000, 134550, 124550, 107194]);
    expect(rows[2].tx.id).toBe("zz");
    expect(ledgerTotals(SAV, rows)).toEqual({ moneyIn: 85000, moneyOut: 27806, unmatched: 4, balance: 107194 });
  });

  it("a credit card's running figure is the amount OWED", () => {
    const rows = buildLedger({ kind: "credit_card", opening_balance: 12000 }, [
      tx({ kind: "expense", amount: 3000, occurred_on: "2026-04-02" }),
      tx({ kind: "card_payment", amount: 12000, occurred_on: "2026-04-03" }),
    ]);
    expect(rows.map((r) => r.running)).toEqual([15000, 3000]);
  });

  it("no lines → the opening balance", () => {
    expect(ledgerTotals(SAV, buildLedger(SAV, [])).balance).toBe(50000);
  });

  it("an entry typed later but dated earlier sorts by date", () => {
    const a = tx({ occurred_on: "2026-04-02", created_at: "2026-11-01T00:00:00Z" });
    const b = tx({ occurred_on: "2026-04-01", created_at: "2026-11-02T00:00:00Z", source: "manual", dedupe_hash: null });
    expect([a, b].sort(compareTx)[0]).toBe(b);
  });
});

describe("statement check (like a BRS)", () => {
  it("matches when our balance at the last statement line equals the bank's", () => {
    const rows = buildLedger(SAV, [
      tx({ kind: "salary", amount: 85000, line_no: 1, balance_after: 135000 }),
      tx({ kind: "expense", amount: 450, occurred_on: "2026-04-02", line_no: 2, balance_after: 134550 }),
    ]);
    const c = checkAgainstStatement(rows)!;
    expect(c).toMatchObject({ statementBalance: 134550, appBalance: 134550, difference: 0, matches: true });
    expect(statementCheckText(c)).toBe("Matches the statement.");
  });

  it("an entry typed twice (EMI on Loans + the same EMI on the statement, not matched) shows as more here", () => {
    const rows = buildLedger(SAV, [
      tx({ source: "manual", dedupe_hash: null, kind: "expense", amount: 5000, occurred_on: "2026-04-01" }),
      tx({ kind: "expense", amount: 5000, occurred_on: "2026-04-02", line_no: 1, balance_after: 45000 }),
    ]);
    const c = checkAgainstStatement(rows)!;
    expect(c.difference).toBe(-5000);
    expect(c.matches).toBe(false);
    expect(statementCheckText(c)).toMatch(/₹5,000 less here/);
  });

  it("nothing imported with a balance → null (say nothing)", () => {
    expect(checkAgainstStatement(buildLedger(SAV, [tx({ source: "manual", dedupe_hash: null })]))).toBeNull();
  });

  it("lines dated after the last statement line are counted as later", () => {
    const rows = buildLedger(SAV, [
      tx({ kind: "expense", amount: 1000, line_no: 1, balance_after: 49000 }),
      tx({ source: "manual", dedupe_hash: null, kind: "expense", amount: 200, occurred_on: "2026-04-20" }),
    ]);
    expect(checkAgainstStatement(rows)).toMatchObject({ matches: true, laterLines: 1 });
  });
});

describe("filters and search", () => {
  const rows = buildLedger(SAV, [
    tx({ kind: "salary", amount: 85000, occurred_on: "2026-04-01", raw_description: "SALARY APR ACME", reconciled_at: "x" }),
    tx({ kind: "expense", amount: 1450, occurred_on: "2026-05-02", raw_description: "UPI-SWIGGY-ORDER" }),
    tx({ kind: "expense", amount: 300, occurred_on: "2026-05-03", source: "manual", dedupe_hash: null, note: "Tea" }),
  ]);

  it("unmatched / matched / typed", () => {
    expect(filterLedger(rows, { ...ALL_LINES, status: "unmatched" }).map((r) => r.tx.amount)).toEqual([1450]);
    expect(filterLedger(rows, { ...ALL_LINES, status: "matched" }).map((r) => r.tx.amount)).toEqual([85000]);
    expect(filterLedger(rows, { ...ALL_LINES, status: "entry" }).map((r) => r.tx.amount)).toEqual([300]);
  });
  it("money in / out, month, search by text or amount (with ₹ and commas)", () => {
    expect(filterLedger(rows, { ...ALL_LINES, direction: "in" })).toHaveLength(1);
    expect(filterLedger(rows, { ...ALL_LINES, direction: "out" })).toHaveLength(2);
    expect(filterLedger(rows, { ...ALL_LINES, month: "2026-05" })).toHaveLength(2);
    expect(filterLedger(rows, { ...ALL_LINES, query: "swiggy" })).toHaveLength(1);
    expect(filterLedger(rows, { ...ALL_LINES, query: "₹1,450" })).toHaveLength(1);
    expect(ledgerMonths(rows)).toEqual(["2026-05", "2026-04"]);
  });
  it("status of a line", () => {
    expect(matchStatus({ source: "manual", reconciled_at: null })).toBe("entry");
    expect(matchStatus({ source: "import", reconciled_at: null })).toBe("unmatched");
    expect(matchStatus({ source: "import", reconciled_at: "2026-11-03" })).toBe("matched");
  });
});

describe("what a line can be", () => {
  it("money out of a bank: expense, card payment, ATM, transfer, loan, byana, already entered", () => {
    expect(actionsFor(-1, "savings")).toEqual(["expense", "card_payment", "atm_cash", "transfer", "loan", "owe_hold", "match"]);
    expect(actionsFor(1, "savings")).toEqual(["income", "drawing", "transfer", "loan", "owe_hold", "match"]);
    expect(actionsFor(1, "credit_card")).toContain("card_payment");
  });
  it("the sheet starts on the importer's guess when it is allowed", () => {
    expect(suggestedAction({ kind: "atm_cash" }, -1, "savings")).toBe("atm_cash");
    expect(suggestedAction({ kind: "salary" }, 1, "savings")).toBe("income");
    expect(suggestedAction({ kind: "transfer_out" }, -1, "credit_card")).toBe("expense");
  });

  it("already entered: same amount, same way, this account or none, within 10 days, nearest first", () => {
    const line = tx({ kind: "expense", amount: 17356, occurred_on: "2026-04-05" });
    const emi = tx({ id: "emi", source: "manual", dedupe_hash: null, kind: "transfer_out", amount: 17356, occurred_on: "2026-04-04" });
    const far = tx({ id: "far", source: "manual", dedupe_hash: null, kind: "expense", amount: 17356, occurred_on: "2026-03-01" });
    const cash = tx({ id: "cash", source: "manual", dedupe_hash: null, kind: "expense", amount: 17356, occurred_on: "2026-04-10", account_id: null });
    const wrongWay = tx({ id: "in", source: "manual", dedupe_hash: null, kind: "salary", amount: 17356, occurred_on: "2026-04-05" });
    const other = tx({ id: "oth", source: "manual", dedupe_hash: null, kind: "expense", amount: 17356, occurred_on: "2026-04-05", account_id: "cur" });
    const imported = tx({ id: "imp", kind: "expense", amount: 17356, occurred_on: "2026-04-05" });
    expect(matchCandidates(line, "savings", [far, cash, wrongWay, other, imported, emi]).map((c) => c.id)).toEqual(["emi", "cash"]);
  });

  it("transfer pair: the other account's line the other way, same amount, not yet paired", () => {
    const line = tx({ kind: "transfer_out", amount: 10000, occurred_on: "2026-04-05" });
    const good = tx({ id: "in", account_id: "cur", kind: "transfer_in", amount: 10000, occurred_on: "2026-04-06" });
    const paired = tx({ id: "p", account_id: "cur", kind: "transfer_in", amount: 10000, occurred_on: "2026-04-05", pair_tx_id: "x" });
    const sameWay = tx({ id: "s", account_id: "cur", kind: "expense", amount: 10000, occurred_on: "2026-04-05" });
    expect(transferCandidates(line, -1, "current", [paired, sameWay, good]).map((c) => c.id)).toEqual(["in"]);
  });
});

describe("import mapping and rules", () => {
  it("income lines get a real DB kind; ATM cash becomes atm_cash", () => {
    expect(dbKindFor({ kind: "income", category: "Salary", reason: null })).toEqual({ kind: "salary", category: "Salary" });
    expect(dbKindFor({ kind: "income", category: null, reason: null })).toEqual({ kind: "other_income", category: null });
    expect(dbKindFor({ kind: "transfer_out", category: null, reason: "ATM cash" })).toEqual({ kind: "atm_cash", category: null });
    expect(dbKindFor({ kind: "card_payment", category: null, reason: "card payment" }).kind).toBe("card_payment");
  });
  it("a personal rule fires on one side only: income categories on money in, the rest on money out", () => {
    const rules = toCategoryRules([
      { id: "1", match_text: "SWIGGY", category: "Food / Dining" },
      { id: "2", match_text: "ACME", category: "Salary" },
    ]);
    expect(rules.map((r) => r.direction)).toEqual(["debit", "credit"]);
  });
  it("rule text offered from the narration skips rails and codes", () => {
    expect(ruleTextFrom("UPI-SWIGGY-SWIGGY@ICICI-ICIC0000001-610012345678-ORDER")).toBe("SWIGGY");
    expect(ruleTextFrom("NEFT CR HDFC0000001 ACME SOFTWARE")).toBe("ACME");
    expect(ruleTextFrom(null)).toBe("");
  });
});
