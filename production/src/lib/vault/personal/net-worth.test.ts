import { describe, it, expect } from "vitest";
import {
  computeNetWorth,
  summariseCashFlow,
  isLiabilityAccount,
  STALE_AFTER_DAYS,
  ACCOUNT_KINDS,
  ASSET_CLASSES,
  ACCOUNT_KIND_LABEL,
  ASSET_CLASS_LABEL,
  type PersonalAccountLike,
  type PersonalHoldingLike,
} from "./net-worth";

const NOW = new Date("2026-08-19T12:00:00Z");

const acct = (over: Partial<PersonalAccountLike> = {}): PersonalAccountLike => ({
  kind: "savings",
  balance: 100_000,
  is_active: true,
  ...over,
});

const hold = (over: Partial<PersonalHoldingLike> = {}): PersonalHoldingLike => ({
  asset_class: "mutual_fund",
  invested: 100_000,
  current_value: 120_000,
  valued_on: "2026-08-01",
  ...over,
});

describe("computeNetWorth — the sign convention", () => {
  it("subtracts a credit card balance instead of adding it", () => {
    // The single most expensive mistake this module can make: ₹80,000 of card debt
    // counted as ₹80,000 of assets is a ₹1.6L error in the wrong direction.
    const r = computeNetWorth(
      [acct({ kind: "savings", balance: 500_000 }), acct({ kind: "credit_card", balance: 80_000 })],
      [],
      NOW,
    );
    expect(r.liquidAssets).toBe(500_000);
    expect(r.liabilities).toBe(80_000);
    expect(r.net).toBe(420_000);
  });

  it("treats only the credit card as a liability", () => {
    expect(isLiabilityAccount("credit_card")).toBe(true);
    for (const k of ACCOUNT_KINDS.filter((x) => x !== "credit_card")) {
      expect(isLiabilityAccount(k), `${k} should be an asset`).toBe(false);
    }
  });

  it("lets net worth go negative rather than flooring it at zero", () => {
    // Somebody genuinely underwater should see that, not a reassuring ₹0.
    const r = computeNetWorth([acct({ kind: "credit_card", balance: 250_000 }), acct({ balance: 10_000 })], [], NOW);
    expect(r.net).toBe(-240_000);
  });
});

describe("computeNetWorth — what counts", () => {
  it("adds bank, cash, FD and PPF into liquid assets", () => {
    const r = computeNetWorth(
      [
        acct({ kind: "savings", balance: 200_000 }),
        acct({ kind: "cash", balance: 15_000 }),
        acct({ kind: "fd", balance: 500_000 }),
        acct({ kind: "ppf", balance: 300_000 }),
      ],
      [],
      NOW,
    );
    expect(r.liquidAssets).toBe(1_015_000);
  });

  it("ignores a closed account", () => {
    // Money in an account that no longer exists is not money.
    const r = computeNetWorth([acct({ balance: 100_000 }), acct({ balance: 900_000, is_active: false })], [], NOW);
    expect(r.liquidAssets).toBe(100_000);
  });

  it("counts an account with is_active undefined, so a partial row is not silently dropped", () => {
    const r = computeNetWorth([{ kind: "savings", balance: 50_000 }], [], NOW);
    expect(r.liquidAssets).toBe(50_000);
  });

  it("adds the portfolio at market value, not at cost", () => {
    const r = computeNetWorth([], [hold({ invested: 100_000, current_value: 175_000 })], NOW);
    expect(r.investments).toBe(175_000);
    expect(r.investedTotal).toBe(100_000);
    expect(r.portfolioGain).toBe(75_000);
    expect(r.portfolioGainPct).toBeCloseTo(75, 6);
  });

  it("combines everything into one net figure", () => {
    const r = computeNetWorth(
      [acct({ kind: "savings", balance: 400_000 }), acct({ kind: "credit_card", balance: 50_000 })],
      [hold({ current_value: 600_000 })],
      NOW,
    );
    expect(r.net).toBe(400_000 + 600_000 - 50_000);
  });

  it("returns zeros, not NaN, for an empty vault", () => {
    const r = computeNetWorth([], [], NOW);
    expect(r).toMatchObject({ liquidAssets: 0, investments: 0, liabilities: 0, net: 0, portfolioGain: 0 });
    expect(r.portfolioGainPct).toBeNull();
    expect(r.byClass).toEqual([]);
  });

  it("survives a non-numeric amount instead of poisoning the total with NaN", () => {
    const r = computeNetWorth(
      [{ kind: "savings", balance: Number.NaN }, acct({ balance: 1_000 })],
      [{ asset_class: "gold", invested: Number.POSITIVE_INFINITY, current_value: 5_000, valued_on: "2026-08-01" }],
      NOW,
    );
    expect(Number.isFinite(r.net)).toBe(true);
    expect(r.liquidAssets).toBe(1_000);
    expect(r.investments).toBe(5_000);
  });
});

