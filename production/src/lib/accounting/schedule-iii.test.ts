/**
 * R-1855 — Schedule III view: mapping completeness, totals tie to the Balance Sheet, previous-period
 * column, the Unmapped line, CSV = view. The fixture runs the SAME functions the page runs
 * (balanceSheetTotals, loansAdvancesSplit, equitySection, unexplainedAfterEntries).
 */
import { describe, expect, it } from "vitest";
import type { BalanceSheetAuto, BalanceSheetItem } from "@/lib/queries/balance-sheet";
import { balanceSheetTotals } from "@/lib/accounting/balance-sheet-totals";
import { loansAdvancesSplit, loanSplitLines } from "@/lib/accounting/loans-current-split";
import { equitySection, registerShareCapital } from "@/lib/accounting/equity-section";
import { splitLoansTaken } from "@/lib/accounting/director-loans";
import { splitPrepaidAdvances } from "@/lib/accounting/employee-advance";
import {
  ACCOUNT_HEAD, AUTO_FIELD_KEYS, HEADS, MANUAL_RULES, UNMAPPED_LABEL, PREVIOUS_NA,
  buildScheduleIII, scheduleIIICsvRows, scheduleIIITie, type ScheduleIIIInput,
} from "./schedule-iii";

const AUTO: BalanceSheetAuto = {
  cashAndBank: 500_000, undepositedFunds: 20_000, receivables: 300_000, advancesFromCustomers: 40_000, projectReceivable: 60_000,
  tdsReceivable: 15_000, employeeLoans: 30_000, loansGiven: 200_000,
  loansCurrent: { loansGiven: 50_000, employeeLoans: 30_000, undecidedCount: 1, undecidedAmount: 20_000 },
  prepaidAdvances: 25_000, fixedAssets: 400_000, fixedAssetsCost: 450_000, accumulatedDepreciation: 50_000,
  payables: 180_000, salaryPayable: 70_000, salaryDuesPayable: 22_000, reimbursementsPayable: 5_000, creditCardPayable: 12_000,
  bankOverdraft: 90_000, emiLoansPayable: 110_000, businessLoansPayable: 300_000, gstPayable: 33_000, gstPaid: 10_000,
  advanceTaxPaid: 18_000, expensesPayable: 9_000, expensesPaidUnbanked: 4_000, salaryOtherDeductions: 2_000,
  commissionsPayable: 6_000, openingBalanceAdjustments: 75_000, fyLabel: "FY 2026-27",
};
const item = (id: string, section: BalanceSheetItem["section"], label: string, amount: number): BalanceSheetItem =>
  ({ id, section, label, amount, sort_order: 0, notes: null });
const ITEMS: BalanceSheetItem[] = [
  item("1", "asset", "Office furniture", 80_000),
  item("2", "asset", "Rent deposit", 25_000),
  item("3", "liability", "Loan from director", 150_000),
  item("4", "liability", "Mystery creditor", 7_000),
  item("5", "equity", "Equity share capital", 100_000),
  item("6", "equity", "Securities premium", 50_000),
];

function build(over: Partial<{ auto: BalanceSheetAuto; items: BalanceSheetItem[]; msme: number | null; profit: number }> = {}) {
  const auto = over.auto ?? AUTO, items = over.items ?? ITEMS;
  const t = balanceSheetTotals(auto, items, { licenceProvision: 8_000 });
  const equity = equitySection({
    businessType: "pvt_ltd", manualLines: items.filter((i) => i.section === "equity"), opening: null,
    profit: over.profit ?? 120_000, totals: { capitalIntroduced: 0, drawings: 0 } as never,
  });
  // the page's "Unexplained difference": what is left after the equity rows and Zoho adjustments
  const eqTotal = equity.groups.reduce((s, g) => s + g.rows.reduce((a, r) => a + (r.kind === "manual" ? r.items.reduce((x, y) => x + y.amount, 0) : r.amount), 0), 0);
  const unexplained = t.netWorth - eqTotal - (auto.openingBalanceAdjustments ?? 0);
  const input: ScheduleIIIInput = {
    auto, gstCredit: t.gstCredit, gstPayable: t.gstPayable, licenceProvision: 8_000,
    loanLines: loanSplitLines(loansAdvancesSplit(auto)),
    advanceSplit: splitPrepaidAdvances(auto.prepaidAdvances, []),
    loansTaken: splitLoansTaken(auto.businessLoansPayable, []),
    manualAssets: items.filter((i) => i.section === "asset"), manualLiabilities: items.filter((i) => i.section === "liability"),
    equity, openingBalanceAdjustments: auto.openingBalanceAdjustments ?? 0, unexplained,
    msmePayable: over.msme === undefined ? 60_000 : over.msme,
  };
  return { t, s: buildScheduleIII(input), input, equity };
}

