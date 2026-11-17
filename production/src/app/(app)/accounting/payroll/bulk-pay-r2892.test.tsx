// @vitest-environment jsdom
/* R-2892 — Run payroll: tick employees, "Pay selected", confirm list with every net and the total,
   then one booking each through the SAME usePaySalary mutation. September 2026 (today = 5 Oct 2026):
   Asha 30,000 with 2 absences, Sam 20,000 full attendance, Meena already run, Ravi has no salary set. */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const payCalls: Record<string, unknown>[] = [];
let failFor: string | null = null;
let alreadyRunNow: string[] = ["emp-meena"];
let role = "owner";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), useSearchParams: () => new URLSearchParams("") }));
vi.mock("@/lib/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ data: { role } }) }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("@/lib/queries/bank", () => ({
  useBankAccounts: () => ({ data: [
    { id: "acct-cash", name: "Petty Cash", is_active: true, account_type: "cash" },
    { id: "acct-hdfc", name: "HDFC Current", is_active: true, account_type: "current" },
  ] }),
}));
vi.mock("@/components/providers/confirm-provider", () => ({ useConfirm: () => vi.fn(async () => true) }));
vi.mock("@/lib/queries/employee-loans", () => ({ useEmployeeLoans: () => ({ data: [] }) }));
vi.mock("@/lib/queries/attendance-shift", () => ({ useShiftRules: () => ({ data: undefined }) }));

const mk = (id: string, name: string, gross: number) => ({
  id, name, monthly_gross: gross, basic_monthly: gross / 2, da_monthly: 0, is_active: true, pf_applicable: true, pf_full_wage: false,
  esi_applicable: false, joining_date: "2026-01-01", exit_date: null,
});
const employees = [mk("emp-asha", "asha rani", 30000), mk("emp-sam", "sam kumar", 20000), mk("emp-meena", "meena devi", 25000), mk("emp-ravi", "ravi singh", 0)];
const workingDays = Array.from({ length: 30 }, (_, i) => `2026-09-${String(i + 1).padStart(2, "0")}`)
  .filter((d) => new Date(`${d}T00:00:00Z`).getUTCDay() !== 0);
const attendance = employees.flatMap((e) => workingDays
  .filter((d) => !(e.id === "emp-asha" && (d === "2026-09-03" || d === "2026-09-04")))
  .map((d) => ({ employee_id: e.id, work_date: d, check_in: `${d}T04:00:00Z`, check_out: null })));
const meenaRow = {
  id: "sal-meena", employee_id: "emp-meena", period: "2026-09", pay_date: "2026-09-30", gross: 25000, lop_days: 0, lop_amount: 0, incentive: 0,
  arrears: 0, advance_recovered: 0, advance_loan_id: null, tds: 0, pf: 1500, esi: 0, pf_employer: 1500, esi_employer: 0, pf_wage: 12500,
  other_deduction: 0, bank_account_id: "acct-hdfc", net: 23500, paid_amount: 0, paid_status: "unpaid", salary_in_force: 25000, notes: null,
};

vi.mock("@/lib/queries/payroll", async (orig) => ({
  ...(await orig<typeof import("@/lib/queries/payroll")>()),
  useEmployees: () => ({ data: employees, isLoading: false }),
  useSalaryPayments: () => ({ data: [meenaRow], isLoading: false }),
  useSalaryRevisions: () => ({ data: [], isSuccess: true, isError: false }),
  useAttendance: () => ({ data: attendance, isSuccess: true }),
  useLeaveEntries: () => ({ data: [], isSuccess: true }),
  useHolidays: () => ({ data: [], isSuccess: true }),
  useUnlinkedSalaryBankLines: () => ({ data: new Map() }),
  useSalaryArrears: () => ({ data: null }),
  useEmployeeSalaryHistory: () => ({ data: [] }),
  fetchEmployeeSalaryHistory: async () => [],
  fetchSalaryArrears: async () => ({ due: 0, paid: 0, outstanding: 0, overpaid: 0, months: [], monthsLabel: "", lastMonth: null }),
  fetchRunEmployeeIds: async () => new Set(alreadyRunNow),
  usePaySalary: () => ({
    isPending: false,
    mutateAsync: async (input: Record<string, unknown>) => {
      if (failFor === input.employeeId) throw new Error("Books are locked for September");
      payCalls.push(input);
      alreadyRunNow = [...alreadyRunNow, input.employeeId as string];
    },
  }),
}));

