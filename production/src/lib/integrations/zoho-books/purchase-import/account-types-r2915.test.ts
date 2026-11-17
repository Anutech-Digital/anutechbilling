/**
 * R-2915 — which Zoho accounts still need their type: the ones scanned document lines use and the
 * stored chart does not have. A document on an inactive account resolves once its type is stored; one
 * on an account nobody could read stays refused (fail closed). Values are made up.
 */
import { describe, it, expect } from "vitest";
import { accountTypeRefusal, accountTypeRows, missingAccountIds } from "./account-types";

const doc = (...ids: Array<string | null>) => ({ lines: ids.map((accountId) => ({ accountId, accountName: `Name ${accountId}` })) });

describe("R-2915 missingAccountIds", () => {
  it("lists each untyped account id once, sorted; typed, empty and too-long ids are left out", () => {
    const types = { A1: "expense", "A-FD": "other_current_asset" };
    const docs = [doc("A1", "Z9"), doc("B2", "Z9", ""), doc(" B2 "), doc("A-FD"), doc(null), { lines: null }, {}, doc("x".repeat(41))];
    expect(missingAccountIds(docs, types)).toEqual(["B2", "Z9"]);
    expect(missingAccountIds(docs, { ...types, B2: "expense", Z9: "expense" })).toEqual([]);
  });
});

describe("R-2915 a document matches Zoho's chart by account id", () => {
  const lines = [{ accountId: "old-pantry", accountName: "Pantry" }];

  it("a document on an INACTIVE account comes through once that account's type is stored", () => {
    const rows = accountTypeRows([
      { id: "A1", name: "Software", code: "", type: "expense", active: true },
      { id: "old-pantry", name: "Pantry (old)", code: "", type: "Expense", active: false },
    ]);
    const types = Object.fromEntries(rows.map((r) => [r.zoho_account_id, r.account_type]));
    expect(types["old-pantry"]).toBe("expense");
    /* by id — the name on the document ("Pantry") is not the chart's name ("Pantry (old)") */
    expect(accountTypeRefusal(lines, types)).toBeNull();
  });

  it("an inactive loan account is told as not an expense, not as 'not read yet'", () => {
    const types = { A1: "expense", "old-loan": "long_term_liability" };
    expect(accountTypeRefusal([{ accountId: "old-loan", accountName: "HDFC Bike Loan" }], types)).toMatch(/^Not an expense — needs another path: .*"HDFC Bike Loan".*long term liability/);
  });

  it("an account nobody could read stays refused (fail closed)", () => {
    expect(accountTypeRefusal(lines, { A1: "expense" })).toBe(`Zoho's account type for "Pantry" is not read yet — press Read from Zoho again, then preview again.`);
  });
});
