// R-1905 — owner, 25 Oct 2026: adding the vendor with IFSC "IDFB002015" (10 characters)
// gave one vague toast "Bank details are not complete — check the account number, IFSC or
// UPI ID", and he thought the UPI ID was compulsory. Each field must say what is wrong with
// IT, and an empty UPI must never block Save.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  checkBankDetails, bankToast, ifscProblem, accountNoProblem, upiProblem,
} from "./bank-details";

describe("R-1905 — IFSC message names the real problem", () => {
  it("the owner's 10-character IFSC says it has 10 and needs 11, with the rule", () => {
    const m = ifscProblem("IDFB002015");
    expect(m).toContain("IFSC has 10 characters");
    expect(m).toContain("needs 11");
    expect(m).toContain("4 letters, 0, then 6 letters/digits");
    // Never guesses the vendor's real IFSC.
    expect(m).not.toContain("IDFB0");
  });

  it("an 11-character IFSC with a wrong 5th character says the 5th is always 0", () => {
    expect(ifscProblem("HDFC1001234")).toMatch(/5th character .* always 0/);
  });

  it("lower case and spaces around a valid IFSC are fine", () => {
    expect(ifscProblem(" hdfc0001234 ")).toBeNull();
  });
});

describe("R-1905 — the vendor bank block", () => {
  it("the owner's case: only the IFSC is wrong — the UPI ID is not blamed", () => {
    const c = checkBankDetails({ accountNo: "10012345678", ifsc: "IDFB002015", upi: "" });
    expect(c.first).toBe("ifsc");
    expect(Object.keys(c.errors)).toEqual(["ifsc"]);
    const t = bankToast(c)!;
    expect(t.title).toBe("Check the IFSC");
    expect(t.description).toContain("IFSC has 10 characters");
    expect(`${t.title} ${t.description}`).not.toMatch(/UPI/);
  });

  it("a valid IFSC + account number with an empty UPI ID can be saved", () => {
    const c = checkBankDetails({ accountNo: "10012345678", ifsc: "IDFB0020150", upi: "" });
    expect(c.first).toBeNull();
    expect(c.errors).toEqual({});
    expect(bankToast(c)).toBeNull();
  });

  it("a bad account number gets its own message on the account-number field", () => {
    const c = checkBankDetails({ accountNo: "12345", ifsc: "HDFC0001234", upi: "" });
    expect(c.first).toBe("accountNo");
    expect(c.errors.accountNo).toMatch(/5 digits — it needs 6 to 18/);
    expect(c.errors.ifsc).toBeUndefined();
    expect(accountNoProblem("50100ABC")).toMatch(/digits only/);
  });

  it("an account number without an IFSC asks for the IFSC (on the IFSC field)", () => {
    const c = checkBankDetails({ accountNo: "10012345678", ifsc: "", upi: "" });
    expect(c.first).toBe("ifsc");
    expect(c.errors.ifsc).toMatch(/Add the IFSC/);
  });

  it("an IFSC without an account number asks for the account number", () => {
    const c = checkBankDetails({ accountNo: "", ifsc: "HDFC0001234", upi: "" });
    expect(c.first).toBe("accountNo");
    expect(c.errors.accountNo).toMatch(/Add the account number/);
  });

  it("a typed but wrong UPI ID gets its own message; nothing typed is fine", () => {
    expect(upiProblem("")).toBeNull();
    const c = checkBankDetails({ accountNo: "", ifsc: "", upi: "name-at-bank" });
    expect(c.first).toBe("upi");
    expect(c.errors.upi).toMatch(/UPI ID looks wrong/);
    expect(checkBankDetails({ accountNo: "", ifsc: "", upi: "name@okhdfcbank" }).first).toBeNull();
  });

  it("everything empty is fine — bank details are optional", () => {
    expect(checkBankDetails({ accountNo: "", ifsc: "", upi: "" }).first).toBeNull();
  });
});

describe("R-1905 — the vendor form uses the shared check", () => {
  const page = readFileSync(
    path.resolve(__dirname, "../../app/(app)/accounting/vendors/page.tsx"), "utf8",
  );
  it("no longer shows the one vague toast for all three fields", () => {
    expect(page).not.toContain("Check the account number, IFSC or UPI ID");
    expect(page).toContain("checkBankDetails(");
    expect(page).toContain("bankToast(");
  });
  it("marks the UPI ID as optional", () => {
    expect(page).toMatch(/label="UPI ID \(optional/);
  });
});

describe("R-1905 — one IFSC message everywhere", () => {
  const read = (p: string) => readFileSync(path.resolve(__dirname, "../..", p), "utf8");
  it("Setup and Banking → Add account use the shared IFSC check, not their own regex", () => {
    for (const f of ["app/(app)/setup/payment-details.ts", "components/features/banking/add-bank-account-form.tsx"]) {
      const src = read(f);
      expect(src, f).toContain("ifscProblem");
      expect(src, f).not.toMatch(/\[A-Za-z\]\{4\}0|\[A-Z\]\{4\}0/);
    }
  });
});
