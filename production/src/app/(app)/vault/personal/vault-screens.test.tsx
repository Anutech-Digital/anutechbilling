// @vitest-environment jsdom
//
// Do the four vault screens actually render DATA, not just their empty and error states?
//
// ─── WHY THIS EXISTS RATHER THAN A SCREENSHOT ───────────────────────────────
// The vault could not be observed with real rows in the session that built it: the
// browser session had expired (a wall of 401s after the dev server changed port —
// Supabase keeps its session in localStorage, which is per-origin), and signing in was
// not something to do on somebody's behalf. The error state WAS browser-verified; the
// populated state was not.
//
// Feeding the screens known rows and asserting what reaches the DOM covers the same
// ground and keeps covering it. The arithmetic itself is already tested in
// lib/vault/personal/net-worth.test.ts — what is checked here is the wiring: that each
// screen asks for its data, hands it to the right calculation, and puts the answer on
// screen in whole rupees.
//
// THE ONE ASSERTION THAT MATTERS MOST is the credit card. It is stored as a POSITIVE
// balance and must land under "owed" and be SUBTRACTED from net worth. A sign error
// there turns ₹80,000 of debt into ₹80,000 of assets — a ₹1.6L swing, in the wrong
// direction, on the one number this whole feature exists to show.
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

/* ─── Query hooks, stubbed ────────────────────────────────────────────────── */
type Q<T> = { data: T; isLoading: boolean; error: unknown; refetch: () => void };
const q = <T,>(data: T): Q<T> => ({ data, isLoading: false, error: null, refetch: () => {} });

const state = {
  accounts: q<unknown[]>([]),
  holdings: q<unknown[]>([]),
  transactions: q<unknown[]>([]),
};

const noopMutation = { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false };

vi.mock("@/lib/queries/personal-vault", () => ({
  usePersonalAccounts: () => state.accounts,
  usePersonalHoldings: () => state.holdings,
  usePersonalTransactions: () => state.transactions,
  useSavePersonalAccount: () => noopMutation,
  useDeletePersonalAccount: () => noopMutation,
  useSavePersonalTransaction: () => noopMutation,
  useDeletePersonalTransaction: () => noopMutation,
  useSavePersonalHolding: () => noopMutation,
  useDeletePersonalHolding: () => noopMutation,
  usePinStatus: () => q<{ isSet: boolean }>({ isSet: false }),
  useSetPin: () => noopMutation,
  useRemovePin: () => noopMutation,
  useVerifyPin: () => noopMutation,
}));

vi.mock("@/components/providers/confirm-provider", () => ({
  useConfirm: () => vi.fn().mockResolvedValue(true),
}));

import Overview from "./page";
import Banking from "./banking/page";
import Expenses from "./expenses/page";
import Wealth from "./wealth/page";

/* ─── Fixtures. Whole rupees, as everywhere in this schema. ───────────────── */
const SAVINGS = { id: "a1", kind: "savings", label: "HDFC Salary", institution: "HDFC", account_last4: "4321", balance: 8_50_000, is_active: true };
const FD = { id: "a2", kind: "fd", label: "SBI FD", institution: "SBI", balance: 5_00_000, is_active: true, interest_rate: 7.1, maturity_date: "2027-04-01" };
const CARD = { id: "a3", kind: "credit_card", label: "ICICI Amazon Pay", institution: "ICICI", balance: 80_000, is_active: true, credit_limit: 3_00_000 };
const CLOSED = { id: "a4", kind: "savings", label: "Old Axis", balance: 99_00_000, is_active: false };

const MF = { id: "h1", asset_class: "mutual_fund", name: "Parag Parikh Flexi Cap", invested: 6_00_000, current_value: 9_20_000, valued_on: "2026-08-15" };
const PROPERTY = { id: "h2", asset_class: "real_estate", name: "Dwarka flat", invested: 45_00_000, current_value: 72_00_000, valued_on: "2026-08-01" };
const GOLD = { id: "h3", asset_class: "gold", name: "SGB 2019 tranche", invested: 1_50_000, current_value: 2_80_000, valued_on: null };

const DRAWING = { id: "t1", kind: "drawing", amount: 3_00_000, occurred_on: "2026-07-10", category: null, account_id: "a1" };
const DIVIDEND = { id: "t2", kind: "dividend", amount: 1_00_000, occurred_on: "2026-06-01", category: null, account_id: "a1" };
const GROCERIES = { id: "t3", kind: "expense", amount: 40_000, occurred_on: "2026-08-05", category: "Groceries", account_id: "a1" };
const SCHOOL = { id: "t4", kind: "expense", amount: 1_20_000, occurred_on: "2026-05-20", category: "Education / Fees", account_id: "a1" };

beforeEach(() => {
  // Fixed clock: 19 Aug 2026 IST. FY started 1 Apr 2026, so every fixture is in-year,
  // and the gold holding's null valuation is deterministically "never valued".
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date("2026-08-19T06:00:00Z"));
  state.accounts = q([]);
  state.holdings = q([]);
  state.transactions = q([]);
});

afterEach(() => { cleanup(); vi.useRealTimers(); });

/** All the money on screen, as plain digit strings — order preserved. */
function moneyOnScreen(): string[] {
  return Array.from(document.querySelectorAll("body *"))
    .map((n) => n.textContent ?? "")
    .filter((t) => t.startsWith("₹"))
    .map((t) => t.replace(/[^0-9]/g, ""));
}

function screenHasRupees(amount: number): boolean {
  return moneyOnScreen().includes(String(amount));
}

