/**
 * R-2657 — No-vendor sheet grouped by payee: the group key (narration key / bank GST / line alone),
 * the "Always book like this" rule text, one pick per group that never overwrites a row's own
 * edit, "Tick group" that never ticks ₹1,00,000+, and the bank-GST default (Bank Charges, GST ₹0).
 * Narrations are real HDFC 4523 shapes from the 10 Nov G-RECON plan.
 */
import { describe, it, expect } from "vitest";
import { applyGroupCategory, BANK_GST_KEY, groupKeyOf, payeeGroups, rulePatternFor, tickGroupIds } from "./bulk-expense-groups";
import { bulkRows, expenseSuggestion, isSafeRuleKey, ruleUnsafeLine, wholeWordMatch } from "./bulk-expense";
import { categoriseByRules, type CategoryRule } from "./categorise";

const kw = () => null;
let n = 0;
const line = (description: string, debit = 500, txn_date = "2026-05-20") => ({
  id: `t${++n}`, description, debit, credit: 0, category: null, txn_date,
});

const SHANTI_1 = "UPI-SHANTI DEVI-8447723287@YBL-PUNB0520810-272996278600-FOR EXPENSES";
const SHANTI_2 = "UPI-SHANTI DEVI-8447723287@YBL-PUNB0520810-341865132234-EXP";
const DPO_C = "300326I049903313 DPO2608902104710 CGST";
const DPO_S = "300326I049903313 DPO2608902104710 SGST";
const AMAZON_1 = "K4THK4EIBNZ27PGUCM/PAYUAMAZON";
const AMAZON_2 = "K4THK4EOAB62HOWTD4/PAYUAMAZON";

describe("groupKeyOf", () => {
  it("two UPI payments to the same person are one group", () => {
    expect(groupKeyOf({ id: "a", description: SHANTI_1 })).toBe(groupKeyOf({ id: "b", description: SHANTI_2 }));
    expect(groupKeyOf({ id: "a", description: SHANTI_1 })).toBe("payee:shanti devi");
  });
  it("bank GST CGST and SGST lines are one group", () => {
    expect(groupKeyOf({ id: "a", description: DPO_C })).toBe(BANK_GST_KEY);
    expect(groupKeyOf({ id: "b", description: DPO_S })).toBe(BANK_GST_KEY);
  });
  it("a gateway tail groups card payments to one merchant", () => {
    expect(groupKeyOf({ id: "a", description: AMAZON_1 })).toBe(groupKeyOf({ id: "b", description: AMAZON_2 }));
  });
  it("a line with no stable payee is a group of its own (never merged)", () => {
    expect(groupKeyOf({ id: "a", description: "" })).toBe("line:a");
    expect(groupKeyOf({ id: "b", description: "" })).toBe("line:b");
  });
});

describe("bank GST default (D1: no input GST claimed)", () => {
  it("DPO … CGST is Bank Charges, high, and says no GST is claimed", () => {
    const s = expenseSuggestion(line(DPO_C, 122), [], kw);
    expect(s).toMatchObject({ category: "Bank Charges", confidence: "high" });
    expect(s?.reason).toMatch(/no GST claimed/);
  });
  it("the company's own Category Rule still wins", () => {
    const rule = { id: "r1", pattern: "DPO", category: "Rates & Taxes", direction: "debit" } as CategoryRule;
    expect(categoriseByRules(line(DPO_S, 122), [rule])).not.toBeNull();
    expect(expenseSuggestion(line(DPO_S, 122), [rule], kw)).toMatchObject({ category: "Rates & Taxes" });
  });
  it("a narration that only mentions CGST without the DPO reference is not the bank GST default", () => {
    expect(expenseSuggestion(line("NEFT DR-SOMEONE-CGST PAYMENT"), [], kw)).toBeNull();
  });
});

describe("rulePatternFor", () => {
  it("the payee text, upper case, when it is in every line of the group", () => {
    expect(rulePatternFor("payee:shanti devi", [{ description: SHANTI_1 }, { description: SHANTI_2 }])).toBe("SHANTI DEVI");
  });
  it("no rule when a line of the group does not contain it", () => {
    expect(rulePatternFor("payee:shanti devi", [{ description: SHANTI_1 }, { description: "UPI-SHANTI-123@YBL" }])).toBeNull();
  });
  it("no rule for short keys, rail words, single lines with no key, or the bank-GST group", () => {
    expect(rulePatternFor("payee:abc", [{ description: "UPI-ABC-1@YBL" }])).toBeNull();
    expect(rulePatternFor("payee:upi", [{ description: "UPI-UPI-1" }])).toBeNull();
    expect(rulePatternFor("line:x", [{ description: "anything" }])).toBeNull();
    expect(rulePatternFor(BANK_GST_KEY, [{ description: DPO_C }])).toBeNull();
  });
  it("a saved rule catches the next line of the same payee", () => {
    const pattern = rulePatternFor("payee:shanti devi", [{ description: SHANTI_1 }])!;
    const rule = { id: "r9", pattern, category: "Staff Welfare", direction: "debit" } as CategoryRule;
    expect(expenseSuggestion(line(SHANTI_2), [rule], kw)).toMatchObject({ category: "Staff Welfare", confidence: "high" });
  });
});

