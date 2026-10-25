/* R-1853 — director loans: the s.185 reasons, the rough s.186 limit and the Balance Sheet split. */
import { describe, expect, it } from "vitest";

import {
  S185_BASES, s185Options, s185BasisAllowed, s186Estimate, splitLoansTaken, directorChoices,
  showsDirectorLoans, undeclaredDirectorLoans,
} from "./director-loans";

describe("showsDirectorLoans", () => {
  it("only a Pvt Ltd (or an empty type, which means Pvt Ltd) has director loans", () => {
    expect(showsDirectorLoans("pvt_ltd")).toBe(true);
    expect(showsDirectorLoans(null)).toBe(true);
    expect(showsDirectorLoans("proprietor")).toBe(false);
    expect(showsDirectorLoans("partnership")).toBe(false);
    expect(showsDirectorLoans("llp")).toBe(false);
  });
});

describe("s.185 reasons", () => {
  it("has exactly the three reasons the database accepts", () => {
    expect(S185_BASES).toEqual(["md_wtd_service", "md_wtd_scheme", "ca_confirmed"]);
  });

  it("the managing / whole-time director reasons need that designation (s.185(3)(a))", () => {
    expect(s185BasisAllowed("md_wtd_service", "managing_director")).toBe(true);
    expect(s185BasisAllowed("md_wtd_scheme", "whole_time_director")).toBe(true);
    expect(s185BasisAllowed("md_wtd_service", "director")).toBe(false);
    expect(s185BasisAllowed("md_wtd_scheme", "additional_director")).toBe(false);
    expect(s185BasisAllowed("ca_confirmed", "director")).toBe(true);
    expect(s185BasisAllowed("nope" as never, "managing_director")).toBe(false);
  });

  it("options say why an MD/WTD reason is closed for an ordinary director", () => {
    const opts = s185Options("director");
    expect(opts.map((o) => o.key)).toEqual(S185_BASES);
    const service = opts.find((o) => o.key === "md_wtd_service")!;
    expect(service.allowed).toBe(false);
    expect(service.why).toMatch(/managing or whole-time director/i);
    expect(opts.find((o) => o.key === "ca_confirmed")!.allowed).toBe(true);
    expect(s185Options("managing_director").every((o) => o.allowed)).toBe(true);
    for (const o of opts) expect(o.section).toMatch(/^s\.185|exemption/i);
  });
});

describe("s186Estimate", () => {
  it("is null without paid-up capital (share capital register empty)", () => {
    expect(s186Estimate({ paidUpCapital: null, loansOutstanding: 0, newLoan: 1000 })).toBeNull();
    expect(s186Estimate({ paidUpCapital: 0, loansOutstanding: 0, newLoan: 1000 })).toBeNull();
  });

  it("60% of paid-up capital, free reserves and premium not counted — whole rupees", () => {
    const e = s186Estimate({ paidUpCapital: 100_000, loansOutstanding: 20_000, newLoan: 30_000 })!;
    expect(e.limit).toBe(60_000);
    expect(e.total).toBe(50_000);
    expect(e.over).toBe(false);
  });

  it("flags the loan that takes the total above the rough limit", () => {
    const e = s186Estimate({ paidUpCapital: 100_000, loansOutstanding: 50_000, newLoan: 10_001 })!;
    expect(e.total).toBe(60_001);
    expect(e.over).toBe(true);
    expect(s186Estimate({ paidUpCapital: 100_000, loansOutstanding: 50_000, newLoan: 10_000 })!.over).toBe(false);
  });

  it("rounds a paise limit down (never shows more room than the Act gives)", () => {
    expect(s186Estimate({ paidUpCapital: 1_001, loansOutstanding: 0, newLoan: 1 })!.limit).toBe(600);
  });
});

describe("splitLoansTaken", () => {
  const loans = [
    { director_id: "d1", outstanding: 300_000 },
    { director_id: null, outstanding: 900_000 },
    { director_id: "d2", outstanding: 0 },
    { director_id: "d2", outstanding: 50_000 },
  ];

  it("splits the Balance Sheet total into directors and the rest — the two add back to the total", () => {
    const s = splitLoansTaken(1_250_000, loans);
    expect(s.fromDirectors).toBe(350_000);
    expect(s.others).toBe(900_000);
    expect(s.fromDirectors + s.others).toBe(1_250_000);
  });

  it("never shows a negative other-loans line, and an overpaid loan counts 0", () => {
    const s = splitLoansTaken(100_000, [{ director_id: "d1", outstanding: 150_000 }, { director_id: "d1", outstanding: -5 }]);
    expect(s.fromDirectors).toBe(100_000);
    expect(s.others).toBe(0);
  });

  it("no director loans — everything stays on the bank line", () => {
    expect(splitLoansTaken(500, [])).toEqual({ fromDirectors: 0, others: 500 });
  });
});

describe("undeclaredDirectorLoans", () => {
  it("counts open director loans with no declaration copy", () => {
    expect(undeclaredDirectorLoans([
      { director_id: "d1", director_declaration: false, outstanding: 10 },
      { director_id: "d1", director_declaration: true, outstanding: 10 },
      { director_id: "d2", director_declaration: false, outstanding: 0 },
      { director_id: null, director_declaration: null, outstanding: 10 },
    ])).toBe(1);
  });
});

describe("directorChoices", () => {
  const dirs = [
    { id: "a", name: "Asha", din: "01234567", designation: "managing_director" as const, ceased_on: null },
    { id: "b", name: "Bina", din: "07654321", designation: "director" as const, ceased_on: "2026-01-31" },
  ];
  it("lists only directors in office on the loan date, with designation and DIN", () => {
    expect(directorChoices(dirs, "2026-10-24")).toEqual([
      { id: "a", name: "Asha", label: "Asha · Managing Director · DIN 01234567", designation: "managing_director" },
    ]);
    expect(directorChoices(dirs, "2026-01-31").map((d) => d.id)).toEqual(["a", "b"]);
  });
});