describe("mapping table", () => {
  it("every account line maps to exactly one head that exists", () => {
    const ids = new Set(HEADS.map((h) => h.id));
    for (const [key, head] of Object.entries(ACCOUNT_HEAD)) expect(ids.has(head), `${key} -> ${head}`).toBe(true);
    expect(new Set(HEADS.map((h) => h.id)).size).toBe(HEADS.length);
  });

  it("every field of the report's auto figures is classified, and only to mapped account lines", () => {
    const fields = Object.keys(AUTO).concat(["loansGiven", "bankOverdraft", "commissionsPayable"]);
    for (const f of new Set(fields)) expect(f in AUTO_FIELD_KEYS, f).toBe(true);
    for (const [f, v] of Object.entries(AUTO_FIELD_KEYS)) {
      if (Array.isArray(v)) for (const k of v) expect(k in ACCOUNT_HEAD, `${f} -> ${k}`).toBe(true);
    }
  });

  it("manual rules point at mapped keys", () => {
    for (const r of MANUAL_RULES) expect(r.key in ACCOUNT_HEAD).toBe(true);
  });

  it("heads follow the statutory order and wording", () => {
    expect(HEADS.map((h) => h.label)).toEqual([
      "Share capital", "Reserves and surplus", "Money received against share warrants", "Share application money pending allotment",
      "Long-term borrowings", "Deferred tax liabilities (net)", "Other long-term liabilities", "Long-term provisions",
      "Short-term borrowings", expect.stringContaining("MSME"), expect.stringContaining("other than micro"),
      "Other current liabilities", "Short-term provisions",
      "Property, Plant and Equipment and Intangible assets", "Non-current investments", "Deferred tax assets (net)",
      "Long-term loans and advances", "Other non-current assets",
      "Current investments", "Inventories", "Trade receivables", "Cash and cash equivalents", "Short-term loans and advances", "Other current assets",
    ]);
  });
});

describe("totals tie to the Balance Sheet", () => {
  it("Equity & Liabilities = Total Assets = the Balance Sheet total", () => {
    const { t, s } = build();
    const tie = scheduleIIITie(s, t);
    expect(tie).toEqual({ ties: true, assetsDiff: 0, eqLiabDiff: 0 });
    expect(s.totalAssets).toBe(t.totalAssets);
    expect(s.totalEquityLiabilities).toBe(t.totalLiab + t.netWorth);
  });

  it("still ties when the P&L is negative, loans split is unknown and there is no MSME read", () => {
    const { t, s } = build({ auto: { ...AUTO, loansCurrent: null }, profit: -400_000, msme: null });
    expect(scheduleIIITie(s, t).ties).toBe(true);
  });

  it("says so when it does not tie (a line the table lost)", () => {
    const { t, s } = build();
    const broken = { ...s, totalAssets: s.totalAssets - 1_000 };
    expect(scheduleIIITie(broken, t)).toMatchObject({ ties: false, assetsDiff: -1_000 });
  });
});

