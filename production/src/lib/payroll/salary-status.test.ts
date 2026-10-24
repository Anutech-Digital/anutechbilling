/**
 * R-1831 — salary status from facts. Staging 24 Oct: 13 September salaries the bank showed
 * as never paid read "Awaiting reconcile". The status now says what the books know.
 */
import { describe, it, expect } from "vitest";
import { salaryPayState, type SalaryPayKey } from "./salary-status";

type Row = {
  name: string;
  net: number; paid_amount: number; paid_status: string; bankLineWaiting: boolean;
  key: SalaryPayKey; label: string;
};

const ROWS: Row[] = [
  { name: "booked, nothing in the bank (staging Sep salaries)", net: 30000, paid_amount: 0, paid_status: "unpaid", bankLineWaiting: false, key: "not_paid", label: "Not paid yet" },
  { name: "booked, bank has an unlinked line of that net", net: 30000, paid_amount: 0, paid_status: "unpaid", bankLineWaiting: true, key: "link_bank", label: "Paid — link bank line" },
  { name: "linked in full (Pardeep ₹2,00,000 on 23 Oct)", net: 200000, paid_amount: 200000, paid_status: "paid", bankLineWaiting: false, key: "paid", label: "Paid" },
  { name: "linked in full — a waiting line does not change it", net: 200000, paid_amount: 200000, paid_status: "paid", bankLineWaiting: true, key: "paid", label: "Paid" },
  { name: "part linked", net: 30000, paid_amount: 10000, paid_status: "partial", bankLineWaiting: false, key: "partial", label: "Partial" },
  { name: "part linked + another line waiting stays Partial", net: 30000, paid_amount: 10000, paid_status: "partial", bankLineWaiting: true, key: "partial", label: "Partial" },
  { name: "paid_amount covers net even if status lags", net: 30000, paid_amount: 30000, paid_status: "unpaid", bankLineWaiting: false, key: "paid", label: "Paid" },
];

describe("R-1831 — salaryPayState", () => {
  it.each(ROWS)("$name → $label", (r) => {
    const s = salaryPayState(r, r.bankLineWaiting);
    expect(s.key).toBe(r.key);
    expect(s.label).toBe(r.label);
  });

  it("never says 'Awaiting reconcile' — that read as 'money went out' when it had not", () => {
    for (const r of ROWS) expect(salaryPayState(r, r.bankLineWaiting).label).not.toMatch(/awaiting/i);
  });

  it("hints say the next step in plain words", () => {
    expect(salaryPayState({ net: 30000, paid_amount: 0, paid_status: "unpaid" }).hint).toMatch(/no payment for it is in the imported bank statement/);
    expect(salaryPayState({ net: 30000, paid_amount: 0, paid_status: "unpaid" }, true).hint).toMatch(/Link it/);
    expect(salaryPayState({ net: 30000, paid_amount: 10000, paid_status: "partial" }).hint).toMatch(/still to pay/);
  });
});