describe("computeNetWorth — percentages against zero", () => {
  it("reports gain % as null when nothing was invested", () => {
    // A gift, an inherited holding, an ESOP at zero cost — dividing by zero here would
    // print Infinity% on a dashboard.
    const r = computeNetWorth([], [hold({ invested: 0, current_value: 50_000 })], NOW);
    expect(r.portfolioGainPct).toBeNull();
    expect(r.byClass[0].gainPct).toBeNull();
    expect(r.byClass[0].gain).toBe(50_000);
  });

  it("reports share % as null when the portfolio is worth nothing", () => {
    const r = computeNetWorth([], [hold({ invested: 10_000, current_value: 0 })], NOW);
    expect(r.byClass[0].sharePct).toBeNull();
  });

  it("shares add up to 100 across classes", () => {
    // Counts-must-add-up: a pie chart whose slices do not total 100 is read as data loss.
    const r = computeNetWorth(
      [],
      [
        hold({ asset_class: "mutual_fund", current_value: 500_000 }),
        hold({ asset_class: "stock", current_value: 300_000 }),
        hold({ asset_class: "gold", current_value: 200_000 }),
      ],
      NOW,
    );
    const total = r.byClass.reduce((s, c) => s + (c.sharePct ?? 0), 0);
    expect(total).toBeCloseTo(100, 6);
  });
});

describe("computeNetWorth — rollup by asset class", () => {
  it("merges several holdings of the same class", () => {
    const r = computeNetWorth(
      [],
      [
        hold({ asset_class: "mutual_fund", invested: 100_000, current_value: 130_000 }),
        hold({ asset_class: "mutual_fund", invested: 50_000, current_value: 55_000 }),
      ],
      NOW,
    );
    expect(r.byClass).toHaveLength(1);
    expect(r.byClass[0]).toMatchObject({ invested: 150_000, currentValue: 185_000, gain: 35_000, count: 2 });
  });

  it("sorts the biggest holding first, because that is the one a decision is about", () => {
    const r = computeNetWorth(
      [],
      [
        hold({ asset_class: "gold", current_value: 100_000 }),
        hold({ asset_class: "real_estate", current_value: 9_000_000 }),
        hold({ asset_class: "stock", current_value: 400_000 }),
      ],
      NOW,
    );
    expect(r.byClass.map((c) => c.assetClass)).toEqual(["real_estate", "stock", "gold"]);
  });

  it("gives every asset class a human label", () => {
    for (const c of ASSET_CLASSES) {
      expect(ASSET_CLASS_LABEL[c], `${c} has no label`).toBeTruthy();
    }
    for (const k of ACCOUNT_KINDS) {
      expect(ACCOUNT_KIND_LABEL[k], `${k} has no label`).toBeTruthy();
    }
  });

  it("shows a loss as a negative gain rather than hiding it", () => {
    const r = computeNetWorth([], [hold({ asset_class: "crypto", invested: 200_000, current_value: 80_000 })], NOW);
    expect(r.byClass[0].gain).toBe(-120_000);
    expect(r.byClass[0].gainPct).toBeCloseTo(-60, 6);
  });
});

describe("computeNetWorth — staleness is reported, not hidden", () => {
  it("counts a holding that was never valued", () => {
    const r = computeNetWorth([], [hold({ valued_on: null, current_value: 300_000 })], NOW);
    expect(r.neverValuedCount).toBe(1);
    expect(r.staleValue).toBe(300_000);
  });

  it("counts a valuation older than the threshold", () => {
    const old = new Date(NOW.getTime() - (STALE_AFTER_DAYS + 1) * 86_400_000).toISOString().slice(0, 10);
    const r = computeNetWorth([], [hold({ valued_on: old, current_value: 500_000 })], NOW);
    expect(r.staleCount).toBe(1);
    expect(r.staleValue).toBe(500_000);
  });

  it("does not flag a valuation inside the threshold", () => {
    const recent = new Date(NOW.getTime() - (STALE_AFTER_DAYS - 1) * 86_400_000).toISOString().slice(0, 10);
    const r = computeNetWorth([], [hold({ valued_on: recent })], NOW);
    expect(r.staleCount).toBe(0);
    expect(r.neverValuedCount).toBe(0);
    expect(r.staleValue).toBe(0);
  });

  it("treats an unparseable date as never valued, not as fresh", () => {
    // The conservative reading. Calling a broken date "today" is how a six-month-old
    // number ends up presented as current.
    const r = computeNetWorth([], [hold({ valued_on: "not-a-date", current_value: 111_000 })], NOW);
    expect(r.neverValuedCount).toBe(1);
    expect(r.staleValue).toBe(111_000);
  });

  it("keeps the stale value separate from the total, so the total is still shown", () => {
    const r = computeNetWorth([], [hold({ current_value: 100_000, valued_on: "2026-08-15" }), hold({ current_value: 400_000, valued_on: null })], NOW);
    expect(r.investments).toBe(500_000);
    expect(r.staleValue).toBe(400_000);
  });
});

