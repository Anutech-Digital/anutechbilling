/**
 * R-1609 — one April-FY rule. ~20 files used to hand-write `m >= 4 ? y : y - 1` (and two label
 * formats). They now call lib/dates/ist.ts. This file proves the refactor changed no output:
 * each OLD formula is copied here verbatim and compared with the module's export for every
 * calendar day of 2023–2028 (both FY edges, leap days). The one intended change — the two
 * vault/personal pages read the FY in IST instead of the browser's clock — is pinned at the end.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { fyStartYear, fyStartISO, fyLabelOfYear, fyCodeOfYear, fyLabel, fyBounds } from "./ist";
import { fyStartOf as commissionFyStartOf } from "@/lib/accounting/commission-tds";
import { fyStartOf as depFyStartOf, fyLabel as depFyLabel } from "@/lib/accounting/depreciation";
import { fyOf, fyLabel as ledgerFyLabel } from "@/lib/accounting/ledger";
import { compliancePeriodKey } from "@/lib/accounting/month-close";
import { fyLabel as taxFyLabel, fyStartYearOf } from "@/lib/accounting/tax-payments";
import { fyCodeOf } from "@/lib/accounting/tds-26as";
import { fyStartFor } from "@/lib/banking/opening-balance";
import { itcDeadline } from "@/lib/compliance/entry-rules";
import { fyStartOfPeriod, fyLabelOf } from "@/lib/payroll/income-tax";
import { financialYear, currentFinancialYear } from "@/lib/tax/itr";
import { fyEndYear } from "@/app/(app)/setup/invoice-code";

function everyDay(from = "2023-01-01", to = "2028-12-31"): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}
const DAYS = everyDay();
const PERIODS = [...new Set(DAYS.map((d) => d.slice(0, 7)))];
const YEARS = [2019, 2023, 2024, 2025, 2026, 2027, 2099, 2100];

/* ── the old code, copied verbatim from before R-1609 ── */
const old = {
  commissionFyStartOf: (isoDate: string) => { const [y, m] = isoDate.slice(0, 10).split("-").map(Number); return `${m >= 4 ? y : y - 1}-04-01`; },
  depFyStartOf: (iso: string) => { const [y, m] = iso.slice(0, 7).split("-").map(Number); return m >= 4 ? y : y - 1; },
  label: (fy: number) => `${fy}-${String((fy + 1) % 100).padStart(2, "0")}`,
  ledgerFyOf: (isoDate: string) => { const [y, m] = isoDate.slice(0, 10).split("-").map(Number); return m >= 4 ? y : y - 1; },
  ledgerFyLabel: (startYear: number) => `FY ${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`,
  tdsPeriodKey: (period: string) => {
    const [y, m] = period.split("-").map(Number);
    const fy = m >= 4 ? y : y - 1;
    const q = m >= 4 && m <= 6 ? 1 : m >= 7 && m <= 9 ? 2 : m >= 10 ? 3 : 4;
    return `${fy}-q${q}`;
  },
  fyStartYearOf: (s: string) => { const [y, m] = s.split("-").map(Number); return m >= 4 ? y : y - 1; },
  fyCodeOf: (iso: string) => { const [y, m] = iso.split("-").map(Number); const s = m >= 4 ? y : y - 1; return `FY${String(s % 100).padStart(2, "0")}${String((s + 1) % 100).padStart(2, "0")}`; },
  fiscalYearFromDate: (dateStr: string) => {
    const d = new Date(dateStr + "T00:00:00Z"); const yr = d.getUTCFullYear(); const m = d.getUTCMonth();
    const fyStart = m < 3 ? yr - 1 : yr;
    return `FY${String(fyStart % 100).padStart(2, "0")}${String((fyStart + 1) % 100).padStart(2, "0")}`;
  },
  fyStartFor: (isoDate: string) => { const [y, m] = isoDate.split("-").map(Number); return `${m >= 4 ? y : y - 1}-04-01`; },
  itcDeadline: (billDate: string) => { const [y, m] = billDate.split("-").map(Number); return `${m >= 4 ? y + 1 : y}-11-30`; },
  utcShiftedFyStart: (d: Date) => { const y = d.getUTCFullYear(); return new Date(Date.UTC(d.getUTCMonth() >= 3 ? y : y - 1, 3, 1)); },
  quarterLabel: (period: string) => {
    const [y, m] = period.split("-").map(Number);
    const startMonth = m >= 4 && m <= 6 ? 4 : m >= 7 && m <= 9 ? 7 : m >= 10 ? 10 : 1;
    const qNum = startMonth === 4 ? 1 : startMonth === 7 ? 2 : startMonth === 10 ? 3 : 4;
    const fy = m >= 4 ? y : y - 1;
    return `Q${qNum} FY${fy}-${String((fy + 1) % 100).padStart(2, "0")}`;
  },
  fyEndYear: (now: Date) => { const ist = new Date(now.getTime() + 330 * 60_000); const y = ist.getUTCFullYear(); const end = ist.getUTCMonth() >= 3 ? y + 1 : y; return String(end % 100).padStart(2, "0"); },
  financialYear: (startYear: number) => {
    const two = (n: number) => String(n % 100).padStart(2, "0");
    return { label: `FY ${startYear}-${two(startYear + 1)}`, assessmentYear: `AY ${startYear + 1}-${two(startYear + 2)}`, fiscalKey: `FY${two(startYear)}${two(startYear + 1)}` };
  },
  currentFyStart: (now: Date) => {
    const ist = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
    const y = Number(ist.slice(0, 4)); return ist.slice(5, 7) < "04" ? y - 1 : y;
  },
};

