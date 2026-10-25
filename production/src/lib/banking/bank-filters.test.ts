import { describe, it, expect } from "vitest";
import { formatDate } from "@/lib/utils";
import {
  DEFAULT_FILTERS,
  applyBankFilters,
  facetCounts,
  filterTotals,
  filtersFromQuery,
  filtersToQuery,
  datePreset,
  possibleDuplicateIds,
  matchGroupOf,
  bankLinesCsv,
  activeFilterChips,
  removeFilter,
  panelFilterCount,
  hasAnyFilter,
  type BankFilters,
  type FilterLine,
} from "./bank-filters";

let n = 0;
function line(p: Partial<FilterLine>): FilterLine {
  n += 1;
  return {
    id: p.id ?? `t${n}`,
    txn_date: p.txn_date ?? "2026-09-10",
    description: p.description ?? `LINE ${n}`,
    reference: p.reference ?? null,
    debit: p.debit ?? 0,
    credit: p.credit ?? 0,
    balance_after: p.balance_after ?? null,
    matched_to_type: p.matched_to_type ?? null,
  };
}
const f = (p: Partial<BankFilters>): BankFilters => ({ ...DEFAULT_FILTERS, ...p });
const ids = (rows: { id: string }[]) => rows.map((r) => r.id).sort();

/* A small account: Sep + Oct 2026, money in and out, some reconciled. */
const L = [
  line({ id: "sal-sep", txn_date: "2026-09-30", debit: 45000, matched_to_type: "salary", description: "NEFT SALARY SEP RAHUL" }),
  line({ id: "sal-sep2", txn_date: "2026-09-30", debit: 30000, matched_to_type: "split", description: "SALARIES SEP" }),
  line({ id: "rent-sep", txn_date: "2026-09-05", debit: 25000, matched_to_type: "expense", description: "RENT SEP" }),
  line({ id: "in-sep", txn_date: "2026-09-12", credit: 118000, matched_to_type: "payment", description: "NEFT ACME PVT LTD" }),
  line({ id: "in-sep-open", txn_date: "2026-09-20", credit: 5000, description: "UPI 9876 UNKNOWN" }),
  line({ id: "out-sep-open", txn_date: "2026-09-21", debit: 1200, description: "POS AMAZON" }),
  line({ id: "bill-oct", txn_date: "2026-10-02", debit: 59000, matched_to_type: "vendor_bill", description: "NEFT GOOGLE INDIA" }),
  line({ id: "draw-oct", txn_date: "2026-10-03", debit: 20000, matched_to_type: "owner_equity", description: "SELF TRANSFER" }),
  line({ id: "in-oct-open", txn_date: "2026-10-05", credit: 250000, description: "RTGS BIG CLIENT" }),
  line({ id: "out-oct-open", txn_date: "2026-10-06", debit: 2500, description: "IMPS TO VENDOR X" }),
];

