/* R-523 — wiring (source scan; the rules are unit-tested in tds-rates.test.ts and
   tds-receipt.test.ts): the drawer, receipt, PDF, statement, Lifetime paid and owner report
   all read the same helpers. */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");
const drawer  = read("src/components/features/quotes/record-payment-dialog.tsx");
const receipt = read("src/components/features/quotes/receipt-voucher-dialog.tsx");
const pdf     = read("src/lib/pdf/ReceiptVoucherPDF.tsx");
const profile = read("src/components/features/customers/customer-profile.tsx");
const metric  = read("src/components/features/customers/customer-insights.tsx");
const tdsPage = read("src/app/(app)/accounting/tds-receivable/page.tsx");
const report  = read("src/app/(app)/accounting/tds-receivable/rate-check-report.tsx");
const queries = read("src/lib/queries/tds-receivable.ts");

describe("R-523 Record payment drawer", () => {
  it("changing the section sets the rate to that section's default from the one table", () => {
    const i = drawer.indexOf('setValue("tdsSection", v);');
    expect(i).toBeGreaterThan(0);
    expect(drawer.slice(i, i + 300)).toMatch(/tdsDefaultRatePct\(v\)[\s\S]*setValue\("tdsRatePct", def/);
  });
  it("a rate that does not fit the section shows a warning (overridable, with a one-tap fix)", () => {
    expect(drawer).toMatch(/const tdsRateCheck = checkTdsRate\(tdsSectionValue, tdsRatePct\)/);
    expect(drawer).toMatch(/tdsRateCheck\.message && \(/);
    expect(drawer).toMatch(/Use \{tdsRateCheck\.defaultPct\}%/);
  });
  it("one outcome sentence — no unconditional 'fully satisfied', no second 'will still be due'", () => {
    expect(drawer).not.toMatch(/fully satisfied/);
    expect(drawer).not.toMatch(/will still be due/);
    expect(drawer).not.toMatch(/Quote will be marked <b>fully paid<\/b>/);
    expect(drawer).toMatch(/const outcome = paymentOutcome\(\{ expected: expectedAmount, alreadyReceived, settled: settledAgainstQuote \}\)/);
    expect(drawer.match(/\{outcome\.sentence\}/g)?.length).toBe(2); // partial box, fully-paid box — never both (kind)
    expect(drawer).toMatch(/willBePartial && outcome\.kind === "partial"/);
    expect(drawer).toMatch(/\(outcome\.kind === "full" \|\| outcome\.kind === "over"\)/);
  });
  it("after saving, the customer's TDS profile follows the section/rate used — even with no TAN typed", () => {
    expect(drawer).not.toMatch(/if \(customerId && data\.customerTan\?\.trim\(\)\)/);
    const i = drawer.indexOf("tds_default_section:  data.tdsSection");
    expect(i).toBeGreaterThan(0);
    expect(drawer.slice(i - 300, i)).toMatch(/if \(customerId\) \{/);
    expect(drawer).toMatch(/Saving also sets this customer&apos;s TDS profile/);
  });
});

describe("R-523 receipt, statement, Lifetime paid show bank money and TDS apart", () => {
  it("receipt voucher fetches the payment's TDS and shows the split line (screen + PDF + WhatsApp)", () => {
    expect(receipt).toMatch(/useTdsForPayment\(payment\.id, open\)/);
    expect(receipt).toMatch(/receiptSplitLine\(payment\.amount, tdsOnPayment\)/);
    expect(receipt).toMatch(/data-testid="receipt-tds-split"/);
    expect(receipt).toMatch(/splitLine,/);
    expect(pdf).toMatch(/pdfSafeMoney\(splitLine\)/);
    expect(queries).toMatch(/\.eq\("payment_id", paymentId as string\)/);
  });
  it("customer statement credit row carries the split; Lifetime paid gets the TDS", () => {
    expect(profile).toMatch(/useTdsReceivables\(\{ customerId: params\.id \}\)/);
    expect(profile).toMatch(/receiptSplitLine\(p\.amount, tdsOnPayment\[p\.id\]\)/);
    expect(profile).toMatch(/lifetimeTds=\{lifetimeTds\}/);
    expect(metric).toMatch(/hint=\{receiptSplitLine\(lifetimePaid, lifetimeTds\) \?\? undefined\}/);
  });
});

describe("R-523 owner report and the section list", () => {
  it("TDS Receivable page lists entries whose rate does not fit the section, read-only", () => {
    expect(tdsPage).toMatch(/<TdsRateCheckReport onOpen=\{setSelected\} \/>/);
    expect(report).toMatch(/tdsRateMismatches\(q\.data \?\? \[\]\)/);
    expect(report).not.toMatch(/\.update\(|\.insert\(|\.delete\(|useMutation/);
  });
  it("section labels take their % from the rate table (no hand-typed 194H 5%)", () => {
    expect(queries).not.toMatch(/Commission \/ brokerage \(5%\)/);
    expect(queries).toMatch(/TDS_SECTION_RATES\[sec\]\?\.ratePct/);
  });
});