describe("Overview — net worth", () => {
  it("subtracts card debt instead of adding it", () => {
    state.accounts = q([SAVINGS, CARD]);
    render(<Overview />);
    // 8,50,000 - 80,000 = 7,70,000. Adding it would read 9,30,000.
    expect(screenHasRupees(7_70_000)).toBe(true);
    expect(screenHasRupees(9_30_000)).toBe(false);
  });

  it("adds investments to bank and deposits", () => {
    state.accounts = q([SAVINGS, FD]);
    state.holdings = q([MF]);
    render(<Overview />);
    // 8,50,000 + 5,00,000 + 9,20,000 = 22,70,000
    expect(screenHasRupees(22_70_000)).toBe(true);
  });

  it("leaves a closed account out of the total", () => {
    // ₹99,00,000 sitting in a closed account would dominate every figure on the page.
    state.accounts = q([SAVINGS, CLOSED]);
    render(<Overview />);
    expect(screenHasRupees(8_50_000)).toBe(true);
    expect(screenHasRupees(1_07_50_000)).toBe(false);
  });

  it("warns, on the same card as the total, when a valuation is stale", () => {
    state.holdings = q([GOLD]); // valued_on: null
    render(<Overview />);
    expect(screen.getByText(/of this figure is out of date/)).toBeDefined();
  });

  it("says nothing about staleness when every valuation is fresh", () => {
    state.holdings = q([MF, PROPERTY]);
    render(<Overview />);
    expect(screen.queryByText(/of this figure is out of date/)).toBeNull();
  });

  it("reports what was taken out of the company separately from other income", () => {
    state.accounts = q([SAVINGS]);
    state.transactions = q([DRAWING, DIVIDEND, GROCERIES]);
    render(<Overview />);
    expect(screen.getByText(/Taken from company/)).toBeDefined();
    expect(screenHasRupees(4_00_000)).toBe(true);   // drawing + dividend
  });

  it("offers a first step instead of a blank page", () => {
    render(<Overview />);
    expect(screen.getByText(/Your vault is empty/)).toBeDefined();
  });
});

describe("Banking", () => {
  it("splits what is held from what is owed", () => {
    state.accounts = q([SAVINGS, FD, CARD]);
    render(<Banking />);
    expect(screen.getByText(/Total balance/)).toBeDefined();
    expect(screen.getByText(/Owed on cards/)).toBeDefined();
    expect(screenHasRupees(13_50_000)).toBe(true);  // savings + FD, card excluded
    expect(screenHasRupees(80_000)).toBe(true);     // the card, on its own
  });

  it("lists each account by name", () => {
    state.accounts = q([SAVINGS, CARD]);
    render(<Banking />);
    expect(screen.getByText("HDFC Salary")).toBeDefined();
    expect(screen.getByText("ICICI Amazon Pay")).toBeDefined();
  });

  it("shows only the last four digits, never a full number", () => {
    state.accounts = q([SAVINGS]);
    render(<Banking />);
    expect(document.body.textContent).toContain("4321");
  });

  it("prompts for a first account when there are none", () => {
    render(<Banking />);
    expect(screen.getByText(/No accounts yet/)).toBeDefined();
  });
});

describe("Expenses & drawings", () => {
  beforeEach(() => {
    state.accounts = q([SAVINGS]);
    state.transactions = q([DRAWING, DIVIDEND, GROCERIES, SCHOOL]);
  });

  it("totals money in, money out, and what is left", () => {
    render(<Expenses />);
    expect(screenHasRupees(4_00_000)).toBe(true);   // in
    expect(screenHasRupees(1_60_000)).toBe(true);   // out
    expect(screenHasRupees(2_40_000)).toBe(true);   // net
  });

  it("ranks spending categories by amount, not by count", () => {
    render(<Expenses />);
    const cats = screen.getAllByText(/Groceries|Education \/ Fees/).map((n) => n.textContent);
    // The row carries a count suffix ("Education / Fees · 1"); the ORDER is the claim.
    // startsWith rather than a regex: the "/" in the label needs escaping, and an
    // escaped regex is the thing that keeps getting mangled on its way into this file.
    expect(cats[0]?.startsWith("Education / Fees")).toBe(true);   // ₹1,20,000 beats ₹40,000
  });

  it("does not bucket income under a spending category", () => {
    // A drawing has no category; listing it as "Uncategorised" spending would double
    // count it as both income and expenditure.
    render(<Expenses />);
    expect(screen.queryByText("Uncategorised")).toBeNull();
  });

  it("prompts for a first entry when empty", () => {
    state.transactions = q([]);
    render(<Expenses />);
    expect(screen.getByText(/No entries yet/)).toBeDefined();
  });
});

describe("Wealth", () => {
  beforeEach(() => { state.holdings = q([MF, PROPERTY, GOLD]); });

  it("shows today's value, what was put in, and the gain", () => {
    render(<Wealth />);
    expect(screenHasRupees(84_00_000)).toBe(true);   // current
    expect(screenHasRupees(52_50_000)).toBe(true);   // invested
    expect(screenHasRupees(31_50_000)).toBe(true);   // gain
  });

  it("names every asset class that was asked for", () => {
    render(<Wealth />);
    for (const label of ["Mutual funds", "Real estate", "Gold"]) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
  });

  it("lists each holding by name", () => {
    render(<Wealth />);
    expect(screen.getByText("Parag Parikh Flexi Cap")).toBeDefined();
    expect(screen.getByText("Dwarka flat")).toBeDefined();
  });

  it("prompts for a first investment when empty", () => {
    state.holdings = q([]);
    render(<Wealth />);
    expect(screen.getByText(/No investments yet/)).toBeDefined();
  });
});
