/**
 * R-1873 guard — an employee loan/advance and its cash line are ONE fact.
 *
 * Pardeep (staging, 24 Oct 2026): ₹2,000 to Prashant from Petty Cash twice, deleted one →
 * Payments Made still listed two −₹2,000 rows while Petty Cash showed −₹2,000. The delete wrote
 * a "Correction" credit instead of removing the payout line, and Payments Made lists payout
 * (debit) lines. The money proof (give ×2 → delete → every reader agrees) is the SQL test
 * supabase/tests/r1873_employee_loan_cash_line.test.sql; this file pins the parts that can drift
 * in TypeScript or in a later migration.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loanErrorToastOptions } from "@/lib/queries/employee-loans";

const root = process.cwd();
const migDir = join(root, "supabase", "migrations");
const read = (p: string) => readFileSync(join(root, p), "utf8");

/** The newest migration that (re)defines a function — the body that is live after deploy. */
function latestBody(fn: string): { file: string; body: string } {
  const re = new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${fn}\\s*\\(`, "i");
  const files = readdirSync(migDir).filter((f) => f.endsWith(".sql")).sort();
  for (let i = files.length - 1; i >= 0; i--) {
    const sql = readFileSync(join(migDir, files[i]), "utf8");
    const m = re.exec(sql);
    if (!m) continue;
    const rest = sql.slice(m.index);
    const end = rest.search(/\$function\$\s*;|\$\$\s*;/);
    return { file: files[i], body: end > 0 ? rest.slice(0, end) : rest };
  }
  throw new Error(`no migration defines public.${fn}`);
}

describe("R-1873: loan delete removes its cash line (no correction pair)", () => {
  it("the live delete_employee_loan deletes the payout line it is linked to", () => {
    const { file, body } = latestBody("delete_employee_loan");
    expect(file >= "20261024200000", `delete_employee_loan was redefined by ${file} — keep R-1873's rule`).toBe(true);
    expect(body).toMatch(/delete\s+from\s+public\.bank_transactions\s+where\s+id\s*=\s*v_line\.id/i);
    // a correction credit only for an old loan whose line cannot be found
    expect(body).toMatch(/elsif\s+v_loan\.bank_account_id\s+is\s+not\s+null\s+then[\s\S]*Correction: reversed/i);
    // re-booked line → refused with the Banking link as the next step (§24)
    expect(body).toMatch(/hint\s*=\s*'\/accounting\/banking\//i);
  });

  it("the live disburse_employee_loan stores the line on the loan", () => {
    const { body } = latestBody("disburse_employee_loan");
    expect(body).toMatch(/returning\s+id\s+into\s+v_txn/i);
    expect(body).toMatch(/bank_txn_id\)\s*values/i);
  });

  it("the live edit_employee_loan changes the line in place", () => {
    const { body } = latestBody("edit_employee_loan");
    expect(body).toMatch(/update\s+public\.bank_transactions\s+set\s+bank_account_id\s*=\s*p_bank_account_id/i);
  });

  it("give / edit / delete refresh Payments Made, not only the bank page", () => {
    const src = read("src/lib/queries/employee-loans.ts");
    for (const hook of ["useDisburseLoan", "useEditLoan", "useDeleteEmployeeLoan"]) {
      const start = src.indexOf(`export function ${hook}(`);
      const body = src.slice(start, src.indexOf("\n}\n", start));
      expect(body, hook).toContain(`queryKey: ["payments-made"]`);
    }
  });

  it("the give button cannot pay twice on a double-click", () => {
    const src = read("src/app/(app)/accounting/loans/page.tsx");
    const start = src.indexOf("function DisburseDialog(");
    const body = src.slice(start, src.indexOf("\n}\n", start));
    expect(body).toMatch(/if \(savingRef\.current\) return;/);
    expect(body).toMatch(/savingRef\.current = true;[\s\S]*mutateAsync[\s\S]*finally \{\s*savingRef\.current = false;/);
  });
});

describe("loanErrorToastOptions — the refusal's next step becomes a button (§24)", () => {
  it("re-booked line → 'Open the cash line' to that line on Banking", () => {
    const go = vi.fn();
    const o = loanErrorToastOptions({
      message: "This loan's cash line … is now booked as \"expense\" …",
      details: "Open the line in Banking, un-reconcile it, then delete the loan again.",
      hint: "/accounting/banking/acc-1?focus=txn-9",
    }, go);
    expect(o.description).toBe("Open the line in Banking, un-reconcile it, then delete the loan again.");
    expect(o.action?.label).toBe("Open the cash line");
    o.action?.onClick();
    expect(go).toHaveBeenCalledWith("/accounting/banking/acc-1?focus=txn-9");
  });

  it("never follows a hint outside the app's /accounting pages", () => {
    expect(loanErrorToastOptions({ hint: "https://evil.example/x" }, vi.fn()).action).toBeUndefined();
    expect(loanErrorToastOptions({ hint: "//evil.example" }, vi.fn()).action).toBeUndefined();
    expect(loanErrorToastOptions(new Error("x"), vi.fn())).toEqual({});
  });
});