describe("heads", () => {
  const amountOf = (s: ReturnType<typeof build>["s"], id: string) => s.rows.find((r) => r.kind === "head" && r.headId === id)?.amount;

  it("puts loans due within 12 months in current, the rest in long-term (the sheet's own split)", () => {
    const { s } = build();
    // 50k loans given + 30k staff current + 15k TDS + 18k advance tax + 25k advances + 0 ITC (GST is payable)
    expect(amountOf(s, "st_loans_advances")).toBe(50_000 + 30_000 + 15_000 + 18_000 + 25_000);
    expect(amountOf(s, "lt_loans_advances")).toBe(150_000);
  });

  it("splits trade payables into MSME and others, total unchanged", () => {
    const { s } = build();
    expect(amountOf(s, "trade_payables_msme")).toBe(60_000);
    expect(amountOf(s, "trade_payables_others")).toBe(120_000);
  });

  it("without an MSME read, everything is 'others'", () => {
    const { s } = build({ msme: null });
    expect(amountOf(s, "trade_payables_msme")).toBe(0);
    expect(amountOf(s, "trade_payables_others")).toBe(180_000);
  });

  it("share capital and reserves come from the equity section; heads with no source show zero, not missing", () => {
    const { s } = build();
    expect(amountOf(s, "share_capital")).toBe(100_000);
    expect(amountOf(s, "reserves_surplus")).toBeGreaterThan(50_000);
    for (const id of ["share_warrants", "share_application_money", "deferred_tax_liab", "inventories", "current_investments"]) expect(amountOf(s, id)).toBe(0);
  });

  it("cash = bank + undeposited − paid-unbanked; fixed assets + furniture under PPE", () => {
    const { s } = build();
    expect(amountOf(s, "cash")).toBe(500_000 + 20_000 - 4_000);
    expect(amountOf(s, "ppe_intangible")).toBe(400_000 + 80_000);
  });
});

describe("Unmapped line", () => {
  it("a hand-entered line the rules do not cover is shown visibly and still counted, never dropped", () => {
    const { s, t } = build();
    const un = s.rows.filter((r) => r.kind === "unmapped_head");
    expect(un.map((r) => r.label)).toEqual([UNMAPPED_LABEL, UNMAPPED_LABEL]);   // the asset deposit and the creditor
    expect(s.unmapped.map((l) => l.label).sort()).toEqual(["Mystery creditor (hand-entered)", "Rent deposit (hand-entered)"]);
    expect(scheduleIIITie(s, t).ties).toBe(true);
  });

  it("no unmapped rows when every line is classified", () => {
    const { s } = build({ items: ITEMS.filter((i) => !["2", "4"].includes(i.id)) });
    expect(s.rows.some((r) => r.kind === "unmapped_head")).toBe(false);
  });
});

describe("previous-period column", () => {
  it("exists on every row and is never invented (n/a until a dated sheet exists)", () => {
    const { s } = build();
    expect(s.rows.every((r) => r.previous === null)).toBe(true);
    const csv = scheduleIIICsvRows(s, "2026-11-17", null);
    expect(csv.filter((r) => r[3] === PREVIOUS_NA).length).toBe(s.rows.filter((r) => r.amount !== null).length);
  });
});

describe("CSV matches the view", () => {
  it("one CSV row per view row (plus 2 title rows), same amounts, with the head of every account line", () => {
    const { s } = build();
    const csv = scheduleIIICsvRows(s, "2026-11-17", "Acme Pvt Ltd");
    expect(csv.length).toBe(s.rows.length + 2);
    const body = csv.slice(2);
    s.rows.forEach((r, i) => {
      expect(body[i][2]).toBe(r.amount === null ? "" : r.amount);
      expect(String(body[i][0])).toContain(r.label);
    });
    const details = body.filter((_, i) => s.rows[i].kind === "detail");
    expect(details.length).toBeGreaterThan(10);
    for (const d of details) expect(String(d[4])).toMatch(/→ [a-z_]+$/);
    const total = body.find((_, i) => s.rows[i].label === "TOTAL ASSETS");
    expect(total?.[2]).toBe(s.totalAssets);
  });

  it("registerShareCapital import stays usable (shape guard)", () => {
    expect(typeof registerShareCapital).toBe("function");
  });
});
