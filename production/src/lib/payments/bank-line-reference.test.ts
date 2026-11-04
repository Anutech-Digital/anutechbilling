import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bankLinePaymentReference } from "./bank-line-reference";

/* R-2430: the TypeScript twin of public.bank_line_payment_reference — same cases as
   supabase/tests/r2430_placeholder_ref_bank_line.test.sql (RULE). */
describe("bankLinePaymentReference (R-2430)", () => {
  const id = "11111111-0000-0000-0000-000000243001";
  it("keeps a real UTR, trimmed", () => {
    expect(bankLinePaymentReference(" R2430UTR778899 ", id)).toBe("R2430UTR778899");
  });
  it("gives a placeholder or empty reference the bank line's own id", () => {
    for (const ref of ["000000000000000", "0000-0000-0000", "NA", "", "   ", null, undefined]) {
      expect(bankLinePaymentReference(ref, id)).toBe(`BANK-${id}`);
    }
  });
  it("two zero-ref lines get two different references; the same line gets the same one", () => {
    const other = "11111111-0000-0000-0000-000000243002";
    expect(bankLinePaymentReference("000000000000000", id)).not.toBe(bankLinePaymentReference("000000000000000", other));
    expect(bankLinePaymentReference("000000000000000", id)).toBe(bankLinePaymentReference("000000000000000", id));
  });
  it("trims spaces only, as Postgres btrim()", () => {
    expect(bankLinePaymentReference("HDFCN5202605191234\t", id)).toBe("HDFCN5202605191234\t");
  });
  it("the bank screen's record_payment calls use it (useBookCreditAsInvoice, useMatchCreditToInvoice)", () => {
    const src = readFileSync(join(__dirname, "../queries/bank.ts"), "utf8");
    expect(src.split("bankLinePaymentReference(input.reference, input.transactionId)").length - 1).toBe(2);
    expect(src).not.toContain('.trim() || `BANK-${input.transactionId}`');
  });
});