describe("applyBankFilters — direction × status × date × amount × matched type", () => {
  it("defaults keep every line, newest first", () => {
    const rows = applyBankFilters(L, DEFAULT_FILTERS);
    expect(rows).toHaveLength(L.length);
    expect(rows[0].id).toBe("out-oct-open");
    expect(rows[rows.length - 1].id).toBe("rent-sep");
  });

  it("direction: Money in = credits, Money out = debits", () => {
    expect(ids(applyBankFilters(L, f({ dir: "in" })))).toEqual(["in-oct-open", "in-sep", "in-sep-open"]);
    expect(applyBankFilters(L, f({ dir: "out" })).every((t) => t.debit > 0)).toBe(true);
    expect(applyBankFilters(L, f({ dir: "out" }))).toHaveLength(7);
  });

  it("status: unmatched / reconciled", () => {
    expect(ids(applyBankFilters(L, f({ status: "unmatched" })))).toEqual(["in-oct-open", "in-sep-open", "out-oct-open", "out-sep-open"]);
    expect(applyBankFilters(L, f({ status: "matched" }))).toHaveLength(6);
  });

  it("Money out + Unmatched + September = only those lines", () => {
    const rows = applyBankFilters(L, f({ dir: "out", status: "unmatched", from: "2026-09-01", to: "2026-09-30" }));
    expect(ids(rows)).toEqual(["out-sep-open"]);
  });

  it("date range is inclusive on both ends", () => {
    expect(ids(applyBankFilters(L, f({ from: "2026-09-30", to: "2026-10-02" })))).toEqual(["bill-oct", "sal-sep", "sal-sep2"]);
    expect(applyBankFilters(L, f({ from: "2026-10-01" }))).toHaveLength(4);
    expect(applyBankFilters(L, f({ to: "2026-09-12" }))).toHaveLength(2);
  });

  it("amount: min / max inclusive, exact wins over the range", () => {
    expect(ids(applyBankFilters(L, f({ min: 25000, max: 45000 })))).toEqual(["rent-sep", "sal-sep", "sal-sep2"]);
    expect(ids(applyBankFilters(L, f({ min: 100000 })))).toEqual(["in-oct-open", "in-sep"]);
    expect(ids(applyBankFilters(L, f({ exact: 1200, min: 50000 })))).toEqual(["out-sep-open"]);
  });

  it("matched to: groups of matched types; any of several", () => {
    expect(ids(applyBankFilters(L, f({ types: ["salary"] })))).toEqual(["sal-sep", "sal-sep2"]);
    expect(ids(applyBankFilters(L, f({ types: ["vendor", "owner"] })))).toEqual(["bill-oct", "draw-oct"]);
    // a matched type only ever picks reconciled lines
    expect(applyBankFilters(L, f({ types: ["customer"], status: "unmatched" }))).toHaveLength(0);
  });

  it("how much salary went out in Sep", () => {
    const rows = applyBankFilters(L, f({ dir: "out", types: ["salary"], from: "2026-09-01", to: "2026-09-30" }));
    expect(filterTotals(rows)).toEqual({ count: 2, moneyIn: 0, moneyOut: 75000, net: -75000 });
  });

  it("search works together with the filters (description, reference, amount)", () => {
    expect(ids(applyBankFilters(L, f({ q: "neft" })))).toEqual(["bill-oct", "in-sep", "sal-sep"]);
    expect(ids(applyBankFilters(L, f({ q: "neft", dir: "in" })))).toEqual(["in-sep"]);
    expect(ids(applyBankFilters(L, f({ q: "59000" })))).toEqual(["bill-oct"]);
  });

  it("needs attention: sets from the page (no customer / no vendor / old one-off)", () => {
    const ctx = { sets: { no_customer: new Set(["in-sep-open"]), no_vendor: new Set(["out-oct-open", "out-sep-open"]) } };
    expect(ids(applyBankFilters(L, f({ need: "no_customer" }), ctx))).toEqual(["in-sep-open"]);
    expect(ids(applyBankFilters(L, f({ need: "no_vendor", from: "2026-10-01" }), ctx))).toEqual(["out-oct-open"]);
    // a set the page did not give = nothing, never everything
    expect(applyBankFilters(L, f({ need: "old_one_off" }), ctx)).toHaveLength(0);
  });

  it("needs attention: large amounts are ₹1,00,000 and up, either direction", () => {
    expect(ids(applyBankFilters(L, f({ need: "large" })))).toEqual(["in-oct-open", "in-sep"]);
  });

  it("statement file: only the lines of that import", () => {
    const ctx = { sets: {}, importLines: new Map([["batch:b1", new Set(["rent-sep", "in-sep"])]]) };
    expect(ids(applyBankFilters(L, f({ imp: "batch:b1" }), ctx))).toEqual(["in-sep", "rent-sep"]);
    expect(applyBankFilters(L, f({ imp: "batch:gone" }), ctx)).toHaveLength(0);
  });

  it("sort: oldest, amount high / low (ties by date then id — stable)", () => {
    expect(applyBankFilters(L, f({ sort: "oldest" }))[0].id).toBe("rent-sep");
    expect(applyBankFilters(L, f({ sort: "high" })).map((t) => t.id).slice(0, 2)).toEqual(["in-oct-open", "in-sep"]);
    expect(applyBankFilters(L, f({ sort: "low" }))[0].id).toBe("out-sep-open");
  });

  it("does not change the list it was given", () => {
    const copy = L.map((t) => t.id);
    applyBankFilters(L, f({ sort: "high" }));
    expect(L.map((t) => t.id)).toEqual(copy);
  });
});

describe("facetCounts — each tab / chip counts under the OTHER filters", () => {
  it("status counts follow the direction; direction counts follow the status", () => {
    const c = facetCounts(L, f({ dir: "in", status: "unmatched" }));
    expect(c.status).toEqual({ all: 3, unmatched: 2, matched: 1 });
    expect(c.dir).toEqual({ all: 4, in: 2, out: 2 });
  });
  it("with no filters the status counts are the account's", () => {
    expect(facetCounts(L, DEFAULT_FILTERS).status).toEqual({ all: 10, unmatched: 4, matched: 6 });
  });
  it("matched-type counts", () => {
    const c = facetCounts(L, DEFAULT_FILTERS);
    expect(c.types.salary).toBe(2);
    expect(c.types.vendor).toBe(1);
    expect(c.types.customer).toBe(1);
  });
});

