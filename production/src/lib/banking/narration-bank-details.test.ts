import { describe, it, expect } from "vitest";
import { bankDetailsFromNarration, newVendorFromNarration, tailMismatch } from "./narration-bank-details";

/* R-1918 — "＋ New vendor" on a money-out bank line starts from the narration. Lines are shaped like
 * HDFC's statement (NEFT DR / RTGS DR / IMPS / UPI / TPT), the same rails narration.ts reads. */
describe("bankDetailsFromNarration", () => {
  it("card example: NEFT DR with IFSC and a masked account tail", () => {
    expect(bankDetailsFromNarration("NEFT DR-HDFC0001234-SHARMA ASSOCIATES-…4521")).toEqual({
      name: "Sharma Associates", ifsc: "HDFC0001234", accountNo: null, accountTail: "4521", upi: null,
    });
    expect(bankDetailsFromNarration("NEFT DR-HDFC0001234-SHARMA ASSOCIATES-XXXX4521").accountTail).toBe("4521");
  });

  it("NEFT DR as HDFC writes it: IFSC + name, the UTR is never taken as an account", () => {
    expect(bankDetailsFromNarration("NEFT DR-BKID0006087-SHARMA ASSOCIATES-NETBANK, MUM-N298252345678901-INV 45")).toEqual({
      name: "Sharma Associates", ifsc: "BKID0006087", accountNo: null, accountTail: null, upi: null,
    });
  });

  it("RTGS DR: IFSC + name; the 22-character UTR is not an IFSC", () => {
    const d = bankDetailsFromNarration("RTGS DR-SBIN0004321-KAPOOR LEGAL ASSOCIATES-NETBANK, MUM-HDFCR52025102612345678-FEES");
    expect(d).toEqual({ name: "Kapoor Legal Associates", ifsc: "SBIN0004321", accountNo: null, accountTail: null, upi: null });
  });

  it("IMPS with a masked account: the tail, not the 12-digit reference", () => {
    expect(bankDetailsFromNarration("IMPS-529912345678-SHARMA ASSOCIATES-HDFC-XXXXXXXXXX4521-INVOICE 45")).toEqual({
      name: "Sharma Associates", ifsc: null, accountNo: null, accountTail: "4521", upi: null,
    });
  });

  it("IMPS with the full account in its slot", () => {
    expect(bankDetailsFromNarration("IMPS-529912345678-SHARMA ASSOCIATES-ICIC-000405123456-INV")).toEqual({
      name: "Sharma Associates", ifsc: null, accountNo: "000405123456", accountTail: null, upi: null,
    });
  });

  it("HDFC UPI: name, VPA and IFSC; the RRN is not an account", () => {
    expect(bankDetailsFromNarration("UPI-SHARMA ASSOCIATES-sharmaassoc@okhdfcbank-HDFC0001234-529912345678-PAYMENT")).toEqual({
      name: "Sharma Associates", ifsc: "HDFC0001234", accountNo: null, accountTail: null, upi: "sharmaassoc@okhdfcbank",
    });
  });

  it("UPI with slashes", () => {
    expect(bankDetailsFromNarration("UPI/529912345678/RAVI KUMAR/Ravi.Kumar@okaxis/Payment")).toEqual({
      name: "Ravi Kumar", ifsc: null, accountNo: null, accountTail: null, upi: "ravi.kumar@okaxis",
    });
  });

  it("TPT (HDFC to HDFC): the full account first, the name last", () => {
    expect(bankDetailsFromNarration("50100784857169-TPT-INVOICE 45-SHARMA ASSOCIATES")).toEqual({
      name: "Sharma Associates", ifsc: null, accountNo: "50100784857169", accountTail: null, upi: null,
    });
  });

  it("a gateway card payment gives only the merchant", () => {
    expect(bankDetailsFromNarration("KYQX244FAR4KPNGVCU/PAYUAMAZON")).toEqual({
      name: "Amazon", ifsc: null, accountNo: null, accountTail: null, upi: null,
    });
  });

  it.each(["", "NEFT DR-200161-SALARY APR EMP 5", "01026130346651/ESIC"])("%s → nothing guessed", (n) => {
    const d = bankDetailsFromNarration(n);
    expect(d.ifsc).toBeNull();
    expect(d.accountNo).toBeNull();
    expect(d.accountTail).toBeNull();
    expect(d.upi).toBeNull();
  });
});

describe("newVendorFromNarration — what the new-vendor form starts with", () => {
  it("pre-fills name, account, IFSC, UPI and says which came from the bank line", () => {
    const f = newVendorFromNarration("UPI-SHARMA ASSOCIATES-sharmaassoc@okhdfcbank-HDFC0001234-529912345678-PAYMENT");
    expect(f.name).toBe("Sharma Associates");
    expect(f.upi).toBe("sharmaassoc@okhdfcbank");
    expect(f.ifsc).toBe("HDFC0001234");
    expect(f.accountNo).toBe("");
    expect(f.fromLine).toEqual(["name", "ifsc", "upi"]);
  });

  it("full account from TPT goes in the account box", () => {
    const f = newVendorFromNarration("50100784857169-TPT-INVOICE 45-SHARMA ASSOCIATES");
    expect(f.accountNo).toBe("50100784857169");
    expect(f.fromLine).toEqual(["name", "accountNo"]);
  });

  it("only a tail: the box stays empty (a tail is not an account number) and the tail is kept for the hint", () => {
    const f = newVendorFromNarration("NEFT DR-HDFC0001234-SHARMA ASSOCIATES-…4521");
    expect(f.accountNo).toBe("");
    expect(f.accountTail).toBe("4521");
    expect(f.ifsc).toBe("HDFC0001234");
  });

  it("an empty narration gives an empty form", () => {
    expect(newVendorFromNarration(null)).toEqual({ name: "", accountNo: "", ifsc: "", upi: "", accountTail: null, fromLine: [] });
  });
});

describe("tailMismatch", () => {
  it("warns when the typed account does not end with the tail the bank line shows", () => {
    expect(tailMismatch("50100123459999", "4521")).toMatch(/ends with 4521/);
    expect(tailMismatch("5010 0123 4521", "4521")).toBeNull();
    expect(tailMismatch("", "4521")).toBeNull();
    expect(tailMismatch("50100123459999", null)).toBeNull();
  });
});
