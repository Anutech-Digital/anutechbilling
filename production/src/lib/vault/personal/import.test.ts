/**
 * R-2126 (GP-11) — the pure personal statement-import library.
 *
 * Fixtures are synthetic but shaped like the real exports: an HDFC savings-account CSV (long
 * preamble, "Withdrawal Amt." / "Deposit Amt." / "Closing Balance") and an SBI savings-account
 * .xlsx ("Txn Date" / "Description" / "Debit" / "Credit" / "Balance", dates as Excel serials).
 * Both go through the SAME company parser (statement-parse / statement-xlsx) and then through
 * import.ts — so a personal import and a company import read a bank file the same way.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";

import { parseStatement, parseStatementRows } from "@/lib/banking/statement-parse";
import { excelToRows } from "@/lib/banking/statement-xlsx";
import {
  PERSONAL_CATEGORIES,
  PERSONAL_INCOME_CATEGORIES,
  PERSONAL_SPEND_CATEGORIES,
  isPersonalCategory,
} from "./categories";
import {
  dedupeHash,
  detectCardPayment,
  detectSelfTransfer,
  mapParsedRow,
  mapStatement,
  personalKeywordFn,
  verifyAgainstStatement,
  type PersonalRule,
} from "./import";
import { PERSONAL_EXPENSE_CATEGORIES } from "./net-worth";

// ─── fixtures ────────────────────────────────────────────────────────────────

const HDFC_CSV = [
  "HDFC BANK Ltd.",
  "Account No : 50100012345678",
  "Statement From : 01/04/26 To : 30/04/26",
  "Opening Balance : 50,000.00",
  "Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance",
  "01/04/26,SALARY APR 2026 ACME SOFTWARE PVT LTD,NEFT0001,01/04/26,,\"85,000.00\",\"1,35,000.00\"",
  "02/04/26,UPI-SWIGGY-SWIGGY@ICICI-ICIC0000001-610012345678-ORDER,0000610012345678,02/04/26,450.00,,\"1,34,550.00\"",
  "03/04/26,CC PAYMENT XX1234,0000000000000001,03/04/26,\"12,000.00\",,\"1,22,550.00\"",
  "04/04/26,NWD-512345XXXXXX1234-S1ANDL01-NEW DELHI,0000409312345678,04/04/26,\"2,000.00\",,\"1,20,550.00\"",
  "05/04/26,IMPS-610512345678-RAVI KUMAR-SBIN-XXXXXXX9876-SELF,0000610512345678,05/04/26,\"10,000.00\",,\"1,10,550.00\"",
  "06/04/26,UPI-AMAZON PAY-AMAZON@APL-UTIB0000001-610612345678-REFUND,0000610612345678,06/04/26,,799.00,\"1,11,349.00\"",
  "07/04/26,UPI-BESCOM-BESCOM@HDFC-HDFC0000001-610712345678-ELECTRICITY BILL,0000610712345678,07/04/26,\"1,850.00\",,\"1,09,499.00\"",
  "08/04/26,UPI-ZOMATO-ZOMATO@HDFC-HDFC0000001-610812345678-ORDER,0000610812345678,08/04/26,320.00,,\"1,09,179.00\"",
  "30/04/26,CREDIT INTEREST CAPITALISED,,30/04/26,,410.00,\"1,09,589.00\"",
].join("\n");

const SBI_HEADER = ["Txn Date", "Value Date", "Description", "Ref No./Cheque No.", "Debit", "Credit", "Balance"];
const serial = (y: number, m: number, d: number) => (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86_400_000;

async function sbiRows(): Promise<string[][]> {
  const aoa: (string | number)[][] = [
    ["Account Name : RAVI KUMAR"],
    ["Account Number : 00000031234567890"],
    ["Balance as on 1 May 2026 : 20,000.00"],
    SBI_HEADER,
    [serial(2026, 5, 2), serial(2026, 5, 2), "TO TRANSFER-UPI/DR/612212345678/BLINKIT/YESB/blinkit@ybl/Groceries", "TRANSFER TO 4897", 640, "", 19360],
    [serial(2026, 5, 3), serial(2026, 5, 3), "BY TRANSFER-NEFT*HDFC0000001*N123456789*RAVI KUMAR*SELF", "TRANSFER FROM 1234", "", 10000, 29360],
    [serial(2026, 5, 4), serial(2026, 5, 4), "TO TRANSFER-UPI/DR/612412345678/LIC OF INDIA/HDFC/lic@hdfc/premium", "TRANSFER TO 4897", 5000, "", 24360],
    [serial(2026, 5, 5), serial(2026, 5, 5), "ATM WDL-ATM CASH 1234 SECTOR 17 CHANDIGARH", "ATM 1234", 3000, "", 21360],
    [serial(2026, 5, 6), serial(2026, 5, 6), "BY TRANSFER-UPI/CR/612612345678/PHONEPE/YESB/cashback@ybl/CASHBACK", "TRANSFER FROM 4897", "", 25, 21385],
  ];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  // Date cells carry a date format, as SBI's export does.
  for (let r = 4; r < aoa.length; r++) {
    for (const c of [0, 1]) {
      const ref = XLSX.utils.encode_cell({ r, c });
      if (ws[ref]) ws[ref].z = "dd-mm-yyyy";
    }
  }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Statement");
  const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
  return excelToRows(buf);
}

const OWN = { ownNames: ["Ravi Kumar"], ownAccountTails: ["9876"] };

// ─── directions / kinds ──────────────────────────────────────────────────────

describe("HDFC CSV → personal lines", () => {
  const parsed = parseStatement(HDFC_CSV);
  const lines = mapStatement(parsed.rows, { rules: [], ...OWN });
  const byStart = (s: string) => lines.find((l) => l.description.startsWith(s))!;

  it("parses every line", () => {
    expect(parsed.rows).toHaveLength(9);
    expect(lines).toHaveLength(9);
  });

  it("debits become expense / transfer_out / card_payment, credits income / refund / transfer_in", () => {
    for (const l of lines) {
      if (l.direction === "debit") expect(["expense", "transfer_out", "card_payment"]).toContain(l.kind);
      else expect(["income", "refund", "transfer_in"]).toContain(l.kind);
    }
    expect(byStart("SALARY").direction).toBe("credit");
    expect(byStart("SALARY").kind).toBe("income");
    expect(byStart("UPI-SWIGGY").direction).toBe("debit");
    expect(byStart("UPI-SWIGGY").kind).toBe("expense");
  });

  it("amount is the positive whole-rupee figure; direction carries the sign", () => {
    expect(byStart("SALARY").amount).toBe(85000);
    expect(byStart("UPI-SWIGGY").amount).toBe(450);
    expect(lines.every((l) => Number.isInteger(l.amount) && l.amount > 0)).toBe(true);
  });

  it("SWIGGY and ZOMATO map to Food; BESCOM to Utilities; salary to Salary; interest to Interest", () => {
    expect(byStart("UPI-SWIGGY").category).toBe("Food / Dining");
    expect(byStart("UPI-ZOMATO").category).toBe("Food / Dining");
    expect(byStart("UPI-BESCOM").category).toBe("Utilities");
    expect(byStart("SALARY").category).toBe("Salary");
    expect(byStart("CREDIT INTEREST").category).toBe("Interest");
  });

  it("'CC PAYMENT XX1234' is a card_payment with no spend category", () => {
    const l = byStart("CC PAYMENT");
    expect(l.kind).toBe("card_payment");
    expect(l.category).toBeNull();
  });

  it("an ATM withdrawal and a transfer to my own account are transfer_out, not spend", () => {
    expect(byStart("NWD-").kind).toBe("transfer_out");
    expect(byStart("IMPS-610512345678-RAVI KUMAR").kind).toBe("transfer_out");
    expect(byStart("NWD-").category).toBeNull();
  });

  it("an Amazon refund credit is a refund, not income", () => {
    expect(byStart("UPI-AMAZON PAY").kind).toBe("refund");
    expect(byStart("UPI-AMAZON PAY").category).toBe("Refund");
  });
});

describe("SBI XLSX → personal lines", () => {
  it("directions, kinds and categories", async () => {
    const parsed = parseStatementRows(await sbiRows());
    expect(parsed.rows).toHaveLength(5);
    const lines = mapStatement(parsed.rows, { rules: [], ...OWN });
    const [blinkit, self, lic, atm, cashback] = lines;
    expect(blinkit).toMatchObject({ txn_date: "2026-05-02", direction: "debit", kind: "expense", category: "Groceries", amount: 640 });
    expect(self).toMatchObject({ direction: "credit", kind: "transfer_in", category: null });
    expect(lic).toMatchObject({ direction: "debit", kind: "expense", category: "Insurance Premium" });
    expect(atm).toMatchObject({ direction: "debit", kind: "transfer_out", category: null });
    expect(cashback).toMatchObject({ direction: "credit", kind: "refund", category: "Cashback" });
  });
});

// ─── detection helpers ──────────────────────────────────────────────────────

describe("card payment and self-transfer detection", () => {
  it.each([
    "CC PAYMENT XX1234",
    "CREDIT CARD PAYMENT 4375XXXXXXXX1234",
    "UPI-CRED CLUB-CRED.CLUB@AXISB-UTIB0000001-612312345678-CREDIT CARD BILL",
    "BILLDESK*HDFC CARD PAYMENT",
    "IB BILLPAY DR-HDFCC6-437546XXXXXX1234",
  ])("%s is a card payment", (d) => {
    expect(detectCardPayment(d)).toBe(true);
  });

  it.each([
    "UPI-SWIGGY-SWIGGY@ICICI-ICIC0000001-610012345678-ORDER",
    "POS 437546XXXXXX1234 DMART",   // a card SPEND is not a card bill payment
    "ACCOUNTS PAYMENT CCAVENUE",
  ])("%s is not a card payment", (d) => {
    expect(detectCardPayment(d)).toBe(false);
  });

  it("own name or own account tail = self transfer; someone else is not", () => {
    expect(detectSelfTransfer("IMPS-610512345678-RAVI KUMAR-SBIN-XXXXXXX9876", OWN)).toBe(true);
    expect(detectSelfTransfer("NEFT-HDFC000-OWN A/C TRANSFER", {})).toBe(true);
    expect(detectSelfTransfer("UPI-RAVI-ravi@ybl-XX9876-SELF", {})).toBe(true);
    expect(detectSelfTransfer("IMPS-610512345678-SUNIL VERMA-SBIN-XXXXXXX1111-RENT", OWN)).toBe(false);
    // A short own name never matches inside a longer word.
    expect(detectSelfTransfer("UPI-AMITABH STORES-amitabh@ybl", { ownNames: ["Amit"] })).toBe(false);
  });
});

// ─── rules (categorise.ts wiring) ───────────────────────────────────────────

describe("personal rules", () => {
  const row = { txn_date: "2026-04-10", description: "UPI-SHARMA JI KIRANA-sharma@ybl-ORDER", debit: 230, credit: 0, balance_after: null, reference: null };
  const rules: PersonalRule[] = [{ id: "r1", pattern: "SHARMA JI KIRANA", category: "Groceries", direction: "debit" }];

  it("an injected personal rule decides the category, with its reason", () => {
    const l = mapParsedRow(row, { rules });
    expect(l.category).toBe("Groceries");
    expect(l.categoryLayer).toBe("rule");
    expect(l.reason).toBe("rule: SHARMA JI KIRANA");
  });

  it("a rule beats a keyword (user said 'always put SWIGGY under Household')", () => {
    const swiggy = { ...row, description: "UPI-SWIGGY-SWIGGY@ICICI-ORDER" };
    expect(mapParsedRow(swiggy, { rules: [] }).category).toBe("Food / Dining");
    expect(mapParsedRow(swiggy, { rules: [{ id: "r2", pattern: "SWIGGY", category: "Household", direction: "any" }] }).category).toBe("Household");
  });

  it("no rule and no keyword = null category, never a guess", () => {
    const l = mapParsedRow({ ...row, description: "UPI-XQZW-xqzw@ybl" }, { rules: [] });
    expect(l.kind).toBe("expense");
    expect(l.category).toBeNull();
    expect(l.categoryLayer).toBeNull();
  });

  it("a debit never gets an income category and a credit never a spend one", () => {
    const debitSalary = mapParsedRow({ ...row, description: "SALARY ADVANCE RETURNED" }, { rules: [] });
    expect(PERSONAL_INCOME_CATEGORIES as readonly string[]).not.toContain(debitSalary.category);
    const creditSwiggy = mapParsedRow({ ...row, debit: 0, credit: 450, description: "UPI-SWIGGY-PAYOUT" }, { rules: [] });
    expect(PERSONAL_SPEND_CATEGORIES as readonly string[]).not.toContain(creditSwiggy.category);
  });

  it("the payment-rail guard: a bare UPI word never decides a category", () => {
    expect(personalKeywordFn("debit")("UPI-XQZW")).toBeNull();
  });
});

// ─── dedupe ──────────────────────────────────────────────────────────────────

describe("dedupeHash", () => {
  it("a re-import of the same CSV gives the same hashes", () => {
    const a = mapStatement(parseStatement(HDFC_CSV).rows, { rules: [] }).map((l) => l.dedupeHash);
    const b = mapStatement(parseStatement(HDFC_CSV).rows, { rules: [] }).map((l) => l.dedupeHash);
    expect(b).toEqual(a);
    expect(new Set(a).size).toBe(a.length);
  });

  it("is normalised: case, spacing and punctuation in the narration do not change it", () => {
    const base = { txn_date: "2026-04-02", description: "UPI-SWIGGY-SWIGGY@ICICI ORDER", debit: 450, credit: 0, balance_after: 1, reference: "0000610012345678" };
    const h = dedupeHash(base);
    expect(dedupeHash({ ...base, description: "  upi swiggy  swiggy@icici   order " })).toBe(h);
    expect(dedupeHash({ ...base, reference: " 0000610012345678 " })).toBe(h);
    expect(dedupeHash({ ...base, balance_after: 999 })).toBe(h);   // the balance column is not part of the line's identity
    expect(dedupeHash({ ...base, debit: 451 })).not.toBe(h);
    expect(dedupeHash({ ...base, txn_date: "2026-04-03" })).not.toBe(h);
    expect(dedupeHash({ ...base, debit: 0, credit: 450 })).not.toBe(h);
  });

  it("two genuinely identical lines in one file both survive (occurrence counter), and stay stable on re-import", () => {
    const tea = { txn_date: "2026-04-02", description: "UPI-CHAI POINT", debit: 20, credit: 0, balance_after: null, reference: null };
    const first = mapStatement([tea, tea], { rules: [] }).map((l) => l.dedupeHash);
    expect(first[0]).not.toBe(first[1]);
    expect(mapStatement([tea, tea], { rules: [] }).map((l) => l.dedupeHash)).toEqual(first);
  });
});

// ─── balance chain ───────────────────────────────────────────────────────────

describe("verifyAgainstStatement", () => {
  const rows = parseStatement(HDFC_CSV).rows;

  it("the full statement matches from the stated opening balance", () => {
    const check = verifyAgainstStatement(rows, 50000)!;
    expect(check.verdict).toBe("match");
    expect(check.statementBalance).toBe(109589);
  });

  it("a missing line is reported as a balance-chain mismatch with the amount", () => {
    const missing = rows.filter((r) => !r.description.startsWith("CC PAYMENT"));
    const check = verifyAgainstStatement(missing, 50000)!;
    expect(check.verdict).toBe("off");
    expect(check.gaps).toHaveLength(1);
    expect(check.gaps[0].amount).toBe(12000);
  });

  it("a wrong opening balance is reported", () => {
    const check = verifyAgainstStatement(rows, 40000)!;
    expect(check.verdict).toBe("off");
    expect(check.openingDifference).toBe(-10000);
  });

  it("with no opening given, the statement's own implied opening is used", () => {
    expect(verifyAgainstStatement(rows)!.verdict).toBe("match");
  });

  it("no running balance at all = null (nothing to check), not a made-up verdict", () => {
    expect(verifyAgainstStatement(rows.map((r) => ({ ...r, balance_after: null })), 0)).toBeNull();
  });
});

// ─── categories ──────────────────────────────────────────────────────────────

describe("categories", () => {
  it("keeps the existing 14 household buckets and adds income categories", () => {
    for (const c of PERSONAL_EXPENSE_CATEGORIES) expect(PERSONAL_SPEND_CATEGORIES).toContain(c);
    expect(PERSONAL_INCOME_CATEGORIES).toEqual(expect.arrayContaining(["Salary", "Interest", "Dividend", "Rent Received", "Refund", "Cashback", "Other Income"]));
    expect(new Set(PERSONAL_CATEGORIES).size).toBe(PERSONAL_CATEGORIES.length);
  });

  it("every keyword answer is a listed category", () => {
    const texts = ["SWIGGY", "BIGBASKET", "BESCOM", "IRCTC", "SALARY", "INTEREST", "DIVIDEND", "LIC OF INDIA", "AMAZON", "NETFLIX"];
    for (const dir of ["debit", "credit"] as const) {
      for (const t of texts) {
        const c = personalKeywordFn(dir)(t);
        if (c) expect(isPersonalCategory(c)).toBe(true);
      }
    }
  });

  it("isPersonalCategory is case- and space-insensitive", () => {
    expect(isPersonalCategory("  food / dining ")).toBe(true);
    expect(isPersonalCategory("Salaries")).toBe(false);
  });
});

// ─── purity ──────────────────────────────────────────────────────────────────

describe("purity", () => {
  /** Every @/ and relative import reachable from a file, resolved to a src-relative path. */
  function reachable(entry: string): string[] {
    const src = path.resolve(__dirname, "../../..");
    const seen = new Set<string>();
    const walk = (abs: string) => {
      const rel = path.relative(src, abs).replace(/\\/g, "/");
      if (seen.has(rel)) return;
      seen.add(rel);
      const text = fs.readFileSync(abs, "utf8");
      for (const m of text.matchAll(/(?:^|\n)\s*(?:import|export)[^'"\n]*?from\s+["']([^"']+)["']/g)) {
        const spec = m[1];
        let base: string | null = null;
        if (spec.startsWith("@/")) base = path.join(src, spec.slice(2));
        else if (spec.startsWith(".")) base = path.resolve(path.dirname(abs), spec);
        if (!base) continue;
        const file = [".ts", ".tsx", "/index.ts"].map((e) => base + e).find((f) => fs.existsSync(f));
        if (file) walk(file);
      }
    };
    walk(path.resolve(__dirname, entry));
    return [...seen];
  }

  it("import.ts and categories.ts reach nothing in components/ or lib/queries/ (no DB, no UI)", () => {
    const files = [...reachable("import.ts"), ...reachable("categories.ts")];
    expect(files).toContain("lib/vault/personal/import.ts");
    expect(files.filter((f) => f.startsWith("components/") || f.startsWith("lib/queries/") || f.startsWith("lib/supabase/client"))).toEqual([]);
  });

  it("does not reach the business category list or suggestCategory", () => {
    const imports = ["import.ts", "categories.ts"]
      .map((f) => fs.readFileSync(path.resolve(__dirname, f), "utf8"))
      .flatMap((text) => [...text.matchAll(/(?:^|\n)\s*import[^;]*?from\s+["'][^"']+["']/g)].map((m) => m[0]));
    expect(imports.length).toBeGreaterThan(0);
    for (const line of imports) {
      expect(line).not.toMatch(/(?<!PERSONAL_)EXPENSE_CATEGORIES/);
      expect(line).not.toMatch(/suggestCategory|lib\/queries\/expenses/);
    }
  });
});
