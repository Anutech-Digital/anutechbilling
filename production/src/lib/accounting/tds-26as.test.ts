/**
 * 26AS / AIS parser + match — synthetic fixtures only (koi asli PAN/TAN nahi; sab
 * format-valid banaye hue: AAAAA0000A / DELA00001A jaise).
 */
import { describe, it, expect } from "vitest";
import {
  parse26asText, parseAisJson, parseTdsCreditFile, matchCredits, parseIndianDate, parsePaise, fyCodeOf,
  type ReceivableLike,
} from "./tds-26as";

const TXT = [
  "File Creation Date^Permanent Account Number (PAN)^Current Status of PAN^Financial Year^Assessment Year^Name of Assessee",
  "20-09-2026^AAAAA0000A^Active^2026-27^2027-28^S33 TEST RESELLER PVT LTD",
  "",
  "PART-I - Details of Tax Deducted at Source",
  "Sr. No.^Name of Deductor^TAN of Deductor^^^^^Total Amount Paid / Credited(Rs.)^Total Tax Deducted(Rs.)^Total TDS Deposited(Rs.)",
  "1^ALPHA CLIENT PVT LTD^DELA00001A^^^^^15,000.00^1,500.00^1,500.00",
  "^Sr. No.^Section^Transaction Date^Status of Booking^Date of Booking^Remarks^Amount Paid / Credited(Rs.)^Tax Deducted(Rs.)^TDS Deposited(Rs.)",
  "^1^194J^20-May-2026^F^31-Jul-2026^-^10,000.00^1,000.00^1,000.00",
  "^2^194J^22-Jun-2026^F^31-Jul-2026^-^5,000.00^500.00^500.00",
  "2^BETA CLIENT LTD^MUMB00002B^^^^^8,000.00^800.00^800.00",
  "^1^194C^05-Jul-2026^U^-^-^8,000.00^800.00^800.00",
  "3^GAMMA STRANGER LTD^PNEG00003C^^^^^1,000.00^100.00^100.00",
  "^1^194J^01-Aug-2026^F^31-Oct-2026^-^1,000.00^100.00^100.00",
  "PART-II - Details of Tax Deducted at Source for 15G / 15H",
  "Sr. No.^Name of Deductor^TAN of Deductor^^^^^Total Amount Paid / Credited(Rs.)^Total Tax Deducted(Rs.)^Total TDS Deposited(Rs.)",
  "1^SHOULD NOT COUNT^DELA00009Z^^^^^9,999.00^999.00^999.00",
  "^1^194A^01-May-2026^F^31-Jul-2026^-^9,999.00^999.00^999.00",
].join("\r\n");

describe("helpers", () => {
  it("dates in the formats TRACES and AIS use, and nothing invented", () => {
    expect(parseIndianDate("20-May-2026")).toBe("2026-05-20");
    expect(parseIndianDate("05-07-2026")).toBe("2026-07-05");
    expect(parseIndianDate("2026-07-05T00:00:00")).toBe("2026-07-05");
    expect(parseIndianDate("31-Feb-2026")).toBeNull();
    expect(parseIndianDate("-")).toBeNull();
  });
  it("amounts become integer paise; junk is null, never 0", () => {
    expect(parsePaise("1,500.50")).toBe(150050);
    expect(parsePaise(1000)).toBe(100000);
    expect(parsePaise("-")).toBeNull();
    expect(parsePaise("abc")).toBeNull();
  });
  it("FY code in tds_receivable's own format", () => {
    expect(fyCodeOf("2026-05-20")).toBe("FY2627");
    expect(fyCodeOf("2027-03-31")).toBe("FY2627");
    expect(fyCodeOf("2026-03-31")).toBe("FY2526");
  });
});

describe("parse26asText", () => {
  const p = parse26asText(TXT);
  it("reads the assessee header", () => {
    expect(p).toMatchObject({ source: "26as", pan: "AAAAA0000A", financialYear: "2026-27", asOn: "2026-09-20" });
  });
  it("reads PART-I transactions under the right deductor, and stops at PART-II", () => {
    expect(p.entries).toHaveLength(4);
    expect(p.entries[0]).toEqual({
      source: "26as", deductorName: "ALPHA CLIENT PVT LTD", tan: "DELA00001A", section: "194J",
      date: "2026-05-20", amountPaidPaise: 1_000_000, tdsPaise: 100_000, booking: "F",
    });
    expect(p.entries.map((e) => e.tan)).not.toContain("DELA00009Z");
    expect(p.entries[2]).toMatchObject({ tan: "MUMB00002B", booking: "U" });
  });
  it("an unreadable file is an error, not an empty list", () => {
    expect(() => parse26asText("hello\nworld")).toThrow(/PART-I/);
  });
});

