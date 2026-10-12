import { describe, it, expect } from "vitest";
import { proposePatterns, patternMatchesLine } from "./rule-from-line";
import { categoriseByRules, type CategoryRule } from "./categorise";

/* Every string below is a REAL narration, read out of bank_transactions on 22 Aug 2026.
   Invented ones would have been tidier and would have hidden the two things that actually
   make this hard: a unique reference on every line, and a purpose segment the bank rewrites
   every month. */
const REAL = {
  salaryJuly:   "50100784857169-TPT-JULY SALARY-PAWAN",
  salaryApr:    "50100784857169-TPT-SALARY APR 2026-PAWAN",
  salaryEmpJun: "50100784857172-TPT-SALARY EMPLOYEE JUNE-RANJEET RAJ",
  salaryFinal:  "50100508749370-TPT-FULL N FINAL SALARY-KESHAV MALIK",
  playStore:    "DHDF23P1QTMPV7/BILLDKPLAYSTOREGOOGL",
  facebook:     "K4UHU5ENAJ52FPOTCU/PAYUFACEBOOK",
  esic:         "01026130346651/ESIC",
  software:     "50200008254523-TPT-ACCOUNTING SOFTWARE-DEMO CO",
  impsDarshan:  "IMPS-518912349366-DARSHAN KUMAR-HDFC-XXXXXXXXXX5456-ANUTECH",
  impsNeetu:    "IMPS-518916843797-NEETU  -SBIN-XXXXXXX1014-REQPAY",
  noDelimiter:  "CU1906914097ANUTECH DIGITAL PVT LTD",
  loanGiven:    "50100691932684-TPT-LOAN GIVEN-JULIE RAWAT",
};

describe("what it offers to remember", () => {
  it("never proposes anything carrying a digit", () => {
    /* The single most important rule. Every narration here has a unique reference, and a
       pattern containing one matches that one line and then never again — a rule that
       looks saved and is silently dead. Checked across the whole corpus, not one example. */
    for (const [name, narration] of Object.entries(REAL)) {
      for (const p of proposePatterns(narration)) {
        expect(/\d/.test(p), `${name} proposed "${p}" which contains a digit`).toBe(false);
      }
    }
  });

  it("offers the single word that actually repeats", () => {
    /* SALARY is in all 15 salary lines; not one of the SEGMENTS repeats. If candidates were
       segment-only, the operator would save "JULY SALARY" and it would stop matching in
       August — the failure nobody reports because nothing errors. */
    expect(proposePatterns(REAL.salaryJuly)).toContain("SALARY");
    expect(proposePatterns(REAL.salaryApr)).toContain("SALARY");
    expect(proposePatterns(REAL.salaryEmpJun)).toContain("SALARY");
    expect(proposePatterns(REAL.salaryFinal)).toContain("SALARY");
  });

  it("drops the month, which would rot the rule", () => {
    /* JULY is a perfectly good-looking token. A rule on it stops matching in August and
       then mislabels next July. */
    const p = proposePatterns(REAL.salaryJuly);
    expect(p).not.toContain("JULY");
    expect(proposePatterns(REAL.salaryEmpJun)).not.toContain("JUNE");
  });

  it("drops rails, banks and masking noise", () => {
    const p = proposePatterns(REAL.impsDarshan);
    for (const junk of ["IMPS", "HDFC", "TPT", "DR", "NETBANK", "MUM"]) {
      expect(p).not.toContain(junk);
    }
  });

  it("keeps the merchant token out of a machine-generated narration", () => {
    /* The reference half is high-entropy noise; the payee half is the whole answer. */
    expect(proposePatterns(REAL.playStore)).toContain("BILLDKPLAYSTOREGOOGL");
    expect(proposePatterns(REAL.facebook)).toContain("PAYUFACEBOOK");
    expect(proposePatterns(REAL.esic)).toContain("ESIC");
  });

  it("offers both the purpose and the person, without choosing between them", () => {
    /* Which one is right is a bookkeeping decision — all wages, or this person's payments.
       Ranking them would dress a guess up as an answer, so both are offered. */
    const p = proposePatterns(REAL.software);
    expect(p).toContain("ACCOUNTING SOFTWARE");
    expect(p).toContain("DEMO CO");
  });

  it("trims the stray spaces a bank leaves behind", () => {
    /* Real line: "IMPS-518916843797-NEETU  -SBIN-..." — two trailing spaces. An untrimmed
       pattern would be stored with them and match nothing. */
    const p = proposePatterns(REAL.impsNeetu);
    expect(p).toContain("NEETU");
    expect(p.every((x) => x === x.trim())).toBe(true);
  });

  it("salvages the clean words when a reference is glued to the first one", () => {
    /* "CU1906914097ANUTECH DIGITAL PVT LTD" has no delimiter at all, so the token carrying
       the reference — CU1906914097ANUTECH — is dropped and the name is left partly eaten.
       What survives is DIGITAL: broad, and probably not what anyone wants, but a real
       token the operator can see and decline. PVT and LTD fall below the length floor.

       I first asserted this returned an empty list, and the code disagreed. The code was
       right — offering a weak candidate the operator can ignore beats offering nothing on a
       line where something IS extractable. Corrected the expectation rather than bending
       the extractor to match a claim in a comment. */
    expect(proposePatterns(REAL.noDelimiter)).toEqual(["DIGITAL"]);
  });

  it("returns nothing for an empty or missing narration", () => {
    expect(proposePatterns("")).toEqual([]);
    expect(proposePatterns(null)).toEqual([]);
    expect(proposePatterns("   ")).toEqual([]);
  });

  it("caps how many it offers", () => {
    /* A dozen buttons is not a choice, it is a shrug. */
    expect(proposePatterns(REAL.impsDarshan, 3).length).toBeLessThanOrEqual(3);
  });
});