describe("summariseCashFlow", () => {
  const tx = (over: Partial<Parameters<typeof summariseCashFlow>[0][number]> = {}) => ({
    kind: "expense" as const,
    amount: 5_000,
    occurred_on: "2026-08-10",
    ...over,
  });

  it("separates money taken out of the company from other personal income", () => {
    // The one figure with a counterpart in the company's books is the one an accountant
    // asks about at year end. Fusing it with salary and interest makes it unanswerable.
    const r = summariseCashFlow([
      tx({ kind: "drawing", amount: 200_000 }),
      tx({ kind: "dividend", amount: 100_000 }),
      tx({ kind: "salary", amount: 80_000 }),
      tx({ kind: "interest", amount: 5_000 }),
    ]);
    expect(r.moneyIn).toBe(385_000);
    expect(r.drawnFromCompany).toBe(300_000);
  });

  it("nets spending against income", () => {
    const r = summariseCashFlow([tx({ kind: "drawing", amount: 100_000 }), tx({ kind: "expense", amount: 30_000 })]);
    expect(r.moneyIn).toBe(100_000);
    expect(r.moneyOut).toBe(30_000);
    expect(r.net).toBe(70_000);
  });

  it("buckets spending by category, biggest first", () => {
    const r = summariseCashFlow([
      tx({ category: "Groceries", amount: 8_000 }),
      tx({ category: "Rent / EMI", amount: 45_000 }),
      tx({ category: "Groceries", amount: 7_000 }),
    ]);
    expect(r.byCategory[0]).toEqual({ category: "Rent / EMI", total: 45_000, count: 1 });
    expect(r.byCategory[1]).toEqual({ category: "Groceries", total: 15_000, count: 2 });
  });

  it("does not bucket income by category", () => {
    // Otherwise "Salary" appears in the same list as "Groceries" and the spending
    // breakdown stops meaning anything.
    const r = summariseCashFlow([tx({ kind: "salary", amount: 90_000, category: "Salary" })]);
    expect(r.byCategory).toEqual([]);
  });

  it("labels uncategorised spending rather than dropping it", () => {
    const r = summariseCashFlow([tx({ category: null, amount: 1_200 }), tx({ category: "   ", amount: 800 })]);
    expect(r.byCategory).toEqual([{ category: "Uncategorised", total: 2_000, count: 2 }]);
  });

  it("ignores a non-positive amount instead of subtracting it", () => {
    // The DB CHECK forbids these; this is the belt to that pair of braces.
    const r = summariseCashFlow([tx({ amount: 0 }), tx({ amount: -5_000 }), tx({ amount: 1_000 })]);
    expect(r.moneyOut).toBe(1_000);
  });

  it("returns zeros for an empty period", () => {
    expect(summariseCashFlow([])).toMatchObject({ moneyIn: 0, moneyOut: 0, net: 0, drawnFromCompany: 0, count: 0 });
  });
});

// R-2386 — Pardeep's case: ₹5 lakh byana for his daughter's property sale, kept as cash with
// his brother. The cash is an asset, the advance is owed — net worth must not grow by ₹5 lakh.
describe("computeNetWorth — money I owe / hold for others (R-2386)", () => {
  it("subtracts an open advance: cash ₹5 L held + ₹5 L advance = no gain", () => {
    const r = computeNetWorth(
      [{ kind: "cash", balance: 5_00_000 }, { kind: "savings", balance: 2_00_000 }, { kind: "credit_card", balance: 50_000 }],
      [],
      NOW,
      [{ amount: 5_00_000, status: "open" }],
    );
    expect(r.liquidAssets).toBe(7_00_000);
    expect(r.liabilities).toBe(50_000);
    expect(r.oweHoldOpen).toBe(5_00_000);
    expect(r.owedTotal).toBe(5_50_000);
    expect(r.net).toBe(1_50_000);
  });

  it("a settled entry no longer counts", () => {
    const r = computeNetWorth([{ kind: "cash", balance: 1_00_000 }], [], NOW, [
      { amount: 60_000, status: "settled" },
      { amount: 10_000, status: "open" },
    ]);
    expect(r.oweHoldOpen).toBe(10_000);
    expect(r.net).toBe(90_000);
  });

  it("no entries = the old figure (cards only)", () => {
    const r = computeNetWorth([{ kind: "savings", balance: 1_000 }, { kind: "credit_card", balance: 300 }], [], NOW);
    expect(r.oweHoldOpen).toBe(0);
    expect(r.net).toBe(700);
  });
});