describe("R-1609 FY helper — same outputs as the hand-written copies it replaced", () => {
  it("every day 2023–2028: start year, start ISO, codes and deadlines match", () => {
    for (const d of DAYS) {
      expect(commissionFyStartOf(d)).toBe(old.commissionFyStartOf(d));
      expect(depFyStartOf(d)).toBe(old.depFyStartOf(d));
      expect(fyOf(d)).toBe(old.ledgerFyOf(d));
      expect(fyStartYearOf(d)).toBe(old.fyStartYearOf(d));
      expect(fyCodeOf(d)).toBe(old.fyCodeOf(d));
      expect(fyCodeOfYear(fyStartYear(d))).toBe(old.fiscalYearFromDate(d)); // queries/tds-receivable.ts fiscalYearFromDate
      expect(fyStartFor(d)).toBe(old.fyStartFor(d));
      expect(fyStartISO(d)).toBe(old.fyStartFor(d)); // payments-made, data-entry route, payroll leave year
      expect(itcDeadline(d)).toBe(old.itcDeadline(d));
      // cash-flow / reports-purchases / profitability: an IST-shifted Date, read by its UTC calendar date
      const shifted = new Date(`${d}T20:00:00Z`);
      expect(new Date(Date.UTC(fyStartYear(shifted.toISOString().slice(0, 10)), 3, 1))).toEqual(old.utcShiftedFyStart(shifted));
      expect(fyBounds(d).start).toBe(`${old.fyStartYearOf(d)}-04-01`);
      expect(fyBounds(d).end).toBe(`${old.fyStartYearOf(d) + 1}-03-31`);
    }
  });

  it("every YYYY-MM period: payroll, month-close TDS key and the salary-register quarter label match", () => {
    for (const p of PERIODS) {
      expect(fyStartOfPeriod(p)).toBe(old.fyStartYearOf(p));
      expect(fyStartYearOf(p)).toBe(old.fyStartYearOf(p));
      expect(compliancePeriodKey("tds_return_filed", p)).toBe(old.tdsPeriodKey(p));
      expect(compliancePeriodKey("gstr3b_filed", p)).toBe(p);
      const [, m] = p.split("-").map(Number);
      const qNum = m >= 4 && m <= 6 ? 1 : m >= 7 && m <= 9 ? 2 : m >= 10 ? 3 : 4;
      expect(`Q${qNum} FY${fyLabelOfYear(fyStartYear(p))}`).toBe(old.quarterLabel(p));
    }
  });

  it("labels: one '2026-27' format; ledger/ITR keep their 'FY ' prefix as thin aliases", () => {
    for (const y of YEARS) {
      expect(fyLabelOfYear(y)).toBe(old.label(y));
      expect(depFyLabel(y)).toBe(old.label(y));
      expect(taxFyLabel(y)).toBe(old.label(y));
      expect(fyLabelOf(y)).toBe(old.label(y));
      expect(ledgerFyLabel(y)).toBe(old.ledgerFyLabel(y));
      const fy = financialYear(y), o = old.financialYear(y);
      expect([fy.label, fy.assessmentYear, fy.fiscalKey]).toEqual([o.label, o.assessmentYear, o.fiscalKey]);
    }
    expect(fyLabelOfYear(2026)).toBe("2026-27");
    expect(fyLabelOfYear(2099)).toBe("2099-00");
    expect(fyCodeOfYear(2026)).toBe("FY2627");
    expect(fyLabel("2026-03-31")).toBe("2025-26");
  });

  it("instants around the IST midnight of 31 Mar / 1 Apr: invoice-code and ITR 'current FY' match", () => {
    for (const at of ["2026-03-31T18:29:59Z", "2026-03-31T18:30:00Z", "2026-03-31T23:59:00Z", "2026-04-01T00:00:00Z", "2027-01-01T00:00:00Z", "2026-12-31T18:30:00Z"]) {
      const d = new Date(at);
      expect(fyEndYear(d)).toBe(old.fyEndYear(d));
      expect(currentFinancialYear(d).startYear).toBe(old.currentFyStart(d));
    }
  });

  it("vault/personal: FY start is read in IST, not the browser clock (the one intended change)", () => {
    // 31 Mar 2026 19:00 UTC = 1 Apr 2026 00:30 IST — a UTC/US laptop used to say FY 2025.
    expect(fyStartISO(new Date("2026-03-31T19:00:00Z"))).toBe("2026-04-01");
    expect(fyStartISO(new Date("2026-03-31T18:00:00Z"))).toBe("2025-04-01");
    for (const rel of ["../../app/(app)/vault/personal/page.tsx", "../../app/(app)/vault/personal/expenses/page.tsx"]) {
      const src = fs.readFileSync(path.join(__dirname, rel), "utf8");
      expect(src).toContain("fyStartISO(");
      expect(src).not.toMatch(/getMonth\(\)\s*>=\s*3/);
    }
  });
});
