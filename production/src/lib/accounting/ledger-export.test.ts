import { describe, it, expect } from "vitest";
import {
  ledgerCsvRows, ledgerCsv, ledgerFileName, ledgerTallyXml, xmlEscape,
  ledgerWhatsAppText, ledgerWhatsAppUrl, LEDGER_CSV_HEADERS,
} from "./ledger-export";
import { buildLedger, fyPeriod, type LedgerEntry } from "./ledger";
import { denyTermsRe } from "@/test/deny-terms";

const FY26 = fyPeriod(2026);

const entries: LedgerEntry[] = [
  { date: "2026-02-01", reference: "INV-OLD", voucher: "Sales", amount: 25_000, increasesLiability: true },
  { date: "2026-05-10", reference: "INV-ADPL-2026-27-0001", voucher: "Sales", amount: 100_000, increasesLiability: true, narration: "Google Workspace · 25 seats" },
  { date: "2026-05-20", reference: "RV-ADPL-2026-27-0001", voucher: "Receipt", amount: 60_000, increasesLiability: false, narration: "upi · UTR123" },
];
const cust = buildLedger("customer", entries, FY26);
const vend = buildLedger("vendor", entries, FY26);

describe("CSV — a CA sums the columns, so the opening balance is a ROW", () => {
  it("puts opening first and closing last", () => {
    const rows = ledgerCsvRows(cust);
    expect(rows[0][1]).toBe("Opening Balance");
    expect(rows[rows.length - 1][1]).toBe("Closing Balance");
  });

  it("carries the opening amount and its side, not just a label", () => {
    /* Outside the table the column sum is wrong by exactly the carried-forward amount,
       and nothing on the sheet says so. */
    const [opening] = ledgerCsvRows(cust);
    expect(opening[5]).toBe(25_000);
    expect(opening[6]).toBe("Dr");
  });

  it("puts the column totals on the closing row", () => {
    const rows = ledgerCsvRows(cust);
    const closing = rows[rows.length - 1];
    expect(closing[3]).toBe(100_000);   // total debit
    expect(closing[4]).toBe(60_000);    // total credit
    expect(closing[5]).toBe(65_000);    // 25,000 + 100,000 − 60,000
    expect(closing[6]).toBe("Dr");
  });

  it("writes a BLANK, not a zero, in the column a row does not use", () => {
    /* "0" in the Credit column of a sales row reads as a ₹0 credit note. */
    const rows = ledgerCsvRows(cust);
    const sales = rows.find((r) => r[2] === "Sales")!;
    expect(sales[3]).toBe(100_000);
    expect(sales[4]).toBe("");
  });

  it("keeps the narration with its reference so Particulars is readable", () => {
    const rows = ledgerCsvRows(cust);
    expect(rows.find((r) => String(r[1]).includes("INV-ADPL-2026-27-0001"))![1])
      .toBe("INV-ADPL-2026-27-0001 — Google Workspace · 25 seats");
  });

  it("emits an absolute balance with the side in its own column", () => {
    /* "-65000" needs the reader to know our sign convention. "65000 / Dr" does not. */
    for (const r of ledgerCsvRows(cust)) expect(Number(r[5])).toBeGreaterThanOrEqual(0);
  });

  it("builds a CSV with CRLF and the seven Tally-shaped headers", () => {
    const csv = ledgerCsv(cust);
    expect(csv.split("\r\n")[0]).toBe(LEDGER_CSV_HEADERS.join(","));
    expect(LEDGER_CSV_HEADERS).toHaveLength(7);
  });

  it("reuses lib/csv's formula-injection guard", () => {
    /* A party named "=cmd|..." must not execute when the CA opens the sheet. */
    const s = buildLedger("customer", [
      { date: "2026-05-10", reference: "=SUM(A1:A9)", voucher: "Sales", amount: 100, increasesLiability: true },
    ], FY26);
    expect(ledgerCsv(s)).not.toMatch(/,=SUM/);
  });
});

describe("file names", () => {
  it("slugs the party and stamps the period", () => {
    expect(ledgerFileName("Mary corprotion", cust, "csv"))
      .toBe("ledger-mary-corprotion-FY-2026-27.csv");
  });

  it("survives a name made entirely of punctuation", () => {
    expect(ledgerFileName("!!!", cust, "xml")).toBe("ledger-party-FY-2026-27.xml");
  });
});

/**
 * ─── TALLY'S SIGN CONVENTION IS THE OPPOSITE OF A HUMAN'S ───────────────────
 * In a Tally XML ledger entry a NEGATIVE amount is a Debit. Reversed, the envelope imports
 * cleanly and puts every figure on the wrong side — no error, and the CA finds it while
 * reconciling. This is the single most important assertion in the file.
 */
