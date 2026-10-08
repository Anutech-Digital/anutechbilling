/**
 * Month-end close — the list, in the order a small company actually closes a month.
 *
 * Every step is one of:
 *   auto   — read from the books; nobody ticks it, the books do (bank reconciled,
 *            salaries run, challans booked, GST paid, books locked)
 *   manual — happened on a government portal; the owner ticks it and the tick is
 *            stored (GSTR-1 filed, 24Q/26Q filed)
 *
 * `evaluateMonthClose` turns the month's facts into the list with a status per step
 * and an overall "ready to lock" — locking the books is the last step, and the page
 * refuses to offer it while an earlier step is red.
 */

import { utcDateISO } from "@/lib/dates/ist";
import { formatDate } from "@/lib/utils";

export type StepKind = "auto" | "manual";
export type StepStatus = "done" | "todo" | "na" | "warn";

export interface CloseStep {
  key: string;
  kind: StepKind;
  title: string;
  detail: string;                 // Hinglish, one line: what is wrong / what it found
  status: StepStatus;
  href?: string;                  // where to fix it
  /** manual steps: when / who */
  doneAt?: string | null;
}

export interface MonthCloseFacts {
  period: string;                 // YYYY-MM
  monthEnd: string;               // YYYY-MM-DD
  today: string;                  // YYYY-MM-DD
  unreconciledBankLines: number;  // imported, unmatched, dated in the month (all accounts)
  bankAccounts: number;
  activeEmployees: number;
  salariesRun: number;            // salary_payments rows for the period
  salariesUnpaid: number;         // of those, paid_status <> 'paid'
  withheld: { tds: number; pf: number; esi: number };   // this month's salary deductions + vendor TDS
  challans: { tds: boolean; pf: boolean; esi: boolean; mixed: boolean };  // statutory_dues_payments with period = month
  outputGst: number;              // GST on the month's invoices (net of notes)
  gstPaid: boolean;               // tax_payments kind=gst period=month exists
  draftInvoices: number;          // still draft, dated on/before month end
  blockedItcCount: number;        // expenses this month whose GST is not credit
  booksLockedUntil: string | null;
  manual: Record<string, { done_at: string; done_by: string | null; via?: "calendar" } | undefined>;
}

/** Each portal step also has a row on the Compliance Calendar (lib/compliance/obligations.ts);
 *  marking it filed there counts here too — `complianceKey` + the calendar's period key. */
export const MANUAL_STEPS: { key: string; title: string; detail: string; href?: string; quarterly?: boolean; complianceKey: string }[] = [
  { key: "gstr1_filed", title: "GSTR-1 filed", detail: "Make the JSON on the GST page, upload it on the portal and file with OTP, by the 11th.", href: "/accounting/gst", complianceKey: "gst_gstr1" },
  { key: "gstr3b_filed", title: "GSTR-3B filed", detail: "Fill the boxes from the GST page worksheet, pay the tax (the challan shows up above on its own) and file, by the 20th.", href: "/accounting/gst", complianceKey: "gst_gstr3b" },
  { key: "tds_return_filed", title: "TDS return (24Q / 26Q) filed", detail: "In the last month of the quarter: Salary Register → 24Q working, Expenses → 26Q working, file through your CA or RPU.", href: "/accounting/salary-register", quarterly: true, complianceKey: "tds_return" },
];

/** The Compliance Calendar's period key for a step in a month: monthly GST = YYYY-MM; the
 *  TDS return = "<fyStart>-q<n>" for the quarter the month closes. */
export function compliancePeriodKey(stepKey: string, period: string): string {
  if (stepKey !== "tds_return_filed") return period;
  const [y, m] = period.split("-").map(Number);
  const fy = m >= 4 ? y : y - 1;
  const q = m >= 4 && m <= 6 ? 1 : m >= 7 && m <= 9 ? 2 : m >= 10 ? 3 : 4;
  return `${fy}-q${q}`;
}

const inr = (n: number) => "₹" + Math.round(n).toLocaleString("en-IN");

/** Last month of a TDS quarter (Jun, Sep, Dec, Mar). */
export function isQuarterEnd(period: string): boolean {
  const m = Number(period.slice(5, 7));
  return m === 6 || m === 9 || m === 12 || m === 3;
}

export function monthEndOf(period: string): string {
  const [y, m] = period.split("-").map(Number);
  return utcDateISO(new Date(Date.UTC(y, m, 0)));
}

export interface MonthClose {
  steps: CloseStep[];
  done: number;
  total: number;                  // steps that are not "na"
  readyToLock: boolean;
  locked: boolean;
}