import { PayrollTab, PaySalaryDialog } from "./screens";
import { buildSalaryDraft, lopSuggestionForMonth } from "@/lib/payroll/salary-draft";

const renderTab = () => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><PayrollTab /></QueryClientProvider>,
);

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-05T06:00:00Z")); });
afterEach(() => {
  cleanup(); vi.useRealTimers(); payCalls.length = 0; failFor = null; alreadyRunNow = ["emp-meena"]; role = "owner";
});

/* The table and the phone cards both render in jsdom (no CSS) — the first box is the table's. */
const findBox = async (n: string) => (await screen.findAllByLabelText(`Select ${n}`))[0];
const getBox = (n: string) => screen.getAllByLabelText(`Select ${n}`)[0];
const queryBox = (n: string) => screen.queryAllByLabelText(`Select ${n}`)[0] ?? null;
const rupeeText = (n: number) => `₹${n.toLocaleString("en-IN")}`;
const draftFor = (id: string) => {
  const e = employees.find((x) => x.id === id)!;
  const lop = lopSuggestionForMonth({ period: "2026-09", employee: e, todayIso: "2026-10-05", companyHolidays: [], attendance, leaves: [] });
  return buildSalaryDraft({ employee: e as never, period: "2026-09", todayIso: "2026-10-05", revisions: [], history: [], arrears: null, lop });
};