describe("filterTotals", () => {
  it("N lines · In · Out · Net", () => {
    expect(filterTotals(L)).toEqual({ count: 10, moneyIn: 373000, moneyOut: 182700, net: 190300 });
  });
  it("empty list is all zero", () => {
    expect(filterTotals([])).toEqual({ count: 0, moneyIn: 0, moneyOut: 0, net: 0 });
  });
  it("whole rupees — paise do not leave a float tail", () => {
    const t = filterTotals([line({ credit: 0.1 }), line({ credit: 0.2 }), line({ debit: 0.3 })]);
    expect(t.moneyIn).toBe(0.3);
    expect(t.net).toBe(0);
  });
});

describe("URL round-trip", () => {
  it("defaults write an empty query", () => {
    expect(filtersToQuery(DEFAULT_FILTERS).toString()).toBe("");
  });
  it("every field survives the trip", () => {
    const all: BankFilters = {
      status: "unmatched", dir: "out", from: "2026-09-01", to: "2026-09-30", min: 1000, max: 50000,
      exact: 1200, types: ["salary", "vendor"], need: "no_vendor", imp: "batch:abc-1", sort: "high", q: "neft & co",
    };
    const qs = filtersToQuery(all).toString();
    expect(qs).toContain("dir=out");
    expect(qs).toContain("status=unmatched");
    expect(filtersFromQuery(new URLSearchParams(qs))).toEqual(all);
  });
  it("junk in a shared link falls back to the default, never throws", () => {
    const got = filtersFromQuery(new URLSearchParams("dir=sideways&status=x&from=31-09-2026&min=abc&types=salary,bogus&need=nope&sort=up"));
    expect(got).toEqual({ ...DEFAULT_FILTERS, types: ["salary"] });
  });
  it("keeps unrelated params (focus, match) out of the filters", () => {
    expect(filtersFromQuery(new URLSearchParams("focus=abc&match=500"))).toEqual(DEFAULT_FILTERS);
  });
});

describe("datePreset (IST calendar, Indian FY)", () => {
  it("this month / last month / this FY", () => {
    expect(datePreset("this_month", "2026-10-24")).toEqual({ from: "2026-10-01", to: "2026-10-31" });
    expect(datePreset("last_month", "2026-10-24")).toEqual({ from: "2026-09-01", to: "2026-09-30" });
    expect(datePreset("last_month", "2026-01-15")).toEqual({ from: "2025-12-01", to: "2025-12-31" });
    expect(datePreset("this_fy", "2026-10-24")).toEqual({ from: "2026-04-01", to: "2027-03-31" });
    expect(datePreset("this_fy", "2026-02-10")).toEqual({ from: "2025-04-01", to: "2026-03-31" });
  });
  it("February in a leap year", () => {
    expect(datePreset("this_month", "2028-02-03")).toEqual({ from: "2028-02-01", to: "2028-02-29" });
  });
});

describe("possibleDuplicateIds", () => {
  it("same date + amount + same running balance = duplicate", () => {
    const a = line({ txn_date: "2026-09-01", debit: 500, balance_after: 9500, description: "UPI A" });
    const b = line({ txn_date: "2026-09-01", debit: 500, balance_after: 9500, description: "UPI-A (read from PDF)" });
    expect([...possibleDuplicateIds([a, b])].sort()).toEqual([a.id, b.id].sort());
  });
  it("two real ₹500 payments on one day differ in running balance — not duplicates", () => {
    const a = line({ txn_date: "2026-09-01", debit: 500, balance_after: 9500, description: "UPI RAZORPAY SOFTWARE PRIVATE" });
    const b = line({ txn_date: "2026-09-01", debit: 500, balance_after: 9000, description: "UPI RAZORPAY SOFTWARE PRIVATE" });
    expect(possibleDuplicateIds([a, b]).size).toBe(0);
  });
  it("no balance: same date + amount + narration prefix = duplicate", () => {
    const a = line({ txn_date: "2026-09-02", credit: 1000, description: "NEFT-123456 ACME" });
    const b = line({ txn_date: "2026-09-02", credit: 1000, description: "NEFT-123456  ACME" });
    const c = line({ txn_date: "2026-09-02", credit: 1000, description: "IMPS-999 OTHER" });
    expect([...possibleDuplicateIds([a, b, c])].sort()).toEqual([a.id, b.id].sort());
  });
  it("is a needs-attention filter", () => {
    const a = line({ id: "d1", txn_date: "2026-09-01", debit: 500, balance_after: 1 });
    const b = line({ id: "d2", txn_date: "2026-09-01", debit: 500, balance_after: 1 });
    expect(ids(applyBankFilters([...L, a, b], f({ need: "duplicates" })))).toEqual(["d1", "d2"]);
  });
});