export function evaluateMonthClose(f: MonthCloseFacts): MonthClose {
  const steps: CloseStep[] = [];
  const monthOver = f.today > f.monthEnd;

  // 1. Bank
  steps.push({
    key: "bank", kind: "auto", title: "Bank reconcile",
    status: f.bankAccounts === 0 ? "na" : f.unreconciledBankLines === 0 ? "done" : "todo",
    detail: f.bankAccounts === 0 ? "No bank account." : f.unreconciledBankLines === 0
      ? "Every bank line imported this month is matched to an entry."
      : `${f.unreconciledBankLines} bank line(s) still unmatched. Book or reconcile each one, then check the BRS.`,
    href: "/accounting/banking/brs",
  });

  // 2. Salaries
  const salStatus: StepStatus = f.activeEmployees === 0 ? "na"
    : f.salariesRun >= f.activeEmployees ? (f.salariesUnpaid > 0 ? "warn" : "done")
    : monthOver ? "todo" : "warn";
  steps.push({
    key: "salaries", kind: "auto", title: "Payroll run",
    status: salStatus,
    detail: f.activeEmployees === 0 ? "No employees."
      : `Salary run for ${f.salariesRun} of ${f.activeEmployees} employees this month` + (f.salariesUnpaid > 0 ? `; ${f.salariesUnpaid} not yet paid from the bank.` : "."),
    href: "/accounting/payroll",
  });

  // 3. Statutory challans — due by the 7th (TDS) / 15th (PF, ESI) of next month
  const needTds = f.withheld.tds > 0, needPf = f.withheld.pf > 0, needEsi = f.withheld.esi > 0;
  const anyNeed = needTds || needPf || needEsi;
  const covered = (need: boolean, paid: boolean) => !need || paid || f.challans.mixed;
  const allPaid = covered(needTds, f.challans.tds) && covered(needPf, f.challans.pf) && covered(needEsi, f.challans.esi);
  const missing = [needTds && !covered(needTds, f.challans.tds) ? `TDS ${inr(f.withheld.tds)}` : null,
                   needPf && !covered(needPf, f.challans.pf) ? `PF ${inr(f.withheld.pf)}` : null,
                   needEsi && !covered(needEsi, f.challans.esi) ? `ESI ${inr(f.withheld.esi)}` : null].filter(Boolean);
  steps.push({
    key: "statutory", kind: "auto", title: "TDS / PF / ESI challan",
    status: !anyNeed ? "na" : allPaid ? "done" : "todo",
    detail: !anyNeed ? "Nothing withheld this month."
      : allPaid ? "This month's challans are booked (Payroll → Record statutory payment, or a bank line)."
      : `Due: ${missing.join(", ")}. Pay the challan and book it with the month and challan no. (TDS by the 7th, PF/ESI by the 15th).`,
    href: "/accounting/payroll",
  });

  // 4. GST paid
  steps.push({
    key: "gst_paid", kind: "auto", title: "GST (3B) tax paid",
    status: f.outputGst <= 0 ? "na" : f.gstPaid ? "done" : "todo",
    detail: f.outputGst <= 0 ? "No output GST this month." : f.gstPaid
      ? "This month's GST challan is booked from a bank line."
      : `Output GST ${inr(f.outputGst)} (before ITC). Pay it by the 20th and book the bank line as "GST".`,
    href: "/accounting/gst",
  });

  // 5. Drafts
  steps.push({
    key: "drafts", kind: "auto", title: "No draft invoices",
    status: f.draftInvoices === 0 ? "done" : "warn",
    detail: f.draftInvoices === 0 ? "All invoices are issued." : `${f.draftInvoices} draft invoice(s) dated up to month end. Issue or delete them; drafts do not go into GSTR-1.`,
    href: "/invoices",
  });

  // 6. ITC hygiene (info)
  steps.push({
    key: "itc", kind: "auto", title: "ITC on expenses is clean",
    status: f.blockedItcCount === 0 ? "done" : "warn",
    detail: f.blockedItcCount === 0 ? "Every expense with GST has a bill and a vendor GSTIN."
      : `${f.blockedItcCount} expense(s) give no GST credit (no proper bill, no vendor GSTIN, or s.17(5)). Fix them now if you can; otherwise the GST stays a cost.`,
    href: "/accounting/expenses",
  });

  // 7–9. Manual portal steps
  for (const m of MANUAL_STEPS) {
    if (m.quarterly && !isQuarterEnd(f.period)) continue;
    const rec = f.manual[m.key];
    steps.push({ key: m.key, kind: "manual", title: m.title, detail: m.detail + (rec?.via === "calendar" ? " (Marked filed on the Compliance Calendar.)" : ""), status: rec ? "done" : "todo", href: m.href, doneAt: rec?.done_at ?? null });
  }

  // 10. Lock
  const locked = !!f.booksLockedUntil && f.booksLockedUntil >= f.monthEnd;
  const blocking = steps.filter((s) => s.status === "todo").length;
  steps.push({
    key: "lock", kind: "auto", title: "Books lock",
    status: locked ? "done" : "todo",
    detail: locked ? `Books are locked up to ${formatDate(f.booksLockedUntil)}. This month is closed.` : blocking > 0 ? `${blocking} step(s) left. Finish them, then lock.` : "All done. Lock the books up to month end so no entry can change.",
    href: "/accounting",
  });

  const counted = steps.filter((s) => s.status !== "na");
  return {
    steps,
    done: counted.filter((s) => s.status === "done").length,
    total: counted.length,
    readyToLock: !locked && blocking === 0,
    locked,
  };
}
