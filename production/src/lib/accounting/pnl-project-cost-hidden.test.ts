/**
 * R-1649 — a role that cannot read salaries must not see a wrong gross margin.
 *
 * `employees` is readable by owner / manager / accountant only (R-1001). The billing role opens
 * the P&L too (nav.ts), reads `project_labour` (who worked on which project) but gets NO
 * employee rows — so every allocation's monthly_gross came back as 0, the project delivery cost
 * printed ₹0 and the gross margin was overstated by the whole project salary.
 *
 * Rule (decided on the card): the salary stays hidden from those roles (R-1001), so the project
 * delivery cost and the gross margin are HIDDEN for them — never ₹0. Net profit does not depend
 * on it (project cost is moved out of operating expenses, never added), so it is still shown.
 */
import { describe, it, expect } from "vitest";
import { assemblePnl, reportProfit, type PnlRpcRow, type PnlMasters } from "./pnl-assemble";
import { projectCostForPeriod, type LabourAllocation } from "./project-cost";
import { pnlWaterfall } from "./waterfall";

const range = { from: "2026-09-01", to: "2026-09-30" };
const allocations: LabourAllocation[] = [
  { project_id: "p1", employee_id: "e1", percent: 50, months: 6, start_date: "2026-07-01", end_date: null },
];
const row: PnlRpcRow = {
  inv_taxable: 200_000, inv_tax: 36_000, revenue_count: 2, cn_taxable: 0, cn_tax: 0, dn_taxable: 0, dn_tax: 0,
  revenue_by_project: [{ project_id: "p1", revenue: 200_000 }], cogs: 0, cogs_count: 0, bills_gst: 0,
  expense_groups: [{ category: "Salaries", vendor_name: null, month: "2026-09", amount: 120_000, n: 2 }],
  itc_groups: [], bill_itc_groups: [], cogs_by_category: [],
  unassigned_by_category: [{ category: "Salaries", amount: 120_000 }], project_expenses: [],
  commissions: 0, commissions_count: 0,
};
const base: Omit<PnlMasters, "monthlyGross" | "employeeNames"> = {
  vendors: [], allocations, projects: [{ id: "p1", title: "ERP build", customer_name: "Acme", start_date: "2026-07-01" }],
};
const owner: PnlMasters = { ...base, monthlyGross: new Map([["e1", 80_000]]), employeeNames: new Map([["e1", "Ranjeet"]]) };
/* What the billing role reads: the allocation, but no employee row (RLS). */
const billing: PnlMasters = { ...base, monthlyGross: new Map(), employeeNames: new Map() };

describe("R-1649: project delivery cost for a role that cannot read salaries", () => {
  it("project-cost.ts counts the allocations whose salary it could not read", () => {
    const r = projectCostForPeriod({ ...range, allocations, monthlyGross: new Map(), projects: base.projects, expenses: [] });
    expect(r.salaryHidden).toBe(1);
    const o = projectCostForPeriod({ ...range, allocations, monthlyGross: owner.monthlyGross, projects: base.projects, expenses: [] });
    expect(o.salaryHidden).toBe(0);
  });

  it("an allocation outside the period does not hide anything", () => {
    const r = projectCostForPeriod({ from: "2027-06-01", to: "2027-06-30", allocations, monthlyGross: new Map(), projects: base.projects, expenses: [] });
    expect(r.salaryHidden).toBe(0);
  });

  it("billing: gross margin is hidden (null), never the revenue with a ₹0 project cost", () => {
    const p = assemblePnl(range, row, billing);
    expect(p.model.projectCostHidden).toBe(true);
    expect(p.model.grossMargin).toBeNull();
    expect(p.model.grossMarginPct).toBeNull();
    expect(p.model.projectCost).toBe(0);
    /* No chart that implies every step is known. */
    expect(pnlWaterfall(p.model)).toBeNull();
  });

  it("billing and owner see the SAME net profit", () => {
    const b = assemblePnl(range, row, billing);
    const o = assemblePnl(range, row, owner);
    expect(o.model.projectCostHidden).toBe(false);
    expect(o.model.projectCost).toBeGreaterThan(0);
    expect(b.model.netProfit).toBe(o.model.netProfit);
    expect(reportProfit(b)).toBe(reportProfit(o));
    expect(reportProfit(b)).toBe(200_000 - 120_000);
  });

  it("owner: gross margin = revenue − project salary", () => {
    const o = assemblePnl(range, row, owner);
    expect(o.model.grossMargin).toBe(200_000 - o.model.projectCost);
  });
});