describe("Tally XML", () => {
  const xml = ledgerTallyXml(cust, "Mary corprotion", "ANUTECH DIGITAL PVT LTD");

  it("writes a Debit as a NEGATIVE amount", () => {
    /* The ₹1,00,000 sales invoice debits the customer. */
    expect(xml).toContain("<AMOUNT>-100000</AMOUNT>");
  });

  it("writes a Credit as a POSITIVE amount", () => {
    /* The ₹60,000 receipt credits the customer. */
    expect(xml).toContain("<AMOUNT>60000</AMOUNT>");
  });

  it("balances every voucher — the two ledger entries must cancel", () => {
    const amounts = [...xml.matchAll(/<AMOUNT>(-?\d+)<\/AMOUNT>/g)].map((m) => Number(m[1]));
    expect(amounts.length).toBeGreaterThan(0);
    expect(amounts.reduce((a, b) => a + b, 0)).toBe(0);
  });

  it("sets ISDEEMEDPOSITIVE to match the sign, as Tally requires", () => {
    const debitBlock = xml.slice(xml.indexOf("<AMOUNT>-100000</AMOUNT>") - 200, xml.indexOf("<AMOUNT>-100000</AMOUNT>"));
    expect(debitBlock).toContain("<ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>");
  });

  it("uses YYYYMMDD, Tally's XML date format", () => {
    /* Was DDMMYYYY ("10052026") until S34, 28 Sep 2026. Tally's XML import/export reads
       <DATE> as YYYYMMDD; the old value would land as a nonsense date or be rejected.
       From Tally's documented format — not yet imported into a real Tally company. */
    expect(xml).toContain("<DATE>20260510</DATE>");
  });

  it("faces a customer at Sundry Debtors and a vendor at Sundry Creditors", () => {
    /* Both groups exist in every Tally company. A specific sales or purchase ledger name
       would be a guess about the CA's chart of accounts, and a wrong guess rejects the row. */
    expect(xml).toContain("Sundry Debtors");
    expect(ledgerTallyXml(vend, "Google India", "ANUTECH DIGITAL PVT LTD"))
      .toContain("Sundry Creditors");
  });

  it("maps a Refund to Tally's own Receipt rather than inventing a voucher type", () => {
    /* A voucher type absent from the target company is rejected per row, quietly. */
    const s = buildLedger("customer", [
      { date: "2026-06-01", reference: "RFV-1", voucher: "Refund", amount: 5_000, increasesLiability: true },
    ], FY26);
    const x = ledgerTallyXml(s, "P", "C");
    expect(x).toContain('VCHTYPE="Receipt"');
    expect(x).not.toContain("Refund Voucher");
  });

  it("escapes an ampersand, because Tally rejects the whole envelope on one", () => {
    /* "R&D Solutions" is not hypothetical. */
    expect(xmlEscape('R&D "A" <b>')).toBe("R&amp;D &quot;A&quot; &lt;b&gt;");
    expect(ledgerTallyXml(cust, "R&D Solutions", "A&B Co")).not.toMatch(/R&D/);
  });

  it("names the company so the import targets the right Tally book", () => {
    expect(xml).toContain("<SVCURRENTCOMPANY>ANUTECH DIGITAL PVT LTD</SVCURRENTCOMPANY>");
  });
});

/**
 * ─── THE WHATSAPP MESSAGE MUST STATE THE BALANCE IN WORDS ───────────────────
 * A customer reading on a phone should learn whether they owe money without opening
 * anything. "Please find attached" makes them open a file to discover a ₹65,000 debt, and
 * the ones who never open it never find out.
 */
describe("WhatsApp message", () => {
  it("names the party, the period and the closing balance", () => {
    const t = ledgerWhatsAppText({ partyName: "Mary corprotion", statement: cust });
    expect(t).toContain("Mary corprotion");
    expect(t).toContain("FY 2026-27");
    expect(t).toMatch(/₹65,000 outstanding/);
  });

  it("shows what was billed and received, not only the net", () => {
    const t = ledgerWhatsAppText({ partyName: "Mary", statement: cust });
    expect(t).toContain("₹1,00,000");
    expect(t).toContain("₹60,000");
  });

  it("says 'nothing outstanding' on a settled account, never '₹0'", () => {
    /* Sending "₹0 Dr" to a customer who paid in full is how a reseller loses a renewal. */
    const settled = buildLedger("customer", [
      { date: "2026-05-10", reference: "INV-1", voucher: "Sales", amount: 100, increasesLiability: true },
      { date: "2026-05-11", reference: "RV-1", voucher: "Receipt", amount: 100, increasesLiability: false },
    ], FY26);
    const t = ledgerWhatsAppText({ partyName: "Mary", statement: settled });
    expect(t).toMatch(/Nothing outstanding/i);
    expect(t).not.toMatch(/₹0 outstanding/);
  });

  it("says the money is THEIRS when the balance is a credit", () => {
    const advance = buildLedger("customer", [
      { date: "2026-05-11", reference: "RV-1", voucher: "Receipt", amount: 20_000, increasesLiability: false },
    ], FY26);
    const t = ledgerWhatsAppText({ partyName: "Mary", statement: advance });
    expect(t).toMatch(/in your favour/);
    expect(t).toMatch(/advance/);
  });

  it("invites a correction instead of asserting the books are right", () => {
    expect(ledgerWhatsAppText({ partyName: "Mary", statement: cust }))
      .toMatch(/does not match your books/);
  });

  it("signs with the tenant, and goes unsigned when unknown", () => {
    /* Same rule as lib/whatsapp.ts: no name beats the wrong name. */
    expect(ledgerWhatsAppText({ partyName: "M", statement: cust, sellerName: "ANUTECH DIGITAL PVT LTD" }))
      .toContain("ANUTECH DIGITAL PVT LTD");
    const unsigned = ledgerWhatsAppText({ partyName: "M", statement: cust, sellerName: null });
    expect(unsigned).not.toMatch(denyTermsRe());
    expect(unsigned.trimEnd().endsWith("trace it.")).toBe(true);
  });
});

describe("the wa.me link", () => {
  it("prefixes a bare ten-digit number with 91", () => {
    expect(ledgerWhatsAppUrl("9876543210", "hi")).toContain("wa.me/919876543210");
  });

  it("leaves an already-prefixed number alone", () => {
    expect(ledgerWhatsAppUrl("+91 98765 43210", "hi")).toContain("wa.me/919876543210");
  });

  it("round-trips the message intact", () => {
    const text = ledgerWhatsAppText({ partyName: "R&D Solutions", statement: cust });
    const url = new URL(ledgerWhatsAppUrl(null, text));
    expect(url.searchParams.get("text")).toBe(text);
  });
});