describe("a pattern must match the line it came from", () => {
  it("accepts every proposal it just made", () => {
    /* Self-consistency across the corpus: if a proposal cannot match its own example, the
       extraction mangled it. */
    for (const [name, narration] of Object.entries(REAL)) {
      for (const p of proposePatterns(narration)) {
        expect(patternMatchesLine(p, narration), `${name}: "${p}" does not match its own line`).toBe(true);
      }
    }
  });

  it("rejects a typo, case-insensitively and whitespace-tolerantly", () => {
    expect(patternMatchesLine("SALRY", REAL.salaryJuly)).toBe(false);
    expect(patternMatchesLine("  salary  ", REAL.salaryJuly)).toBe(true);
    expect(patternMatchesLine("", REAL.salaryJuly)).toBe(false);
  });
});

describe("the plan's actual done-when: a correction generalises", () => {
  it("a rule learned from JULY's line categorises APRIL's line", () => {
    /* This is the test the plan asked for — not that a rule row exists, but that the next
       similar line is handled deterministically and never reaches a model.

       Operator corrects the July salary line to "Salaries". The pattern they would pick is
       SALARY. That rule must then cover a DIFFERENT month, a DIFFERENT employee and a
       DIFFERENT wording, because that is what the bank will actually send. */
    const learned = proposePatterns(REAL.salaryJuly).find((p) => p === "SALARY");
    expect(learned).toBe("SALARY");

    const rule: CategoryRule = {
      id: "learned-1", pattern: learned!, category: "Salaries", direction: "debit",
    };
    const debit = (description: string) => ({ description, debit: 25000, credit: 0 });

    for (const narration of [REAL.salaryApr, REAL.salaryEmpJun, REAL.salaryFinal]) {
      expect(categoriseByRules(debit(narration), [rule])?.category, narration).toBe("Salaries");
    }
    /* And it must NOT spill onto an unrelated line. */
    expect(categoriseByRules(debit(REAL.facebook), [rule])).toBeNull();
  });

  it("a learned rule still respects direction — a refunded loan is not the same event", () => {
    /* Real pair on this account: "LOAN GIVEN-JULIE RAWAT" and "LOAN REFUNDED-JULIE RAWAT",
       the same person and the same account, one out and one in. A rule learned on the
       outgoing side must not claim the incoming one. */
    const learned = proposePatterns(REAL.loanGiven).find((p) => p === "LOAN");
    expect(learned).toBe("LOAN");
    const rule: CategoryRule = {
      id: "learned-2", pattern: "LOAN", category: "Other", direction: "debit",
    };
    expect(categoriseByRules({ description: REAL.loanGiven, debit: 5000, credit: 0 }, [rule])?.category).toBe("Other");
    expect(categoriseByRules({ description: "50100691932684-TPT-LOAN REFUNDED-JULIE RAWAT", debit: 0, credit: 5000 }, [rule])).toBeNull();
  });
});