describe("payeeGroups", () => {
  const rows = bulkRows([line(SHANTI_1, 7000), line(DPO_C, 122), line(SHANTI_2, 1500), line(DPO_S, 122), line(AMAZON_1, 4344)], [], kw);
  const groups = payeeGroups(rows);

  it("biggest groups first, with count, total and range", () => {
    expect(groups.map((g) => g.rows.length)).toEqual([2, 2, 1]);
    const shanti = groups.find((g) => g.key === "payee:shanti devi")!;
    expect(shanti).toMatchObject({ total: 8500, min: 1500, max: 7000, label: "Shanti Devi", rulePattern: "SHANTI DEVI" });
  });
  it("the bank-GST group carries its one suggested category", () => {
    const g = groups.find((x) => x.key === BANK_GST_KEY)!;
    expect(g).toMatchObject({ category: "Bank Charges", total: 244, rulePattern: null });
  });
  it("every offered row is in exactly one group", () => {
    expect(groups.flatMap((g) => g.rows.map((r) => r.id)).sort()).toEqual(rows.map((r) => r.id).sort());
  });
  it("challan / loan / salary lines never reach a group", () => {
    const rs = bulkRows([line("ITNS 281 TDS CHALLAN"), line("EMI LOAN 1234"), line("SALARY ADVANCE RAM")], [], kw);
    expect(payeeGroups(rs)).toEqual([]);
  });
});

describe("applyGroupCategory / tickGroupIds", () => {
  const rows = bulkRows([line(SHANTI_1, 7000), line(SHANTI_2, 150_000), line("UPI-SHANTI DEVI-1@YBL-X", 900)], [], kw);
  const [g] = payeeGroups(rows);

  it("one pick fills every row of the group", () => {
    const e = applyGroupCategory(g, "Staff Welfare", {});
    expect(rows.map((r) => e[r.id]?.category)).toEqual(["Staff Welfare", "Staff Welfare", "Staff Welfare"]);
  });
  it("a row the owner changed on its own keeps its own category", () => {
    const e = applyGroupCategory(g, "Staff Welfare", { [rows[2].id]: { category: "Travel", byRow: true } });
    expect(e[rows[2].id].category).toBe("Travel");
    expect(e[rows[0].id].category).toBe("Staff Welfare");
  });
  it("Tick group never ticks a line of ₹1,00,000 or more", () => {
    expect(tickGroupIds(g)).toEqual([rows[0].id, rows[2].id]);
  });
});