describe("matchGroupOf", () => {
  it("maps every matched type the DB allows, new ones fall to Other", () => {
    expect(matchGroupOf(null)).toBeNull();
    expect(matchGroupOf("payment")).toBe("customer");
    expect(matchGroupOf("project")).toBe("customer");
    expect(matchGroupOf("vendor_bill")).toBe("vendor");
    expect(matchGroupOf("vendor_payment")).toBe("vendor");
    expect(matchGroupOf("salary")).toBe("salary");
    expect(matchGroupOf("split")).toBe("salary");
    expect(matchGroupOf("expense")).toBe("expense");
    expect(matchGroupOf("prepaid")).toBe("expense");
    expect(matchGroupOf("statutory")).toBe("tax");
    expect(matchGroupOf("owner_equity")).toBe("owner");
    expect(matchGroupOf("loan_emi")).toBe("loan");
    expect(matchGroupOf("transfer")).toBe("transfer");
    expect(matchGroupOf("manual")).toBe("other");
    expect(matchGroupOf("referral_commission")).toBe("other");
    expect(matchGroupOf("something_new")).toBe("other");
  });
});

describe("bankLinesCsv — the file is exactly the filtered rows", () => {
  it("one CSV row per filtered line, same order, raw whole-rupee amounts", () => {
    const rows = applyBankFilters(L, f({ dir: "out", status: "unmatched" }));
    const csv = bankLinesCsv(rows);
    expect(csv.headers).toEqual(["Date", "Description", "Reference", "Money out", "Money in", "Status", "Balance after"]);
    expect(csv.rows).toHaveLength(rows.length);
    expect(csv.rows.map((r) => r[1])).toEqual(rows.map((t) => t.description));
    expect(csv.rows[0]).toEqual(["2026-10-06", "IMPS TO VENDOR X", "", 2500, "", "Unmatched", ""]);
  });
  it("a reconciled line says what it matched", () => {
    const csv = bankLinesCsv(applyBankFilters(L, f({ types: ["salary"] })));
    expect(csv.rows.map((r) => r[5])).toEqual(["Salary", "Salary"]);
  });
});

describe("active chips, remove one, clear all", () => {
  const labels = { importLabel: (k: string) => (k === "batch:b1" ? "hdfc-sep.pdf" : null) };
  it("one chip per active filter, in plain words", () => {
    const chips = activeFilterChips(f({ dir: "out", status: "unmatched", from: "2026-09-01", to: "2026-09-30", min: 1000, types: ["salary"], need: "large", imp: "batch:b1", q: "neft" }), labels);
    expect(chips.map((c) => c.label)).toEqual([
      "Unmatched", "Money out", `${formatDate("2026-09-01")} – ${formatDate("2026-09-30")}`, "₹1,000 and up", "Matched to: Salary", "Large amounts (≥ ₹1,00,000)", "File: hdfc-sep.pdf", "Search: neft",
    ]);
  });
  it("removing a chip clears only that filter", () => {
    const start = f({ dir: "out", from: "2026-09-01", to: "2026-09-30", types: ["salary", "vendor"] });
    expect(removeFilter(start, "date")).toEqual(f({ dir: "out", types: ["salary", "vendor"] }));
    expect(removeFilter(start, "dir")).toEqual(f({ from: "2026-09-01", to: "2026-09-30", types: ["salary", "vendor"] }));
    expect(removeFilter(start, "type:salary")).toEqual(f({ dir: "out", from: "2026-09-01", to: "2026-09-30", types: ["vendor"] }));
  });
  it("Filters button count = filters inside the panel; sort is not a filter", () => {
    expect(panelFilterCount(f({ dir: "out", status: "unmatched", sort: "high" }))).toBe(0);
    expect(panelFilterCount(f({ from: "2026-09-01", min: 1, max: 2, types: ["salary", "vendor"], need: "large", imp: "x" }))).toBe(5);
    expect(hasAnyFilter(f({ sort: "high" }))).toBe(false);
    expect(hasAnyFilter(f({ q: " x " }))).toBe(true);
  });
  it("amount chip wording", () => {
    const chip = (p: Partial<BankFilters>) => activeFilterChips(f(p), labels)[0].label;
    expect(chip({ min: 1000, max: 5000 })).toBe("₹1,000 – ₹5,000");
    expect(chip({ max: 5000 })).toBe("Up to ₹5,000");
    expect(chip({ exact: 1200 })).toBe("Exactly ₹1,200");
    expect(chip({ from: "2026-09-01" })).toBe(`From ${formatDate("2026-09-01")}`);
  });
});