describe("R-2892 Run payroll: tick and Pay selected", () => {
  it("the register's draft net equals what the Pay salary form shows after Apply LOP (same figures)", async () => {
    const e = employees[0] as never;
    render(<QueryClientProvider client={new QueryClient()}><PaySalaryDialog employee={e} period="2026-09" revisions={[]} onClose={vi.fn()} /></QueryClientProvider>);
    fireEvent.click(await screen.findByRole("button", { name: /^Apply 2d LOP from attendance$/ }));
    const net = draftFor("emp-asha").net;
    expect(net).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: `Pay ${rupeeText(net)}` })).toBeTruthy();
  });

  it("only unpaid people have a checkbox; Select all ticks them; Pay selected shows the count", async () => {
    renderTab();
    expect(await findBox("Asha Rani")).toBeTruthy();
    expect(queryBox("Meena Devi")).toBeNull(); // already run
    const pay = screen.getByRole("button", { name: /^Pay selected/ }) as HTMLButtonElement;
    expect(pay.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText("Select all"));
    expect((getBox("Ravi Singh") as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole("button", { name: "Pay selected (3)" })).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Select all"));
    expect((screen.getByRole("button", { name: /^Pay selected/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("confirm lists each net and the total, skips the person with no salary and says why", async () => {
    renderTab();
    fireEvent.click(await screen.findByLabelText("Select all"));
    fireEvent.click(screen.getByRole("button", { name: "Pay selected (3)" }));
    const asha = draftFor("emp-asha"), sam = draftFor("emp-sam");
    expect(asha.lopDays).toBe(2);
    await waitFor(() => expect(screen.getByTestId("bulk-total").textContent).toContain(rupeeText(asha.net + sam.net)));
    expect(screen.getByTestId("bulk-total").textContent).toContain("2 salaries to book");
    expect(within(screen.getByTestId("bulk-row-emp-asha")).getByText(rupeeText(asha.net))).toBeTruthy();
    expect(within(screen.getByTestId("bulk-row-emp-ravi")).getByText(/Skipped — No monthly salary set/)).toBeTruthy();
    expect(payCalls).toEqual([]); // nothing is booked before the confirm
  });

  it("Pay books each person with the exact Pay salary input, in order; bank and date as chosen", async () => {
    renderTab();
    fireEvent.click(await findBox("Asha Rani"));
    fireEvent.click(getBox("Sam Kumar"));
    fireEvent.click(screen.getByRole("button", { name: "Pay selected (2)" }));
    const total = draftFor("emp-asha").net + draftFor("emp-sam").net;
    const go = await screen.findByRole("button", { name: `Pay 2 · ${rupeeText(total)}` });
    fireEvent.change(document.getElementById("bulk-pay-date")!, { target: { value: "2026-09-30" } });
    fireEvent.click(go);
    await waitFor(() => expect(screen.getByTestId("bulk-result").textContent).toContain("2 booked"));
    expect(payCalls.map((c) => c.employeeId)).toEqual(["emp-asha", "emp-sam"]);
    const a = draftFor("emp-asha");
    expect(payCalls[0]).toEqual({
      employeeId: "emp-asha", period: "2026-09", payDate: "2026-09-30", gross: 30000, lopDays: 2, lopAmount: 2000, incentive: 0,
      advanceRecovered: 0, advanceLoanId: null, tds: a.tds, pf: a.pf, esi: a.esi, esiEmployer: a.esiEmployer, pfEmployer: a.pfEmployer,
      other: 0, bankAccountId: "acct-hdfc", pfWage: a.pfWage, arrears: 0,
    });
  });

  it("a failure stops cleanly: shows who was booked and who was not; nobody after it is touched", async () => {
    failFor = "emp-sam";
    renderTab();
    fireEvent.click(await findBox("Asha Rani"));
    fireEvent.click(getBox("Sam Kumar"));
    fireEvent.click(screen.getByRole("button", { name: "Pay selected (2)" }));
    fireEvent.click(await screen.findByRole("button", { name: /^Pay 2 · / }));
    const res = await screen.findByTestId("bulk-result");
    expect(res.textContent).toContain("1 booked");
    expect(res.textContent).toContain("Stopped at Sam Kumar: Books are locked for September");
    expect(screen.getByTestId("bulk-outcome-emp-asha").textContent).toBe("Paid");
    expect(screen.getByTestId("bulk-outcome-emp-sam").textContent).toBe("Failed");
    expect(payCalls.map((c) => c.employeeId)).toEqual(["emp-asha"]);
  });

  it("retry after a stop does not pay Asha twice", async () => {
    failFor = "emp-sam";
    renderTab();
    fireEvent.click(await findBox("Asha Rani"));
    fireEvent.click(getBox("Sam Kumar"));
    fireEvent.click(screen.getByRole("button", { name: "Pay selected (2)" }));
    fireEvent.click(await screen.findByRole("button", { name: /^Pay 2 · / }));
    await screen.findByTestId("bulk-result");
    failFor = null;
    fireEvent.click(screen.getByRole("button", { name: "Retry the rest" }));
    await waitFor(() => expect(payCalls.map((c) => c.employeeId)).toEqual(["emp-asha", "emp-sam"]));
    expect(payCalls.filter((c) => c.employeeId === "emp-asha")).toHaveLength(1);
  });

  it("a person paid in another tab meanwhile is left out at the moment of paying", async () => {
    renderTab();
    fireEvent.click(await findBox("Asha Rani"));
    fireEvent.click(getBox("Sam Kumar"));
    fireEvent.click(screen.getByRole("button", { name: "Pay selected (2)" }));
    const go = await screen.findByRole("button", { name: /^Pay 2 · / });
    alreadyRunNow = ["emp-meena", "emp-asha"]; // booked elsewhere after the list was built
    fireEvent.click(go);
    await waitFor(() => expect(screen.getByTestId("bulk-result").textContent).toContain("1 already run"));
    expect(payCalls.map((c) => c.employeeId)).toEqual(["emp-sam"]);
  });

  it("a view-only role sees no checkboxes and no Pay selected", async () => {
    role = "viewer";
    renderTab();
    await screen.findAllByText("Asha Rani");
    expect(queryBox("Asha Rani")).toBeNull();
    expect(screen.queryByRole("button", { name: /Pay selected/ })).toBeNull();
  });
});