describe("parseAisJson", () => {
  const ais = {
    pan: "AAAAA0000A",
    financialYear: "2026-27",
    tdsTcsInformation: [
      {
        informationCode: "TDS-194J",
        tanOfDeductor: "DELA00001A",
        nameOfDeductor: "ALPHA CLIENT PVT LTD",
        transactions: [
          { dateOfPaymentCredit: "20/05/2026", amountPaidCredited: "10000.00", taxDeducted: "1000.00", section: "194J" },
          { dateOfPaymentCredit: "22/06/2026", amountPaidCredited: 5000, taxDeducted: 500 },
        ],
      },
    ],
  };
  it("finds TDS rows by field names, inheriting the deductor from the parent", () => {
    const p = parseAisJson(JSON.stringify(ais));
    expect(p.pan).toBe("AAAAA0000A");
    expect(p.entries).toHaveLength(2);
    expect(p.entries[1]).toMatchObject({ tan: "DELA00001A", deductorName: "ALPHA CLIENT PVT LTD", date: "2026-06-22", tdsPaise: 50_000, booking: null });
    expect(p.entries[0].section).toBe("194J");
  });
  it("says so when the JSON has no TDS rows, or is not JSON", () => {
    expect(() => parseAisJson(JSON.stringify({ sft: [] }))).toThrow(/No TDS entry/);
    expect(() => parseAisJson("not json")).toThrow(/JSON/);
  });
  it("routes by file name / first character", () => {
    expect(parseTdsCreditFile("ais.json", JSON.stringify(ais)).source).toBe("ais");
    expect(parseTdsCreditFile("26AS.txt", TXT).source).toBe("26as");
  });
});

describe("matchCredits", () => {
  const r = (id: string, over: Partial<ReceivableLike>): ReceivableLike => ({
    id, customer_name: "Alpha", customer_tan: "DELA00001A", tds_amount: 1000,
    payment_received_date: "2026-05-21", fiscal_year: "FY2627", status: "pending_cert", ...over,
  });
  const recs: ReceivableLike[] = [
    r("T1", {}),                                                            // ↔ 20 May 1000 F
    r("T2", { tds_amount: 500, payment_received_date: "2026-06-25", status: "cert_received" }), // ↔ 22 Jun 500
    r("T3", { customer_tan: "MUMB00002B", tds_amount: 800, payment_received_date: "2026-07-05" }), // ↔ U (not final)
    r("T4", { tds_amount: 2000, payment_received_date: "2026-08-15" }),     // Alpha, no entry → missing
    r("T5", { customer_tan: null, tds_amount: 300 }),                       // no TAN
    r("T6", { tds_amount: 999, fiscal_year: "FY2526", payment_received_date: "2025-06-01" }), // other FY — not "missing"
  ];
  const m = matchCredits(parse26asText(TXT).entries, recs);

  it("pairs by TAN + amount (₹1 tolerance) + FY, nearest date", () => {
    expect(m.matched.map((x) => [x.receivable.id, x.entry.date])).toEqual([["T1", "2026-05-20"], ["T2", "2026-06-22"]]);
    expect(m.matched[1].dayGap).toBe(3);
  });
  it("does not verify a booking that is not Final", () => {
    expect(m.notFinal.map((e) => e.tan)).toEqual(["MUMB00002B"]);
    expect(m.matched.some((x) => x.receivable.id === "T3")).toBe(false);
  });
  it("lists a deductor we have no record of, an open row the file lacks, and a row with no TAN", () => {
    expect(m.unknown.map((e) => e.tan)).toEqual(["PNEG00003C"]);
    expect(m.missing.map((x) => x.id)).toEqual(["T4"]);   // T3 file me hai (U), missing nahi
    expect(m.noTan.map((x) => x.id)).toEqual(["T5"]);
  });
  it("flags a same-TAN amount mismatch instead of matching it", () => {
    const mm = matchCredits(
      [{ source: "26as", deductorName: null, tan: "DELA00001A", section: "194J", date: "2026-05-20", amountPaidPaise: null, tdsPaise: 120_000, booking: "F" }],
      [r("T1", {})],
    );
    expect(mm.matched).toHaveLength(0);
    expect(mm.amountMismatch.map((x) => x.receivable.id)).toEqual(["T1"]);
    expect(mm.missing).toHaveLength(0);
  });
  it("accepts paise rounding up to ₹1 but not ₹2", () => {
    const e = (paise: number) => ({ source: "26as" as const, deductorName: null, tan: "DELA00001A", section: null, date: "2026-05-20", amountPaidPaise: null, tdsPaise: paise, booking: "F" as const });
    expect(matchCredits([e(100_099)], [r("T1", {})]).matched).toHaveLength(1);
    expect(matchCredits([e(100_200)], [r("T1", {})]).matched).toHaveLength(0);
  });
  it("a claimed row matches as already done, never back to verified", () => {
    const d = matchCredits(parse26asText(TXT).entries.slice(0, 1), [r("T1", { status: "claimed" })]);
    expect(d.matched).toHaveLength(0);
    expect(d.alreadyDone.map((x) => x.receivable.id)).toEqual(["T1"]);
  });
});