/* Independent review 11 Nov (note 2): "Always book like this" must not match too broadly. */
describe("R-2657 rule breadth — a payee rule counts only as whole words of a full payee name", () => {
  const rule = (pattern: string, category = "Staff Welfare") => ({ id: `r-${pattern}`, pattern, category, direction: "debit" }) as CategoryRule;
  const RAVINDRA = "NEFT DR-HDFC0000001-RAVINDRA STEELS-NETBANK";
  const RAVI_KUMAR = "IMPS-621856395591-RAVI KUMAR-ICIC-XXXXXX4658-PAYMENT";
  const RAVI_SHARMA = "UPI-RAVI SHARMA-ravi@okaxis-HDFC0000089-544244313572-EXP";

  it("isSafeRuleKey: 2+ real words, or one word of 6+ letters; never rail / bank / generic words", () => {
    expect(isSafeRuleKey("SHANTI DEVI")).toBe(true);
    expect(isSafeRuleKey("PAYUAMAZON")).toBe(true);
    expect(isSafeRuleKey("FACEBK")).toBe(true);
    expect(isSafeRuleKey("RAVI")).toBe(false);
    expect(isSafeRuleKey("ARORA")).toBe(false);
    expect(isSafeRuleKey("UPI PAYMENT")).toBe(false);
    expect(isSafeRuleKey("HDFC BANK")).toBe(false);
    expect(isSafeRuleKey("TRANSFER")).toBe(false);
    expect(isSafeRuleKey("RAVI UPI")).toBe(false);
    expect(isSafeRuleKey("ZQXR2611")).toBe(true);
    expect(isSafeRuleKey("50100784857169")).toBe(false);
    expect(isSafeRuleKey("AB 12")).toBe(false);
  });
  it("wholeWordMatch: the text must stand as whole word(s) in the narration", () => {
    expect(wholeWordMatch(RAVI_KUMAR, "RAVI KUMAR")).toBe(true);
    expect(wholeWordMatch(RAVINDRA, "RAVI")).toBe(false);
    expect(wholeWordMatch("NEFT DR-X-RAVI KUMARAN-NETBANK", "RAVI KUMAR")).toBe(false);
    expect(wholeWordMatch(AMAZON_1, "PAYUAMAZON")).toBe(true);
    expect(wholeWordMatch("DHDF23P1QTMPV7/BILLDKPLAYSTOREGOOGL", "GOOGL")).toBe(false);
  });
  it("a 4–5 letter single word is not saved", () => {
    expect(rulePatternFor("payee:ravi", [{ description: "UPI-RAVI-ravi@okaxis-HDFC0000089-1-EXP" }])).toBeNull();
    expect(rulePatternFor("payee:arora", [{ description: "UPI-ARORA-arora@ybl-HDFC0000089-1-EXP" }])).toBeNull();
  });
  it("a rail / bank / generic key is not saved", () => {
    expect(rulePatternFor("payee:hdfc bank", [{ description: "NEFT DR-X-HDFC BANK-NETBANK" }])).toBeNull();
    expect(rulePatternFor("payee:payment transfer", [{ description: "PAYMENT TRANSFER 123" }])).toBeNull();
  });
  it("an ATM, own-account transfer, salary, challan or loan line never gets a rule", () => {
    expect(rulePatternFor("payee:connaught place", [{ description: "ATW-416021XXXXXX1234-S1ANDE12-CONNAUGHT PLACE" }])).toBeNull();
    expect(rulePatternFor("payee:cash withdrawal", [{ description: "NWD-CASH WITHDRAWAL-NEW DELHI" }])).toBeNull();
    expect(rulePatternFor("payee:auto sweep", [{ description: "AUTO SWEEP TO FD 50300123" }])).toBeNull();
    expect(rulePatternFor("payee:ramesh kumar", [{ description: "IMPS-1-RAMESH KUMAR-ICIC-XX-SALARY" }])).toBeNull();
    expect(rulePatternFor("payee:bajaj finance", [{ description: "ACH D- BAJAJ FINANCE-EMI 123" }])).toBeNull();
    expect(ruleUnsafeLine("ATM WDL 1234 NEW DELHI")).toBe(true);
    expect(ruleUnsafeLine("TRF TO OWN ACCOUNT 5010")).toBe(true);
    expect(ruleUnsafeLine(SHANTI_1)).toBe(false);
  });
  it("rule RAVI never ticks RAVINDRA STEELS or RAVI KUMAR: the category shows, medium, not ticked, payee from the narration", () => {
    const rows = bulkRows([line(RAVINDRA, 80_000), line(RAVI_KUMAR, 25_000)], [rule("RAVI")], kw);
    expect(rows.map((r) => r.autoTick)).toEqual([false, false]);
    expect(rows.map((r) => r.confidence)).toEqual(["medium", "medium"]);
    expect(rows[0].reason).toMatch(/check/i);
    expect(rows[0].payee).toMatch(/ravindra steels/i);
  });
  it("the valid longer key RAVI SHARMA does not touch RAVI KUMAR or RAVINDRA STEELS at all", () => {
    const rows = bulkRows([line(RAVINDRA, 80_000), line(RAVI_KUMAR, 25_000)], [rule("RAVI SHARMA")], kw);
    expect(rows.map((r) => r.category)).toEqual(["", ""]);
    expect(rows.map((r) => r.autoTick)).toEqual([false, false]);
  });
  it("an existing valid rule still ticks its own payee (high)", () => {
    const rows = bulkRows([line(RAVI_SHARMA, 900), line(SHANTI_2, 1500), line(AMAZON_2, 4344)],
      [rule("RAVI SHARMA"), rule("SHANTI DEVI"), rule("PAYUAMAZON", "Office Supplies")], kw);
    expect(rows.map((r) => [r.category, r.confidence, r.autoTick])).toEqual([
      ["Staff Welfare", "high", true], ["Staff Welfare", "high", true], ["Office Supplies", "high", true],
    ]);
  });
  it("a valid whole-word rule wins over a longer loose one", () => {
    const rows = bulkRows([line("NEFT DR-X-SHANTI DEVI-NETBANK SHANTIDEVIXYZ", 700)], [rule("SHANTI DEVI"), rule("SHANTIDEVIX", "Travel")], kw);
    expect(rows[0]).toMatchObject({ category: "Staff Welfare", confidence: "high" });
  });
  it("a rule is never applied to an ATM / own-transfer line", () => {
    const rows = bulkRows([line("ATW-416021XXXXXX1234-S1ANDE12-CONNAUGHT PLACE", 5000)], [rule("CONNAUGHT PLACE", "Travel")], kw);
    expect(rows[0]).toMatchObject({ category: "", confidence: null, autoTick: false });
  });
});
